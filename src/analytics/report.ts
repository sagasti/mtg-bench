/**
 * Aggregates a run's JSONL logs into report.md + summary.json:
 * ratings, per-seat token usage & cost, per-phase / per-decision-kind breakdowns,
 * reliability (invalid answers, fallbacks, API errors), tool usage, game stats.
 * Works on one run dir or several (merged).
 */
import fs from "node:fs";
import path from "node:path";
import type { BenchConfig, Pricing } from "../config.ts";
import { scanEngineErrors } from "../engine/forge/log.ts";
import type { MatchResult } from "../engine/types.ts";
import { rate } from "../rating/bt.ts";
import { censoredBySeat, outcomesFromMatches, readMatches } from "../rating/outcomes.ts";
import { readJsonl } from "../util/log.ts";
import { describeProvenance, type Provenance } from "../util/provenance.ts";
import type { CallRecord, DecisionRecord } from "./recorder.ts";

interface Agg {
  decisions: number; autoResolved: number; modelCalls: number; apiErrors: number;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number;
  invalidAttempts: number; fallbacks: number; latencies: number[]; tools: Record<string, number>; cost: number | null;
  reportedCost: number; costReportedCalls: number; forfeits: number;
}
const newAgg = (): Agg => ({ decisions: 0, autoResolved: 0, modelCalls: 0, apiErrors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  cacheWriteTokens: 0, reasoningTokens: 0, invalidAttempts: 0, fallbacks: 0, latencies: [], tools: {}, cost: 0, reportedCost: 0, costReportedCalls: 0, forfeits: 0 });

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
  a.invalidAttempts += d.invalidAttempts; if (d.fallback) a.fallbacks++; if (d.forfeit) a.forfeits++;
  if (d.modelCalls > 0) a.latencies.push(d.latencyMs);
  for (const [k, v] of Object.entries(d.toolCalls ?? {})) a.tools[k] = (a.tools[k] ?? 0) + v;
  a.reportedCost += d.reportedCostUsd ?? 0; a.costReportedCalls += d.costReportedCalls ?? 0;
  const c = costOf(d, pricing[d.model]);
  a.cost = a.cost === null || c === null ? (d.modelCalls ? null : a.cost) : a.cost + c;
}

const pct = (xs: number[], q: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);
const usd = (n: number | null) => (n === null ? "n/a" : `$${n.toFixed(n < 1 ? 4 : 2)}`);
/** Provider-reported cost, marked when only some calls reported one. */
const reported = (a: Agg) => (a.costReportedCalls === 0 ? "n/a" : `${usd(a.reportedCost)}${a.costReportedCalls < a.modelCalls ? ` (${a.costReportedCalls}/${a.modelCalls} calls)` : ""}`);

/**
 * Pods of different runs that drafted the same packs (same cube, draft seed and pod index): they aren't independent
 * replicates, so pooling them overstates the evidence. Returns one line per shared pod; empty when all are distinct.
 */
export function sharedDrafts(runDirs: string[]): string[] {
  const seen = new Map<string, string[]>();
  for (const d of runDirs) {
    const events = readJsonl(path.join(d, "events.jsonl"));
    const f = path.join(d, "config.json");
    const cfg = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : undefined;
    const cube = events.find((e) => e.type === "run_start")?.cube ?? cfg?.event?.cube;
    for (const e of events) if (e.type === "pod_start") {
      const key = `cube "${cube}", seed ${e.draftSeed ?? cfg?.event?.seed}, pod ${e.pod}`;
      seen.set(key, [...(seen.get(key) ?? []), path.basename(d)]);
    }
  }
  return [...seen.entries()].filter(([, runs]) => runs.length > 1).map(([key, runs]) => `${key}: ${runs.join(", ")}`);
}

export function summarize(runDirs: string[], cfg?: BenchConfig) {
  const decisions: DecisionRecord[] = runDirs.flatMap((d) => readJsonl(path.join(d, "decisions.jsonl")));
  const calls: CallRecord[] = runDirs.flatMap((d) => readJsonl(path.join(d, "usage.jsonl")));
  const matches: MatchResult[] = readMatches(runDirs);
  const pricing: Record<string, Pricing> = { ...(cfg?.pricing ?? {}) };
  for (const d of runDirs) {
    const f = path.join(d, "config.json");
    if (fs.existsSync(f)) Object.assign(pricing, { ...JSON.parse(fs.readFileSync(f, "utf8")).pricing, ...pricing });
  }

  // A run that stopped early has no run_end, and a pod it was playing no pod_end.
  const incomplete: string[] = [];
  const versions: { run: string; provenance?: Provenance }[] = [];
  for (const d of runDirs) {
    const events = readJsonl(path.join(d, "events.jsonl"));
    versions.push({ run: path.basename(d), provenance: events.find((e) => e.type === "run_start")?.provenance });
    if (!events.some((e) => e.type === "run_end")) incomplete.push(`${path.basename(d)}: no run_end`);
    const ended = new Set(events.filter((e) => e.type === "pod_end").map((e) => e.pod));
    for (const e of events) if (e.type === "pod_start" && !ended.has(e.pod)) incomplete.push(`${path.basename(d)}: pod ${e.pod} has no pod_end`);
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
  const censored = censoredBySeat(matches);
  const games = matches.flatMap((m) => m.games);
  const reasons: Record<string, number> = {};
  for (const g of games) reasons[g.reason.split(":")[0]] = (reasons[g.reason.split(":")[0]] ?? 0) + 1;
  const decided = games.filter((g) => g.winner !== null);
  const playWins = decided.filter((g) => g.winner === g.onThePlay).length;

  // Decisions the agent forfeited: harness forfeits (answers kept failing validation) plus bridge forfeits
  // (answers kept failing in-game, e.g. lands that can't pay). Counted against the agent.
  const forfeited = new Map<string, Map<string, number>>();
  const bump = (seat: string, key: string) => {
    if (!forfeited.has(seat)) forfeited.set(seat, new Map());
    forfeited.get(seat)!.set(key, (forfeited.get(seat)!.get(key) ?? 0) + 1);
  };
  for (const d of decisions) if (d.forfeit) bump(d.seat, `${d.kind} (no valid answer)`);
  for (const m of matches) for (const f of m.forfeits ?? []) bump(m.seats[f.seat], `${f.what} (${f.reason.replace(/ in \d+ attempts.*/, "")})`);

  // Who decided each in-game decision (docs/DECISION-PROVENANCE.md): the agent, forced (one legal action),
  // policy (a configured rule), delegated (Forge's AI or a default), forfeit (the agent failed).
  const provenance = new Map<string, { agent: number; forced: Map<string, number>; policy: Map<string, number>; delegated: Map<string, number>; forfeit: Map<string, number> }>();
  const prov = (seat: string) => {
    if (!provenance.has(seat)) provenance.set(seat, { agent: 0, forced: new Map(), policy: new Map(), delegated: new Map(), forfeit: new Map() });
    return provenance.get(seat)!;
  };
  const add = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
  for (const d of decisions) {
    if (d.phase !== "game") continue;
    const p = prov(d.seat);
    if (d.autoResolved) add(p.forced, `${d.kind}: only one option`);
    else if (d.forfeit) add(p.forfeit, `${d.kind}: no valid answer`);
    else if (!d.fallback) p.agent++;
  }
  for (const m of matches) {
    for (const a of m.auto ?? []) add((prov(m.seats[a.seat]) as any)[a.category] ?? prov(m.seats[a.seat]).policy, `${a.what}: ${a.reason}`, a.count);
    for (const d of m.delegations ?? []) add(prov(m.seats[d.seat]).delegated, `${d.what}: ${d.reason}`);
    for (const f of m.forfeits ?? []) add(prov(m.seats[f.seat]).forfeit, `${f.what}: ${f.reason.replace(/ in \d+ attempts.*/, "")}`);
  }

  // Decisions Forge's AI made on an agent's behalf (Forge engine only)
  const delegated = new Map<string, Map<string, number>>();
  for (const m of matches) for (const d of m.delegations ?? []) {
    const seat = m.seats[d.seat];
    if (!delegated.has(seat)) delegated.set(seat, new Map());
    const key = `${d.what} (${d.reason})`;
    delegated.get(seat)!.set(key, (delegated.get(seat)!.get(key) ?? 0) + 1);
  }

  // Exceptions Forge logged mid-game: the match completed, but its state may have been corrupt from that point.
  const engineErrors = new Map<string, number>();
  let matchesWithEngineErrors = 0;
  for (const m of matches) {
    // Runs recorded before the field existed: scan their Forge logs now.
    if (!m.engineErrors) for (const d of runDirs) {
      const log = path.join(d, "forge-logs", `${m.matchId}.log`);
      if (fs.existsSync(log)) m.engineErrors = scanEngineErrors(log, m.games.map(() => Infinity));
    }
    if (m.engineErrors?.length) matchesWithEngineErrors++;
    for (const e of m.engineErrors ?? []) add(engineErrors, `${e.kind} at ${e.at || "?"}`);
  }

  return { incomplete, versions, decisions, calls, matches, bySeat, bySeatPhase, byKind, ratings, censored, games, reasons, delegated, forfeited, provenance, engineErrors, matchesWithEngineErrors, playWinRate: decided.length ? playWins / decided.length : null, pricing };
}

export function renderReport(s: ReturnType<typeof summarize>, title: string): string {
  const L: string[] = [];
  L.push(`# ${title}`, "");
  if (s.incomplete.length) L.push(`**INCOMPLETE**: the run stopped before it finished (${s.incomplete.join("; ")}). Standings and ratings cover only the matches that were played.`, "");
  L.push(`Matches: ${s.matches.length} · Games: ${s.games.length} · Decisions: ${s.decisions.length} · Model calls: ${s.calls.length}`, "");

  L.push("## Ratings (Bradley-Terry, game level, Elo scale, 95% bootstrap CI)", "");
  L.push("| # | Seat | Rating | 95% CI | Games | Score |", "|---|---|---|---|---|---|");
  s.ratings.forEach((r, i) => L.push(`| ${i + 1} | ${r.id} | ${r.rating.toFixed(0)} | ${r.lo.toFixed(0)}–${r.hi.toFixed(0)} | ${r.games} | ${r.score.toFixed(1)} |`));
  L.push("");
  if (s.censored.size) {
    const n = s.matches.filter((m) => m.error).length;
    L.push(`**Censored: ${n} match(es) ended in an error** and are left out of the ratings and standings entirely, including the games they finished (policy in docs/ANALYTICS.md). Errors cut off long matches, so a seat with many censored matches may be rated on a biased sample.`, "");
    L.push("| Seat | Censored matches | Finished games left out |", "|---|---|---|");
    for (const [seat, c] of [...s.censored.entries()].sort()) L.push(`| ${seat} | ${c.matches} | ${c.games} |`);
    L.push("");
  }

  L.push("## Token usage and cost by seat", "");
  L.push("| Seat | Model | Decisions (auto) | Calls | Input | Cache read | Cache write | Output | Reasoning | Tokens/decision | Cost (computed) | Cost (reported) | p50 / p95 latency |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [seat, a] of [...s.bySeat.entries()].sort()) {
    const tot = a.inputTokens + a.outputTokens + a.cacheReadTokens + a.cacheWriteTokens;
    L.push(`| ${seat} | ${a.model} | ${a.decisions} (${a.autoResolved}) | ${a.modelCalls} | ${k(a.inputTokens)} | ${k(a.cacheReadTokens)} | ${k(a.cacheWriteTokens)} | ${k(a.outputTokens)} | ${k(a.reasoningTokens)} | ${a.decisions ? k(Math.round(tot / a.decisions)) : "–"} | ${usd(a.cost)} | ${reported(a)} | ${(pct(a.latencies, 0.5) / 1000).toFixed(1)}s / ${(pct(a.latencies, 0.95) / 1000).toFixed(1)}s |`);
  }
  const totalCost = [...s.bySeat.values()].reduce<number | null>((t, a) => (t === null || a.cost === null ? (a.modelCalls ? null : t) : t + a.cost), 0);
  const totalReported = [...s.bySeat.values()].reduce((t, a) => t + a.reportedCost, 0);
  const anyReported = [...s.bySeat.values()].some((a) => a.costReportedCalls > 0);
  L.push("", `Total cost: computed ${usd(totalCost)}${totalCost === null ? " (add `pricing` for every model in the config to get costs)" : ""}`
    + (anyReported ? ` · reported by provider ${usd(totalReported)}` : ""), "",
    "Computed cost is tokens × the config's `pricing`. Reported cost is what the provider says it charged (OpenRouter returns it per call); when they differ, trust the reported figure and fix `pricing` or pin the host.", "");
  const hosts = new Map<string, Map<string, number>>();
  for (const c of s.calls) if (c.servedBy) {
    const m = hosts.get(c.seat) ?? new Map<string, number>(); m.set(c.servedBy, (m.get(c.servedBy) ?? 0) + 1); hosts.set(c.seat, m);
  }
  if (hosts.size) {
    L.push("Hosts that served each seat (calls): " + [...hosts.entries()].map(([seat, m]) => `${seat}: ${[...m.entries()].map(([h, n]) => `${h} ${n}`).join(", ")}`).join("; "), "");
  }

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
  L.push("| Seat | Invalid answers | Forfeits (rate) | Fallbacks (rate) | API errors | Tool calls |", "|---|---|---|---|---|---|");
  for (const [seat, a] of [...s.bySeat.entries()].sort()) {
    const tools = Object.entries(a.tools).filter(([n]) => n !== "submit_decision" && n !== "submit_brief").map(([n, v]) => `${n}: ${v}`).join(", ") || "–";
    const rate = (n: number) => `${n} (${a.decisions ? ((100 * n) / a.decisions).toFixed(1) : 0}%)`;
    L.push(`| ${seat} | ${a.invalidAttempts} | ${rate(a.forfeits)} | ${rate(a.fallbacks)} | ${a.apiErrors} | ${tools} |`);
  }
  L.push("");

  L.push("## Engine exceptions", "");
  if (!s.engineErrors.size) L.push("None: Forge logged no exceptions during any game.", "");
  else {
    const n = [...s.engineErrors.values()].reduce((a, b) => a + b, 0);
    L.push(`**${n} exception(s) in ${s.matchesWithEngineErrors} of ${s.matches.length} matches.** Forge logs these and carries on, so the affected games finished in a possibly corrupt state (a cost paid twice, a trigger dropped). Treat those matches as suspect; the stacks are in forge-logs/<match>.log.`, "");
    L.push("| Count | Exception | First Forge frame |", "|---|---|---|");
    for (const [k, v] of [...s.engineErrors.entries()].sort((a, b) => b[1] - a[1])) {
      const [kind, at] = k.split(" at ");
      L.push(`| ${v} | ${kind} | ${at} |`);
    }
    L.push("", "Matches: " + s.matches.filter((m) => m.engineErrors?.length).map((m) => `${m.matchId} (${m.engineErrors!.length})`).join(", "), "");
  }

  L.push("## Who made each in-game decision", "");
  if (!s.provenance.size) L.push("No in-game decisions recorded.", "");
  else {
    L.push("Every in-game action for a seat, by who chose it (definitions in docs/DECISION-PROVENANCE.md). **forced**: only one legal action existed. **policy**: a configured rule acted (meaningful stops, auto mana payment when every source is the same kind, no sideboarding). **delegated**: a real choice made by Forge's AI or a default; this should be near zero. **forfeit**: the agent failed and got the null action.", "");
    L.push("| Seat | Agent | Forced | Policy | Delegated | Forfeit | Agent share of real choices |", "|---|---|---|---|---|---|---|");
    const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    for (const [seat, p] of [...s.provenance.entries()].sort()) {
      const real = p.agent + sum(p.delegated) + sum(p.forfeit);
      L.push(`| ${seat} | ${p.agent} | ${sum(p.forced)} | ${sum(p.policy)} | ${sum(p.delegated)} | ${sum(p.forfeit)} | ${real ? ((100 * p.agent) / real).toFixed(1) + "%" : "–"} |`);
    }
    L.push("", "Breakdown (count: decision: reason):", "");
    for (const [seat, p] of [...s.provenance.entries()].sort()) {
      for (const cat of ["forced", "policy", "delegated", "forfeit"] as const) {
        const m = p[cat];
        if (!m.size) continue;
        L.push(`- ${seat} · **${cat}**: ` + [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join("; "));
      }
    }
    L.push("");
  }

  L.push("## Forfeited decisions", "");
  if (!s.forfeited.size) L.push("None.", "");
  else {
    L.push(`The agent's answers kept failing (after \`maxRetries\` re-asks), so it got the null action: pass, decline, no attack/block, the first legal option, or a cancelled cast. This measures the agent and counts against it.`, "");
    L.push("| Seat | Forfeited | Most common |", "|---|---|---|");
    for (const [seat, m] of [...s.forfeited.entries()].sort()) {
      const total = [...m.values()].reduce((a, b) => a + b, 0);
      const top = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join("; ");
      L.push(`| ${seat} | ${total} | ${top} |`);
    }
    L.push("");
  }

  L.push("## Decisions made by Forge AI on an agent's behalf", "");
  if (!s.delegated.size) L.push("None recorded (or not a Forge run).", "");
  else {
    L.push("Decision types the bridge doesn't offer to agents yet, so Forge's AI decides. A high share means the rating partly reflects Forge's AI; these are gaps in the harness, not the agent's mistakes.", "");
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

  L.push("", "## Versions", "");
  for (const v of s.versions) L.push(`- ${s.versions.length > 1 ? `${v.run}: ` : ""}${v.provenance ? describeProvenance(v.provenance) : "not recorded (run predates version provenance)"}`);
  return L.join("\n") + "\n";
}

export function writeReport(runDir: string, cfg?: BenchConfig) {
  const s = summarize([runDir], cfg);
  fs.writeFileSync(path.join(runDir, "report.md"), renderReport(s, `Run ${path.basename(runDir)}`));
  const json = {
    incomplete: s.incomplete.length ? s.incomplete : undefined,
    versions: s.versions,
    ratings: s.ratings,
    censored: Object.fromEntries(s.censored),
    seats: Object.fromEntries([...s.bySeat.entries()].map(([id, a]) => [id, { ...a, latencies: undefined, p50LatencyMs: pct(a.latencies, 0.5), p95LatencyMs: pct(a.latencies, 0.95) }])),
    games: s.games.length, reasons: s.reasons, playWinRate: s.playWinRate,
    delegated: Object.fromEntries([...s.delegated.entries()].map(([k, m]) => [k, Object.fromEntries(m)])),
    forfeited: Object.fromEntries([...s.forfeited.entries()].map(([k, m]) => [k, Object.fromEntries(m)])),
    engineErrors: { matches: s.matchesWithEngineErrors, byKind: Object.fromEntries(s.engineErrors) },
    provenance: Object.fromEntries([...s.provenance.entries()].map(([k, p]) => [k, { agent: p.agent, forced: Object.fromEntries(p.forced), policy: Object.fromEntries(p.policy), delegated: Object.fromEntries(p.delegated), forfeit: Object.fromEntries(p.forfeit) }])),
  };
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(json, null, 2));
}
