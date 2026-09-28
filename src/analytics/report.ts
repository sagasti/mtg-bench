/**
 * Aggregates a run's JSONL logs into report.md + summary.json:
 * ratings, per-seat token usage & cost, per-phase / per-decision-kind breakdowns,
 * reliability (invalid answers, fallbacks, API errors), tool usage, game stats.
 * Works on one run dir or several (merged).
 */
import fs from "node:fs";
import path from "node:path";
import type { BenchConfig, Pricing } from "../config.ts";
import type { MatchResult } from "../engine/types.ts";
import { rate } from "../rating/bt.ts";
import { outcomesFromMatches } from "../rating/outcomes.ts";
import { readJsonl } from "../util/log.ts";
import type { CallRecord, DecisionRecord } from "./recorder.ts";

interface Agg {
  decisions: number; autoResolved: number; modelCalls: number; apiErrors: number;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number;
  invalidAttempts: number; fallbacks: number; latencies: number[]; tools: Record<string, number>; cost: number | null;
}
const newAgg = (): Agg => ({ decisions: 0, autoResolved: 0, modelCalls: 0, apiErrors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  cacheWriteTokens: 0, reasoningTokens: 0, invalidAttempts: 0, fallbacks: 0, latencies: [], tools: {}, cost: 0 });

export function costOf(r: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }, p?: Pricing): number | null {
  if (!p) return null;
  return (r.inputTokens * p.input + r.outputTokens * p.output + r.cacheReadTokens * (p.cacheRead ?? p.input * 0.1)
    + r.cacheWriteTokens * (p.cacheWrite ?? p.input * 1.25)) / 1e6;
}

function addDecision(a: Agg, d: DecisionRecord, pricing: Record<string, Pricing>) {
  if (d.autoResolved) { a.autoResolved++; return; }
  a.decisions++;
  a.modelCalls += d.modelCalls;
  a.inputTokens += d.inputTokens; a.outputTokens += d.outputTokens;
  a.cacheReadTokens += d.cacheReadTokens; a.cacheWriteTokens += d.cacheWriteTokens; a.reasoningTokens += d.reasoningTokens;
  a.invalidAttempts += d.invalidAttempts; if (d.fallback) a.fallbacks++;
  if (d.modelCalls > 0) a.latencies.push(d.latencyMs);
  for (const [k, v] of Object.entries(d.toolCalls ?? {})) a.tools[k] = (a.tools[k] ?? 0) + v;
  const c = costOf(d, pricing[d.model]);
  a.cost = a.cost === null || c === null ? (d.modelCalls ? null : a.cost) : a.cost + c;
}

const pct = (xs: number[], q: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);
const usd = (n: number | null) => (n === null ? "n/a" : `$${n.toFixed(n < 1 ? 4 : 2)}`);

export function summarize(runDirs: string[], cfg?: BenchConfig) {
  const decisions: DecisionRecord[] = runDirs.flatMap((d) => readJsonl(path.join(d, "decisions.jsonl")));
  const calls: CallRecord[] = runDirs.flatMap((d) => readJsonl(path.join(d, "usage.jsonl")));
  const matches: MatchResult[] = runDirs.flatMap((d) => readJsonl(path.join(d, "matches.jsonl")));
  const pricing: Record<string, Pricing> = { ...(cfg?.pricing ?? {}) };
  for (const d of runDirs) {
    const f = path.join(d, "config.json");
    if (fs.existsSync(f)) Object.assign(pricing, { ...JSON.parse(fs.readFileSync(f, "utf8")).pricing, ...pricing });
  }

  const bySeat = new Map<string, Agg & { model: string; provider: string }>();
  const bySeatPhase = new Map<string, Agg>();
  const byKind = new Map<string, Agg>();
  for (const d of decisions) {
    if (!bySeat.has(d.seat)) bySeat.set(d.seat, { ...newAgg(), model: d.model, provider: d.provider });
    addDecision(bySeat.get(d.seat)!, d, pricing);
    const sp = `${d.seat}|${d.phase}`;
    if (!bySeatPhase.has(sp)) bySeatPhase.set(sp, newAgg());
    addDecision(bySeatPhase.get(sp)!, d, pricing);
    if (d.provider && !["random", "rank-bot", "forge-ai"].includes(d.provider)) {
      if (!byKind.has(d.kind)) byKind.set(d.kind, newAgg());
      addDecision(byKind.get(d.kind)!, d, pricing);
    }
  }
  for (const c of calls) if (c.error) { const a = bySeat.get(c.seat); if (a) a.apiErrors++; }

  const ratings = rate(outcomesFromMatches(matches), { bootstrap: 500 });
  const games = matches.flatMap((m) => m.games);
  const reasons: Record<string, number> = {};
  for (const g of games) reasons[g.reason.split(":")[0]] = (reasons[g.reason.split(":")[0]] ?? 0) + 1;
  const decided = games.filter((g) => g.winner !== null);
  const playWins = decided.filter((g) => g.winner === g.onThePlay).length;

  // Decisions Forge's AI made on an agent's behalf (Forge engine only)
  const delegated = new Map<string, Map<string, number>>();
  for (const m of matches) for (const d of m.delegations ?? []) {
    const seat = m.seats[d.seat];
    if (!delegated.has(seat)) delegated.set(seat, new Map());
    const key = `${d.what} (${d.reason})`;
    delegated.get(seat)!.set(key, (delegated.get(seat)!.get(key) ?? 0) + 1);
  }

  return { decisions, calls, matches, bySeat, bySeatPhase, byKind, ratings, games, reasons, delegated, playWinRate: decided.length ? playWins / decided.length : null, pricing };
}

export function renderReport(s: ReturnType<typeof summarize>, title: string): string {
  const L: string[] = [];
  L.push(`# ${title}`, "");
  L.push(`Matches: ${s.matches.length} · Games: ${s.games.length} · Decisions: ${s.decisions.length} · Model calls: ${s.calls.length}`, "");

  L.push("## Ratings (Bradley-Terry, game level, Elo scale, 95% bootstrap CI)", "");
  L.push("| # | Seat | Rating | 95% CI | Games | Score |", "|---|---|---|---|---|---|");
  s.ratings.forEach((r, i) => L.push(`| ${i + 1} | ${r.id} | ${r.rating.toFixed(0)} | ${r.lo.toFixed(0)}–${r.hi.toFixed(0)} | ${r.games} | ${r.score.toFixed(1)} |`));
  L.push("");

  L.push("## Token usage and cost by seat", "");
  L.push("| Seat | Model | Decisions (auto) | Calls | Input | Cache read | Cache write | Output | Reasoning | Tokens/decision | Cost | p50 / p95 latency |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [seat, a] of [...s.bySeat.entries()].sort()) {
    const tot = a.inputTokens + a.outputTokens + a.cacheReadTokens + a.cacheWriteTokens;
    L.push(`| ${seat} | ${a.model} | ${a.decisions} (${a.autoResolved}) | ${a.modelCalls} | ${k(a.inputTokens)} | ${k(a.cacheReadTokens)} | ${k(a.cacheWriteTokens)} | ${k(a.outputTokens)} | ${k(a.reasoningTokens)} | ${a.decisions ? k(Math.round(tot / a.decisions)) : "–"} | ${usd(a.cost)} | ${(pct(a.latencies, 0.5) / 1000).toFixed(1)}s / ${(pct(a.latencies, 0.95) / 1000).toFixed(1)}s |`);
  }
  const totalCost = [...s.bySeat.values()].reduce<number | null>((t, a) => (t === null || a.cost === null ? (a.modelCalls ? null : t) : t + a.cost), 0);
  L.push("", `Total cost: ${usd(totalCost)}${totalCost === null ? " (add `pricing` for every model in the config to get costs)" : ""}`, "");

  L.push("## Tokens and cost by seat × phase", "");
  L.push("| Seat | Phase | Decisions | Input+cache | Output | Cost |", "|---|---|---|---|---|---|");
  for (const [key, a] of [...s.bySeatPhase.entries()].sort()) {
    if (!a.modelCalls) continue;
    const [seat, phase] = key.split("|");
    L.push(`| ${seat} | ${phase} | ${a.decisions} | ${k(a.inputTokens + a.cacheReadTokens + a.cacheWriteTokens)} | ${k(a.outputTokens)} | ${usd(a.cost)} |`);
  }
  L.push("");

  L.push("## Decision kinds (LLM seats)", "");
  L.push("| Kind | Decisions | Avg input+cache | Avg output | Invalid answers | Fallbacks |", "|---|---|---|---|---|---|");
  for (const [kind, a] of [...s.byKind.entries()].sort((x, y) => y[1].decisions - x[1].decisions)) {
    if (!a.decisions) continue;
    L.push(`| ${kind} | ${a.decisions} | ${k(Math.round((a.inputTokens + a.cacheReadTokens + a.cacheWriteTokens) / a.decisions))} | ${k(Math.round(a.outputTokens / a.decisions))} | ${a.invalidAttempts} | ${a.fallbacks} |`);
  }
  L.push("");

  L.push("## Reliability and tool use by seat", "");
  L.push("| Seat | Invalid answers | Fallbacks (rate) | API errors | Tool calls |", "|---|---|---|---|---|");
  for (const [seat, a] of [...s.bySeat.entries()].sort()) {
    const tools = Object.entries(a.tools).filter(([n]) => n !== "submit_decision" && n !== "submit_brief").map(([n, v]) => `${n}: ${v}`).join(", ") || "–";
    L.push(`| ${seat} | ${a.invalidAttempts} | ${a.fallbacks} (${a.decisions ? ((100 * a.fallbacks) / a.decisions).toFixed(1) : 0}%) | ${a.apiErrors} | ${tools} |`);
  }
  L.push("");

  L.push("## Decisions made by Forge AI on an agent's behalf", "");
  if (!s.delegated.size) L.push("None recorded (or not a Forge run).", "");
  else {
    L.push("A high share means the rating partly reflects Forge's AI rather than the agent. Harness fallbacks (rank-bot) are counted separately above.", "");
    L.push("| Seat | Delegated | Share of game decisions | Most common |", "|---|---|---|---|");
    for (const [seat, m] of [...s.delegated.entries()].sort()) {
      const total = [...m.values()].reduce((a, b) => a + b, 0);
      const gameDecisions = s.bySeatPhase.get(`${seat}|game`);
      const denom = gameDecisions ? gameDecisions.decisions + gameDecisions.autoResolved + total : total;
      const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join("; ");
      L.push(`| ${seat} | ${total} | ${denom ? ((100 * total) / denom).toFixed(1) : "–"}% | ${top} |`);
    }
    L.push("");
  }

  L.push("## Games", "");
  const turns = s.games.map((g) => g.turns);
  L.push(`Average length: ${turns.length ? (turns.reduce((a, b) => a + b, 0) / turns.length).toFixed(1) : "–"} turns · On-the-play win rate: ${s.playWinRate === null ? "–" : `${(100 * s.playWinRate).toFixed(1)}%`}`);
  L.push(`End reasons: ${Object.entries(s.reasons).map(([r, n]) => `${r} ${n}`).join(", ") || "–"}`);
  const errs = s.matches.filter((m) => m.error);
  if (errs.length) L.push("", `**${errs.length} match(es) failed:** ${errs.slice(0, 5).map((m) => `${m.matchId}: ${m.error}`).join("; ")}`);
  return L.join("\n") + "\n";
}

export function writeReport(runDir: string, cfg?: BenchConfig) {
  const s = summarize([runDir], cfg);
  fs.writeFileSync(path.join(runDir, "report.md"), renderReport(s, `Run ${path.basename(runDir)}`));
  const json = {
    ratings: s.ratings,
    seats: Object.fromEntries([...s.bySeat.entries()].map(([id, a]) => [id, { ...a, latencies: undefined, p50LatencyMs: pct(a.latencies, 0.5), p95LatencyMs: pct(a.latencies, 0.95) }])),
    games: s.games.length, reasons: s.reasons, playWinRate: s.playWinRate,
    delegated: Object.fromEntries([...s.delegated.entries()].map(([k, m]) => [k, Object.fromEntries(m)])),
  };
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(json, null, 2));
}
