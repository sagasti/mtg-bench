/**
 * Bridge conformance check (MB-010): a fixed set of bot-only matches with fixed decks and seeds, summarised and
 * compared against a stored baseline. Run it after any Forge bump or bridge change: the bridge reads Forge internals
 * by reflection and keys off prompt and button text, so an upgrade can break it without failing to compile.
 *
 * Same seed doesn't mean same games: Forge's AI and the bots' random streams make runs differ a little, so the
 * comparison is exact only where a healthy bridge never varies (match errors, engine exceptions, bridge errors,
 * which kinds of game end occur) and tolerant on counts (games, decisions per seat and kind, forfeits, delegations).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSeat } from "../agents/factory.ts";
import { Recorder } from "../analytics/recorder.ts";
import { loadDb } from "../cards/db.ts";
import { loadRankings } from "../cards/cube.ts";
import type { BenchConfig, ProviderName } from "../config.ts";
import { saveDeck } from "../deckbuild/deckbuild.ts";
import type { GameEngine, MatchResult } from "../engine/types.ts";
import { KnowledgeBase } from "../knowledge/tools.ts";
import { info, Jsonl, readJsonl } from "../util/log.ts";
import { collectProvenance } from "../util/provenance.ts";
import { Rng } from "../util/rng.ts";
import { loadDeckFile } from "./match.ts";
import { freshRunDir, pool } from "./run.ts";

export const CONFORMANCE_DIR = fileURLToPath(new URL("../../conformance", import.meta.url));

/** The fixed matches: rank-bot and random exercise every decision type through the bridge, forge-ai Forge's own AI. */
const FIXTURES: { id: string; seats: [ProviderName, ProviderName]; decks: [string, string] }[] = [
  { id: "rank-vs-random", seats: ["rank-bot", "random"], decks: ["deck-a", "deck-b"] },
  { id: "random-vs-rank", seats: ["random", "rank-bot"], decks: ["deck-c", "deck-d"] },
  { id: "rank-vs-rank", seats: ["rank-bot", "rank-bot"], decks: ["deck-b", "deck-c"] },
  { id: "rank-vs-forge-ai", seats: ["rank-bot", "forge-ai"], decks: ["deck-d", "deck-a"] },
  // Regression (MB-048): Animate Dead on the opponent's Ertai Resurrected made Forge's rules-text renderer throw.
  { id: "animate-vs-ertai", seats: ["rank-bot", "rank-bot"], decks: ["deck-animate", "deck-ertai"] },
];
/** Event settings are fixed here, not taken from the config, so every check plays the same matches. */
const SETTINGS = { seed: 1, gamesPerMatch: 3, maxGameTurns: 40, maxRetries: 3, priorityStops: "smart", manaPayment: "smart" } as const;

/** What a fixture's match looked like. */
export interface MatchSignature {
  error: string | null;                  // errorKind (or the message's start) of an abandoned match
  games: number;
  endReasons: string[];                  // kinds of game end seen, e.g. "AllOpponentsLost", "Draw"
  engineExceptions: number;
  bridgeErrors: number;                  // "[bridge error]" lines in the Forge log
  bridgeWarnings?: number;               // workarounds the bridge reported (shown, not compared: random streams move them)
  decisions: Record<string, number>;     // "<seat 0|1>:<kind>" -> decisions asked (all rows, forced and re-asks included)
  forfeits: number;
  delegations: number;
}

export interface Baseline { createdAt: string; provenance: unknown; settings: typeof SETTINGS; matches: Record<string, MatchSignature> }

export async function runConformance(cfg: BenchConfig, engine: GameEngine, opts: { runId?: string; force?: boolean; parallel?: number } = {}) {
  const runId = opts.runId ?? `conformance-${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}`;
  const runDir = freshRunDir(cfg.outputDir, runId, opts.force);
  const db = loadDb();
  const rankings = loadRankings(cfg.forgeRes);
  const event = { ...cfg.event, ...SETTINGS };
  const seatCfg = { ...cfg, event, seats: [] };
  const provenance = collectProvenance(cfg, engine.name);
  fs.writeFileSync(path.join(runDir, "config.json"), JSON.stringify({ ...seatCfg, conformance: FIXTURES, provenance }, null, 2));
  const recorder = new Recorder(runDir, runId);
  recorder.event("run_start", { conformance: true, provenance });
  const matchLog = new Jsonl(path.join(runDir, "matches.jsonl"));
  info(`conformance ${runId}: ${FIXTURES.length} bot matches, bo${SETTINGS.gamesPerMatch}, engine=${engine.name}`);

  const results = await pool(FIXTURES, Math.max(1, opts.parallel ?? 2), async (f) => {
    // Fresh streams per fixture, so its seats play the same whatever ran before or alongside it.
    const rng = new Rng(SETTINGS.seed).fork(f.id);
    const seats = f.seats.map((provider, i) => makeSeat({ id: `${f.id}-${i}`, provider }, {
      cfg: seatCfg, db, kb: new KnowledgeBase(db, []), rankings, recorder, rng, cubeName: "conformance",
    }));
    const decks = f.decks.map((d, i) => loadDeckFile(path.join(CONFORMANCE_DIR, "decks", `${d}.json`), seats[i].id));
    const deckFiles = decks.map((d) => saveDeck(path.join(runDir, "decks"), d));
    let res: MatchResult;
    try {
      res = await engine.playMatch({
        matchId: f.id, pod: 0, round: 1, seats: [seats[0], seats[1]], decks: [decks[0], decks[1]], deckFiles: [deckFiles[0], deckFiles[1]],
        gamesPerMatch: SETTINGS.gamesPerMatch, seed: new Rng(SETTINGS.seed).fork(f.id).int(2 ** 31), maxGameTurns: SETTINGS.maxGameTurns,
        runDir, priorityStops: SETTINGS.priorityStops, manaPayment: SETTINGS.manaPayment, maxRetries: SETTINGS.maxRetries,
      });
    } catch (e: any) {
      res = { matchId: f.id, pod: 0, round: 1, seats: [seats[0].id, seats[1].id], games: [], winner: null, error: String(e?.message ?? e), errorKind: "harness" };
    }
    matchLog.write(res);
    info(`  ${f.id}: ${res.games.map((g) => g.reason).join(", ") || "no games"}${res.error ? ` ERROR ${res.error}` : ""}`);
    return res;
  });
  recorder.event("run_end", { matches: results.length });
  matchLog.close(); recorder.close();
  await engine.close?.();

  const decisions = readJsonl(path.join(runDir, "decisions.jsonl"));
  const matches: Record<string, MatchSignature> = {};
  for (const m of results) {
    const counts: Record<string, number> = {};
    for (const d of decisions) if (d.matchId === m.matchId) {
      const k = `${m.seats.indexOf(d.seat)}:${d.kind}`;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const log = path.join(runDir, "forge-logs", `${m.matchId}.log`);
    matches[m.matchId] = {
      error: m.error ? m.errorKind ?? m.error.slice(0, 40) : null,
      games: m.games.length,
      endReasons: [...new Set(m.games.map((g) => g.reason.split(/[:(]/)[0].trim()))].sort(),
      engineExceptions: m.engineErrors?.length ?? 0,
      bridgeErrors: fs.existsSync(log) ? (fs.readFileSync(log, "utf8").match(/^\[bridge error\]/gm) ?? []).length : 0,
      bridgeWarnings: (m.warnings ?? []).reduce((a, w) => a + w.count, 0),
      decisions: Object.fromEntries(Object.entries(counts).sort()),
      forfeits: m.forfeits?.length ?? 0,
      delegations: m.delegations?.length ?? 0,
    };
  }
  const current: Baseline = { createdAt: new Date().toISOString(), provenance, settings: SETTINGS, matches };
  fs.writeFileSync(path.join(runDir, "conformance.json"), JSON.stringify(current, null, 2));
  return { runDir, current };
}

/** Counts may move by this much before they count as a change: max(absolute, relative × baseline). */
const TOLERANCE = { games: { abs: 1, rel: 0 }, decisions: { abs: 10, rel: 0.5 }, total: { abs: 20, rel: 0.25 }, forfeits: { abs: 3, rel: 0.5 }, delegations: { abs: 3, rel: 0.5 } };

/** Differences from the baseline that fail the check (empty = pass). */
export function compareToBaseline(base: Baseline, cur: Baseline): string[] {
  const out: string[] = [];
  const within = (what: string, b: number, c: number, t: { abs: number; rel: number }) => {
    if (Math.abs(c - b) > Math.max(t.abs, t.rel * b)) out.push(`${what}: ${b} in the baseline, ${c} now (tolerance ±${Math.max(t.abs, Math.round(t.rel * b))})`);
  };
  for (const [id, b] of Object.entries(base.matches)) {
    const c = cur.matches[id];
    if (!c) { out.push(`${id}: not played`); continue; }
    // Exact: a healthy bridge never varies on these.
    if (c.error !== b.error) out.push(`${id}: match error ${b.error ?? "none"} in the baseline, ${c.error ?? "none"} now`);
    if (c.engineExceptions !== b.engineExceptions) out.push(`${id}: ${b.engineExceptions} engine exception(s) in the baseline, ${c.engineExceptions} now`);
    if (c.bridgeErrors !== b.bridgeErrors) out.push(`${id}: ${b.bridgeErrors} bridge error(s) in the baseline, ${c.bridgeErrors} now`);
    const newReasons = c.endReasons.filter((r) => !b.endReasons.includes(r));
    if (newReasons.length) out.push(`${id}: game end reason(s) not in the baseline: ${newReasons.join(", ")}`);
    // Tolerant: random streams move these.
    within(`${id} games`, b.games, c.games, TOLERANCE.games);
    within(`${id} forfeits`, b.forfeits, c.forfeits, TOLERANCE.forfeits);
    within(`${id} delegations`, b.delegations, c.delegations, TOLERANCE.delegations);
    for (const seat of ["0", "1"]) {
      const sum = (d: Record<string, number>) => Object.entries(d).filter(([k]) => k.startsWith(`${seat}:`)).reduce((a, [, v]) => a + v, 0);
      within(`${id} seat ${seat} decisions`, sum(b.decisions), sum(c.decisions), TOLERANCE.total);
    }
    for (const k of new Set([...Object.keys(b.decisions), ...Object.keys(c.decisions)])) {
      within(`${id} decisions ${k}`, b.decisions[k] ?? 0, c.decisions[k] ?? 0, TOLERANCE.decisions);
    }
  }
  for (const id of Object.keys(cur.matches)) if (!base.matches[id]) out.push(`${id}: not in the baseline (re-create it with --update)`);
  return out;
}
