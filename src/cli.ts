#!/usr/bin/env -S npx tsx
/**
 * mtg-bench CLI
 *   cards index --forge-res <dir>         build data/cards.json from Forge card scripts
 *   cubes --forge-res <dir>               list cubes bundled with Forge and their sizes
 *   check <config.yaml> [--ping]          validate config, keys, card data, cube, engine, rules file
 *   run <config.yaml> [--engine mock|forge] [--pods N] [--run-id ID] [--force] [--forge-res DIR]
 *       [--decks-from RUNDIR | --pools-from RUNDIR] [--allow-seat-changes]   replay a saved run's seating + decks (matches only) or drafted pools (deckbuild + matches)
 *   match <config.yaml> --seats A,B --decks a.dck,b.dck [--matches N] [--parallel N] [--run-id ID] [--force]   head-to-head with fixed decks, no draft
 *   report <runDir...> [--allow-same-seed] [--allow-anchor-changes]   (re)build report.md for one run, or a merged report for several
 *   rate <runDir...> [--level game|match] [--anchor seat=1500] [--allow-same-seed] [--allow-anchor-changes]
 */
import fs from "node:fs";
import path from "node:path";
import { anchorDifferences, renderReport, sharedDrafts, summarize } from "./analytics/report.ts";
import { AnthropicProvider } from "./agents/providers/anthropic.ts";
import { OpenAIProvider } from "./agents/providers/openai.ts";
import { checkSeatSpec } from "./agents/llm.ts";
import { promptFile } from "./agents/render.ts";
import { buildIndex, loadDb, saveIndex } from "./cards/db.ts";
import { loadCube, parseCardList } from "./cards/cube.ts";
import { loadConfig, missingKeys } from "./config.ts";
import { ForgeEngine, resolveForge } from "./engine/forge/forge.ts";
import { MockEngine } from "./engine/mock/mock.ts";
import { SUBMIT_TOOL } from "./knowledge/tools.ts";
import { loadRules } from "./knowledge/rules.ts";
import { rate } from "./rating/bt.ts";
import { outcomesFromMatches, readMatches } from "./rating/outcomes.ts";
import { runHeadToHead } from "./tournament/match.ts";
import { runEvent } from "./tournament/run.ts";
import { info, loadDotEnv, setVerbose } from "./util/log.ts";

loadDotEnv();

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const BOOL_FLAGS = ["--ping", "--verbose", "--force", "--allow-seat-changes", "--allow-same-seed", "--allow-anchor-changes"];
const positional = (args: string[]) => args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && !BOOL_FLAGS.includes(args[i - 1])));

/**
 * report / rate pool runs as independent replicates on one rating scale: refuse runs that drafted the same packs unless
 * --allow-same-seed, and runs whose bot anchors or cube differ unless --allow-anchor-changes.
 */
function checkPoolable(dirs: string[], args: string[]) {
  const shared = sharedDrafts(dirs);
  if (shared.length && !args.includes("--allow-same-seed")) {
    throw new Error(`these runs drafted the same packs, so they aren't independent replicates:\n  ${shared.join("\n  ")}\n`
      + "give each event its own seed, or pass --allow-same-seed to pool them anyway");
  }
  const anchors = anchorDifferences(dirs);
  if (anchors.length && !args.includes("--allow-anchor-changes")) {
    throw new Error(`these runs' anchors differ (bot version or cube), so their ratings aren't on one scale:\n  ${anchors.join("\n  ")}\n`
      + "report them separately, or pass --allow-anchor-changes to pool them anyway");
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (args.includes("--verbose")) setVerbose(true);
  switch (cmd) {
    case "cards": {
      if (args[0] !== "index") throw new Error("usage: cards index --forge-res <forge>/res");
      const res = flag(args, "forge-res");
      if (!res) throw new Error("--forge-res is required");
      const cards = buildIndex(res);
      saveIndex(cards);
      info(`indexed ${cards.length} cards → data/cards.json`);
      return;
    }
    case "cubes": {
      const res = flag(args, "forge-res");
      if (!res) throw new Error("--forge-res is required");
      for (const f of fs.readdirSync(path.join(res, "cube")).filter((f) => f.endsWith(".dck")).sort()) {
        const n = parseCardList(fs.readFileSync(path.join(res, "cube", f), "utf8")).cards.length;
        console.log(`${String(n).padStart(5)}  ${f.replace(/\.dck$/, "")}`);
      }
      return;
    }
    case "check": {
      const cfg = loadConfig(positional(args)[0]);
      if (flag(args, "forge-res")) cfg.forgeRes = path.resolve(flag(args, "forge-res")!);
      const problems: string[] = [];
      const ok = (s: string) => console.log(`  ✓ ${s}`);
      console.log("Config"); ok(`${cfg.seats.length} seats: ${cfg.seats.map((s) => `${s.id} (${s.provider}${s.model ? `:${s.model}` : ""})`).join(", ")}`);
      problems.push(...missingKeys(cfg));
      console.log("Card data");
      let db;
      try { db = loadDb(); ok(`${db.size} card names indexed`); } catch (e: any) { problems.push(e.message); }
      if (db) {
        try {
          const cube = loadCube(db, cfg.event.cube, cfg.forgeRes);
          const need = 8 * cfg.event.packs * cfg.event.packSize;
          ok(`cube: ${cube.cards.length} cards (${need} needed per pod)`);
          if (cube.cards.length < need) problems.push(`cube too small: ${cube.cards.length} < ${need}`);
          if (cube.missing.length) problems.push(`${cube.missing.length} cube card(s) not found in the card DB: ${cube.missing.slice(0, 5).join(", ")}`);
        } catch (e: any) { problems.push(e.message); }
      }
      console.log("Knowledge");
      const rules = loadRules();
      if (rules) ok(`Comprehensive Rules loaded (${rules.size} entries)`);
      else if (cfg.event.knowledge.startsWith("oracle+tools")) problems.push("data/MagicCompRules.txt missing: search_rules will answer 'not available' (see data/README.md)");
      for (const f of ["system.md", "draft.md", "deckbuild.md", "game.md", `knowledge-${cfg.event.knowledge}.md`]) {
        if (!fs.existsSync(promptFile(cfg.event.promptVersion, f))) problems.push(`prompt file prompts/${cfg.event.promptVersion}/${f} missing`);
      }
      console.log("Engine");
      if (cfg.engine.type === "forge") {
        const r = resolveForge(cfg.engine);
        if (r.forgeJar && fs.existsSync(r.forgeJar)) ok(`Forge jar: ${r.forgeJar}`); else problems.push(`Forge jar not found under ${r.forgeDir}`);
        if (fs.existsSync(r.bridgeJar)) ok(`bridge jar: ${r.bridgeJar}`); else problems.push(`bridge jar missing: run bridge/build.sh`);
        if (fs.existsSync(path.join(r.cwd, "res"))) ok(`Forge res/: ${path.join(r.cwd, "res")}`); else problems.push(`no res/ directory under ${r.cwd}`);
      } else ok("mock engine (pipeline testing only — not valid for results)");
      if (args.includes("--ping")) {
        console.log("Ping LLM seats");
        for (const s of cfg.seats) {
          if (!["anthropic", "openai", "openrouter", "gemini"].includes(s.provider)) continue;
          try {
            const p = s.provider === "anthropic" ? new AnthropicProvider(s) : new OpenAIProvider(s);
            const t = await p.complete({ system: "You are a test.", messages: [{ role: "user", content: "Call submit_decision with choice [\"o1\"]." }], tools: [SUBMIT_TOOL] });
            ok(`${s.id}: ${t.toolCalls.length ? `tool call ${t.toolCalls[0].name}(${JSON.stringify(t.toolCalls[0].input)})` : `text "${t.text.slice(0, 60)}"`} · in ${t.usage.inputTokens}+${t.usage.cacheReadTokens} out ${t.usage.outputTokens} (reasoning ${t.usage.reasoningTokens})${t.servedBy ? ` · served by ${t.servedBy}` : ""}`);
            const violation = checkSeatSpec(s, t);
            if (violation) problems.push(`${s.id}: seat spec broken: ${violation}`);
          } catch (e: any) { problems.push(`${s.id}: ${e.message}`); }
        }
      }
      if (problems.length) { console.log("\nProblems:"); for (const p of problems) console.log(`  ✗ ${p}`); process.exitCode = 1; }
      else console.log("\nAll checks passed.");
      return;
    }
    case "run": {
      const cfg = loadConfig(positional(args)[0]);
      if (flag(args, "forge-res")) cfg.forgeRes = path.resolve(flag(args, "forge-res")!);
      const engineType = (flag(args, "engine") ?? cfg.engine.type) as "mock" | "forge";
      if (flag(args, "pods")) cfg.event.pods = Number(flag(args, "pods"));
      const miss = missingKeys(cfg);
      if (miss.length) throw new Error("missing API keys:\n  " + miss.join("\n  "));
      const engine = engineType === "forge" ? new ForgeEngine(cfg.engine) : new MockEngine(loadDb());
      if (engineType === "mock") info("NOTE: mock engine — simplified rules, for pipeline testing only.");
      if (flag(args, "decks-from") && flag(args, "pools-from")) throw new Error("--decks-from and --pools-from are mutually exclusive");
      const allowChanges = args.includes("--allow-seat-changes") || undefined;
      const source = flag(args, "decks-from") ? { runDir: path.resolve(flag(args, "decks-from")!), mode: "decks" as const, allowChanges }
        : flag(args, "pools-from") ? { runDir: path.resolve(flag(args, "pools-from")!), mode: "pools" as const, allowChanges } : undefined;
      const { runDir, ratings } = await runEvent(cfg, engine, { runId: flag(args, "run-id"), source, force: args.includes("--force") });
      console.log("\nRatings:");
      for (const r of ratings) console.log(`  ${r.id.padEnd(22)} ${r.rating.toFixed(0).padStart(5)}  [${r.lo.toFixed(0)}–${r.hi.toFixed(0)}]  ${r.score.toFixed(1)}/${r.games}`);
      console.log(`\nReport: ${path.join(runDir, "report.md")}`);
      return;
    }
    case "match": {
      const cfg = loadConfig(positional(args)[0]);
      if (flag(args, "forge-res")) cfg.forgeRes = path.resolve(flag(args, "forge-res")!);
      const seatIds = (flag(args, "seats") ?? "").split(",").filter(Boolean);
      const deckFiles = (flag(args, "decks") ?? "").split(",").filter(Boolean);
      if (seatIds.length !== 2 || deckFiles.length !== 2) throw new Error("usage: match <config.yaml> --seats A,B --decks a.dck,b.dck [--matches N] [--parallel N] [--run-id ID]");
      const seatCfgs = cfg.seats.filter((s) => seatIds.includes(s.id));
      const miss = missingKeys({ ...cfg, seats: seatCfgs });
      if (miss.length) throw new Error("missing API keys:\n  " + miss.join("\n  "));
      const engineType = (flag(args, "engine") ?? cfg.engine.type) as "mock" | "forge";
      const engine = engineType === "forge" ? new ForgeEngine(cfg.engine) : new MockEngine(loadDb());
      const { runDir, results } = await runHeadToHead(cfg, engine, {
        seats: [seatIds[0], seatIds[1]], deckFiles: [path.resolve(deckFiles[0]), path.resolve(deckFiles[1])],
        matches: Number(flag(args, "matches") ?? 1), parallel: flag(args, "parallel") ? Number(flag(args, "parallel")) : undefined, runId: flag(args, "run-id"),
        force: args.includes("--force"),
      });
      const w = [0, 0, 0];
      for (const r of results) for (const g of r.games) w[g.winner === 0 ? 0 : g.winner === 1 ? 1 : 2]++;
      console.log(`\nGames: ${seatIds[0]} ${w[0]} – ${w[1]} ${seatIds[1]}${w[2] ? ` (${w[2]} drawn)` : ""}`);
      console.log(`Report: ${path.join(runDir, "report.md")}`);
      return;
    }
    case "report": {
      const dirs = positional(args);
      checkPoolable(dirs, args);
      const s = summarize(dirs);
      const md = renderReport(s, dirs.length === 1 ? `Run ${path.basename(dirs[0])}` : `Merged report (${dirs.length} runs)`);
      if (dirs.length === 1) fs.writeFileSync(path.join(dirs[0], "report.md"), md);
      console.log(md);
      return;
    }
    case "rate": {
      const dirs = positional(args);
      checkPoolable(dirs, args);
      const level = (flag(args, "level") ?? "game") as "game" | "match";
      const anchorArg = flag(args, "anchor");
      const anchor = anchorArg ? { id: anchorArg.split("=")[0], rating: Number(anchorArg.split("=")[1] ?? 1500) } : undefined;
      const matches = readMatches(dirs);
      for (const r of rate(outcomesFromMatches(matches, level), { bootstrap: 1000, anchor })) {
        console.log(`${r.id.padEnd(24)} ${r.rating.toFixed(0).padStart(5)}  [${r.lo.toFixed(0)}–${r.hi.toFixed(0)}]  ${r.score.toFixed(1)}/${r.games}`);
      }
      return;
    }
    default:
      console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 10).join("\n"));
  }
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
