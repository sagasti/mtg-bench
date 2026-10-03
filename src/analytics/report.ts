/**
 * Aggregates a run's JSONL logs into report.md + summary.json:
 * ratings, per-seat token usage & cost, per-phase / per-decision-kind breakdowns,
 * reliability (invalid answers, fallbacks, API errors), tool usage, game stats.
 * Works on one run dir or several (merged).
 */
import fs from "node:fs";
import path from "node:path";
import { BOT_VERSIONS } from "../agents/bots.ts";
import type { BenchConfig, Pricing } from "../config.ts";
import { scanEngineErrors } from "../engine/forge/log.ts";
import type { MatchResult } from "../engine/types.ts";
import { podRatings, rate } from "../rating/bt.ts";
import { cappedDrawsBySeat, censoredBySeat, loopDrawsBySeat, outcomesFromMatches, podLabel, readMatches } from "../rating/outcomes.ts";
import { readJsonl } from "../util/log.ts";
import { describeProvenance, type Provenance } from "../util/provenance.ts";
import { type CallRecord, costOf, type DecisionRecord } from "./recorder.ts";

/** Row fields newer runs add (absent in older runs). */
type DecisionRow = DecisionRecord & { infraError?: boolean; timedOut?: boolean; specViolation?: unknown; attempt?: number };
type CallRow = CallRecord & { truncated?: boolean; specViolation?: unknown };

interface Agg {
  decisions: number; autoResolved: number; modelCalls: number; apiErrors: number;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number;
  invalidAttempts: number; fallbacks: number; latencies: number[]; tools: Record<string, number>; cost: number | null;
  reportedCost: number; costReportedCalls: number; forfeits: number;
  reasks: number; infraErrors: number; truncated: number;
}
const newAgg = (): Agg => ({ decisions: 0, autoResolved: 0, modelCalls: 0, apiErrors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  cacheWriteTokens: 0, reasoningTokens: 0, invalidAttempts: 0, fallbacks: 0, latencies: [], tools: {}, cost: 0, reportedCost: 0, costReportedCalls: 0, forfeits: 0,
  reasks: 0, infraErrors: 0, truncated: 0 });

/**
 * Decision counts, validity, latency and tool use come from decision rows. A decision abandoned by an infrastructure
 * error isn't the agent's; a bridge re-ask (attempt > 0) continues the decision it re-asks; a timeout is a forfeit.
 */
function addDecision(a: Agg, d: DecisionRow) {
  if (d.autoResolved) { a.autoResolved++; return; }
  if (d.infraError) { a.infraErrors++; return; }
  if (d.attempt) a.reasks++; else a.decisions++;
  a.invalidAttempts += d.invalidAttempts; if (d.fallback) a.fallbacks++; if (d.forfeit || d.timedOut) a.forfeits++;
  if (d.modelCalls > 0) a.latencies.push(d.latencyMs);
  for (const [k, v] of Object.entries(d.toolCalls ?? {})) a.tools[k] = (a.tools[k] ?? 0) + v;
}

/**
 * Tokens and cost come from call rows (usage.jsonl), which include the calls of a decision that ended in an
 * infrastructure error: that decision throws before its decision row is written.
 */
function addCall(a: Agg, c: CallRow, pricing: Record<string, Pricing>) {
  a.modelCalls++; if (c.truncated) a.truncated++;
  a.inputTokens += c.inputTokens; a.outputTokens += c.outputTokens;
  a.cacheReadTokens += c.cacheReadTokens; a.cacheWriteTokens += c.cacheWriteTokens; a.reasoningTokens += c.reasoningTokens;
  a.reportedCost += c.reportedCostUsd ?? 0; a.costReportedCalls += c.costReportedCalls ?? 0;
  const cost = costOf(c, pricing[c.model]);
  a.cost = a.cost === null || cost === null ? null : a.cost + cost;
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

/**
 * Bot anchors whose version differs between runs, and runs on different cubes: a bot's rating depends on both
 * (MB-002), so pooling them mixes two rating scales. One line per difference; empty when the runs agree. Runs from
 * before anchors were recorded count as "unrecorded".
 */
export function anchorDifferences(runDirs: string[]): string[] {
  const versions = new Map<string, Map<string, string[]>>(); // provider -> version -> runs
  const cubes = new Map<string, string[]>();
  const note = <K>(m: Map<K, string[]>, k: K, run: string) => { if (!m.get(k)?.includes(run)) m.set(k, [...(m.get(k) ?? []), run]); };
  for (const d of runDirs) {
    const run = path.basename(d);
    const start = readJsonl(path.join(d, "events.jsonl")).find((e) => e.type === "run_start");
    const f = path.join(d, "config.json");
    const cfg = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : undefined;
    note(cubes, start?.cube ?? cfg?.event?.cube ?? "unknown", run);
    const anchors: Record<string, string> = start?.anchors ?? {};
    for (const s of (cfg?.seats ?? []) as { id: string; provider: string }[]) {
      if (!BOT_VERSIONS[s.provider]) continue;
      if (start?.headToHead && !start.seats?.includes(s.id)) continue;
      if (!versions.has(s.provider)) versions.set(s.provider, new Map());
      note(versions.get(s.provider)!, anchors[s.id] ?? `${s.provider}@unrecorded`, run);
    }
  }
  const list = (m: Map<string, string[]>) => [...m.entries()].map(([v, runs]) => `${v} (${runs.join(", ")})`).join("; ");
  const out = [...versions.entries()].filter(([, m]) => m.size > 1).map(([p, m]) => `${p}: ${list(m)}`);
  if (cubes.size > 1) out.push(`cube: ${list(cubes)}`);
  return out;
}

export function summarize(runDirs: string[], cfg?: BenchConfig, opts: { maxFailureRate?: number } = {}) {
  const decisions: DecisionRow[] = runDirs.flatMap((d) => readJsonl(path.join(d, "decisions.jsonl")));
  const calls: CallRow[] = runDirs.flatMap((d) => readJsonl(path.join(d, "usage.jsonl")));
  const matches: MatchResult[] = readMatches(runDirs);
  const pricing: Record<string, Pricing> = { ...(cfg?.pricing ?? {}) };
  let maxFailureRate = opts.maxFailureRate ?? cfg?.event.maxFailureRate;
  for (const d of runDirs) {
    const f = path.join(d, "config.json");
    if (!fs.existsSync(f)) continue;
    const runCfg = JSON.parse(fs.readFileSync(f, "utf8"));
    Object.assign(pricing, { ...runCfg.pricing, ...pricing });
    maxFailureRate ??= runCfg.event?.maxFailureRate;
  }
  maxFailureRate ??= 0.05;

  // A run that stopped early has no run_end, and a pod it was playing no pod_end.
  const incomplete: string[] = [];
  const versions: { run: string; provenance?: Provenance; anchors?: Record<string, string>; configHash?: string }[] = [];
  for (const d of runDirs) {
    const events = readJsonl(path.join(d, "events.jsonl"));
    const start = events.find((e) => e.type === "run_start");
    versions.push({ run: path.basename(d), provenance: start?.provenance, anchors: start?.anchors, configHash: start?.configHash });
    if (!events.some((e) => e.type === "run_end")) incomplete.push(`${path.basename(d)}: no run_end`);
    const ended = new Set(events.filter((e) => e.type === "pod_end").map((e) => e.pod));
    for (const e of events) if (e.type === "pod_start" && !ended.has(e.pod)) incomplete.push(`${path.basename(d)}: pod ${e.pod} has no pod_end`);
  }

  const bySeat = new Map<string, Agg & { model: string; provider: string }>();
  const bySeatPhase = new Map<string, Agg>();
  const byKind = new Map<string, Agg>();
  const aggs = (r: DecisionRecord | CallRecord) => {
    if (!bySeat.has(r.seat)) bySeat.set(r.seat, { ...newAgg(), model: r.model, provider: r.provider });
    const sp = `${r.seat}|${r.phase}`;
    if (!bySeatPhase.has(sp)) bySeatPhase.set(sp, newAgg());
    const out: Agg[] = [bySeat.get(r.seat)!, bySeatPhase.get(sp)!];
    if (r.provider && !["random", "rank-bot", "forge-ai"].includes(r.provider)) {
      if (!byKind.has(r.kind)) byKind.set(r.kind, newAgg());
      out.push(byKind.get(r.kind)!);
    }
    return out;
  };
  for (const d of decisions) for (const a of aggs(d)) addDecision(a, d);
  for (const c of calls) for (const a of aggs(c)) addCall(a, c, pricing);
  for (const c of calls) if (c.error) bySeat.get(c.seat)!.apiErrors++;
  // Calls whose decision never got a row (it ended in an infrastructure error): counted above, listed in the report.
  const recorded = new Set(decisions.map((d) => `${d.runId}|${d.seat}|${d.requestId}`));
  const unrecorded = new Map<string, number>();
  for (const c of calls) if (!recorded.has(`${c.runId}|${c.seat}|${c.requestId}`)) unrecorded.set(c.seat, (unrecorded.get(c.seat) ?? 0) + 1);

  // Calls (and decisions) that broke the seat's pinned spec (reasoning regime, host): the seat didn't run as configured.
  const specViolations = new Map<string, { calls: number; decisions: number; what: Map<string, number> }>();
  for (const [rows, field] of [[calls, "calls"], [decisions, "decisions"]] as const) for (const r of rows) {
    if (!r.specViolation) continue;
    const v = specViolations.get(r.seat) ?? { calls: 0, decisions: 0, what: new Map() };
    v[field]++;
    const what = typeof r.specViolation === "string" ? r.specViolation : JSON.stringify(r.specViolation);
    v.what.set(what, (v.what.get(what) ?? 0) + 1);
    specViolations.set(r.seat, v);
  }

  const outcomes = outcomesFromMatches(matches);
  const ratings = rate(outcomes, { bootstrap: 500 });
  const byPod = podRatings(outcomes);
  const cappedDraws = cappedDrawsBySeat(matches);
  const loopDraws = loopDrawsBySeat(matches);
  const censored = censoredBySeat(matches);
  // Matches skipped because a seat was over its budget: per seat that went over (why) and per seat that lost the match.
  const overBudget = new Map<string, string>();
  const notPlayed = new Map<string, number>();
  for (const m of matches) if (m.notPlayed) {
    overBudget.set(m.notPlayed.seat, m.notPlayed.reason);
    for (const seat of m.seats) notPlayed.set(seat, (notPlayed.get(seat) ?? 0) + 1);
  }
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
  for (const d of decisions) if (d.forfeit || d.timedOut) bump(d.seat, `${d.kind} (${d.timedOut ? "timed out" : "no valid answer"})`);
  for (const m of matches) for (const f of m.forfeits ?? []) bump(m.seats[f.seat], `${f.what} (${f.reason.replace(/ in \d+ attempts.*/, "")})`);

  // Exclusion rule: a seat whose decisions it didn't make as configured (forfeits, harness and bridge; fallbacks; and
  // decisions that ended in a provider failure after all retries) exceed maxFailureRate of its decisions is listed apart
  // from the leaderboard, numbers kept. Failed provider attempts that a retry recovered (API errors) never affected a
  // decision, so they don't count (MB-057).
  const excluded = new Map<string, { rate: number; forfeits: number; fallbacks: number; providerFailures: number; apiErrors: number; decisions: number }>();
  for (const [seat, a] of bySeat) {
    const forfeits = [...(forfeited.get(seat)?.values() ?? [])].reduce((x, y) => x + y, 0);
    const decided = a.decisions + a.infraErrors;
    const rate = decided ? (forfeits + a.fallbacks + a.infraErrors) / decided : 0;
    if (rate > maxFailureRate) excluded.set(seat, { rate, forfeits, fallbacks: a.fallbacks, providerFailures: a.infraErrors, apiErrors: a.apiErrors, decisions: decided });
  }

  // Who decided each in-game decision (docs/DECISION-PROVENANCE.md): the agent, forced (one legal action),
  // policy (a configured rule), delegated (Forge's AI or a default), forfeit (the agent failed).
  const provenance = new Map<string, { agent: number; forced: Map<string, number>; policy: Map<string, number>; delegated: Map<string, number>; forfeit: Map<string, number> }>();
  const prov = (seat: string) => {
    if (!provenance.has(seat)) provenance.set(seat, { agent: 0, forced: new Map(), policy: new Map(), delegated: new Map(), forfeit: new Map() });
    return provenance.get(seat)!;
  };
  const add = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
  for (const d of decisions) {
    // In-game steps only: match notes are written between games (runs before their own phase logged them as "game").
    // An infrastructure error abandoned the match: nobody decided. A re-ask (attempt > 0) is the same step again.
    if (d.phase !== "game" || d.kind === "match_notes" || d.infraError) continue;
    const p = prov(d.seat);
    if (d.autoResolved) add(p.forced, `${d.kind}: only one option`);
    else if (d.forfeit || d.timedOut) add(p.forfeit, `${d.kind}: ${d.timedOut ? "timed out" : "no valid answer"}`);
    else if (!d.fallback && !d.attempt) p.agent++;
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
  // Things the bridge worked around without breaking a decision (a card text Forge couldn't render...), by message.
  const warnings = new Map<string, number>();
  for (const m of matches) for (const w of m.warnings ?? []) warnings.set(w.msg, (warnings.get(w.msg) ?? 0) + w.count);

  return { incomplete, versions, specViolations, decisions, calls, unrecorded, matches, bySeat, bySeatPhase, byKind, ratings, byPod, merged: runDirs.length > 1, excluded, maxFailureRate, cappedDraws, loopDraws, censored, overBudget, notPlayed, games, reasons, delegated, forfeited, provenance, engineErrors, matchesWithEngineErrors, warnings, playWinRate: decided.length ? playWins / decided.length : null, pricing };
}

export function renderReport(s: ReturnType<typeof summarize>, title: string): string {
  const L: string[] = [];
  L.push(`# ${title}`, "");
  if (s.incomplete.length) L.push(`**INCOMPLETE**: the run stopped before it finished (${s.incomplete.join("; ")}). Standings and ratings cover only the matches that were played.`, "");
  if (s.specViolations.size) {
    L.push("**SPEC VIOLATIONS**: these seats made calls outside their pinned spec (reasoning regime or host), so their results don't measure the configured setup:", "");
    for (const [seat, v] of [...s.specViolations.entries()].sort()) {
      L.push(`- ${seat}: ${v.calls} call(s), ${v.decisions} decision(s): ${[...v.what.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} (${n})`).join("; ")}`);
    }
    L.push("");
  }
  // Answered calls per seat and host (failed attempts can name a host too, but nobody was served).
  const hosts = new Map<string, Map<string, number>>();
  for (const c of s.calls) if (c.servedBy && !c.error) {
    const m = hosts.get(c.seat) ?? new Map<string, number>(); m.set(c.servedBy, (m.get(c.servedBy) ?? 0) + 1); hosts.set(c.seat, m);
  }
  const multiHost = [...hosts.entries()].filter(([, m]) => m.size > 1).sort();
  if (multiHost.length) {
    L.push("**SERVED BY MORE THAN ONE HOST**: these seats' answers came from several hosts (backup hosts after the primary failed, `backupProviders`, or an unpinned route). Hosts serve the same model but may differ in quantisation, latency and failures, so read these seats' results with that in mind:", "");
    for (const [seat, m] of multiHost) L.push(`- ${seat}: ${[...m.entries()].sort((a, b) => b[1] - a[1]).map(([h, n]) => `${h} ${n}`).join(", ")} call(s)`);
    L.push("");
  }
  L.push(`Matches: ${s.matches.length} · Games: ${s.games.length} · Decisions: ${s.decisions.length} · Model calls: ${s.calls.length}`, "");

  const nPods = s.byPod.pods.length;
  L.push("## Ratings (Bradley-Terry, game level, Elo scale, 95% bootstrap CI)", "");
  L.push("| # | Seat | Rating | 95% CI | Games | Score |", "|---|---|---|---|---|---|");
  s.ratings.filter((r) => !s.excluded.has(r.id)).forEach((r, i) => L.push(`| ${i + 1} | ${r.id} | ${r.rating.toFixed(0)} | ${r.lo.toFixed(0)}–${r.hi.toFixed(0)} | ${r.games} | ${r.score.toFixed(1)} |`));
  if (s.excluded.size) {
    const pc = (x: number) => `${(100 * x).toFixed(1)}%`;
    L.push("", `**Excluded from the leaderboard**: forfeits + fallbacks + provider failures (decisions that ended in a provider error after all retries) above ${pc(s.maxFailureRate)} of the seat's decisions (\`event.maxFailureRate\`), so the seat often didn't play as configured. API errors that a retry recovered don't count; they are shown for information. Its games still count for its opponents' ratings; its numbers are kept here.`, "");
    L.push("| Seat | Rating | 95% CI | Games | Score | Failure rate | Forfeits | Fallbacks | Provider failures | Decisions | API errors (info) |", "|---|---|---|---|---|---|---|---|---|---|---|");
    for (const [seat, x] of [...s.excluded.entries()].sort((a, b) => b[1].rate - a[1].rate)) {
      const r = s.ratings.find((r) => r.id === seat);
      L.push(`| ${seat} | ${r ? r.rating.toFixed(0) : "–"} | ${r ? `${r.lo.toFixed(0)}–${r.hi.toFixed(0)}` : "–"} | ${r?.games ?? 0} | ${r ? r.score.toFixed(1) : "–"} | ${pc(x.rate)} | ${x.forfeits} | ${x.fallbacks} | ${x.providerFailures} | ${x.decisions} | ${x.apiErrors} |`);
    }
  }
  L.push("", nPods > 1
    ? `The bootstrap resamples the ${nPods} pods, then matches within each drawn pod: a seat plays one deck for a whole pod, so pods are the replication unit.`
    : "One pod: the bootstrap resamples matches within it, so the CI leaves out pod-to-pod variation (the deck a seat drafted); see docs/ANALYTICS.md before comparing seats.", "");
  if ([...s.bySeat.values()].some((a) => BOT_VERSIONS[a.provider])) {
    // The tags src/agents/bots.ts reads: keep this list in step with it.
    L.push("**Information asymmetry.** Bot seats get computed hints that LLM seats never see (by design: computed assessments stay out of prompts, HANDOFF §6 2026-10-01). "
      + "rank-bot reads, per option: `type`, `cmc` and `sorcerySpeedOk` (priority), `keep` (mulligan), `toughness` and `evasive` (attackers), `attackerPower`, `blockerSurvives` and `killsAttacker` (blockers), `hostile` (targets); "
      + "per question: `handLands` and `handSize` (mulligan), `opponentMaxUntappedPower` (attacks), `incomingLethal` (blocks), `api` and `copies` (yes/no questions about an optional effect). random reads none. "
      + "forge-ai's games are played by Forge's own AI, which makes its own evaluations of the game. Read bot-vs-LLM ratings with this in mind.", "");
  }
  if (nPods > 1) {
    L.push("### Ratings by pod", "", "Each pod fitted on its own. The SD across pods is how far a rating moves from one pod to the next; for identical bots it is the benchmark's noise floor.", "");
    L.push(`| Seat | ${s.byPod.pods.map((p) => podLabel(p, s.merged)).join(" | ")} | SD between pods |`, `|---|${s.byPod.pods.map(() => "---|").join("")}---|`);
    for (const r of s.ratings) {
      const rs = s.byPod.ratings.get(r.id) ?? [];
      L.push(`| ${r.id} | ${s.byPod.pods.map((_, i) => (rs[i] === undefined ? "–" : rs[i]!.toFixed(0))).join(" | ")} | ${s.byPod.sd.has(r.id) ? s.byPod.sd.get(r.id)!.toFixed(0) : "–"} |`);
    }
    L.push("");
  }
  if (s.censored.size) {
    const sum = (f: "matches" | "replayed") => [...s.censored.values()].reduce((a, c) => a + c[f], 0) / 2;
    const replays = s.matches.filter((m) => m.replayOf);
    L.push(`**Errored matches: ${sum("replayed")} replayed, ${sum("matches")} censored.** A match that errors for a reason other than a harness bug (provider error, match timeout, bridge crash) is played again from scratch with the same decks and seed at the end of the schedule (of its round when played by rounds) (${replays.filter((m) => !m.error).length} of ${replays.length} replay(s) completed). A match whose replay errors too, or that hit a harness bug, is censored: left out of the ratings and standings entirely, including the games it finished (policy in docs/ANALYTICS.md). Errors cut off long matches, so a seat with many censored matches may be rated on a biased sample.`, "");
    L.push("| Seat | Replayed | Censored matches | Finished games left out |", "|---|---|---|---|");
    for (const [seat, c] of [...s.censored.entries()].sort()) L.push(`| ${seat} | ${c.replayed} | ${c.matches} | ${c.games} |`);
    L.push("");
  }
  if (s.notPlayed.size) {
    L.push(`**Not played: ${s.matches.filter((m) => m.notPlayed).length} match(es)**, because a seat went over its budget (\`maxSpendUsd\` / \`maxP95LatencySec\`): ${[...s.overBudget.entries()].map(([seat, why]) => `${seat} (${why})`).join("; ")}. A match not played has no result for either seat (no forfeit) and isn't in the ratings or standings; an over-budget seat's later draft picks and decks are rank-bot fallbacks.`, "");
    L.push("| Seat | Matches not played |", "|---|---|");
    for (const [seat, n] of [...s.notPlayed.entries()].sort()) L.push(`| ${seat} | ${n} |`);
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
    ...(s.unrecorded.size ? [`Includes ${[...s.unrecorded.entries()].map(([seat, n]) => `${seat}: ${n}`).join(", ")} model call(s) whose decision ended in an infrastructure error and has no decision row.`, ""] : []),
    "Computed cost is tokens × the config's `pricing`. Reported cost is what the provider says it charged (OpenRouter returns it per call); when they differ, trust the reported figure and fix `pricing` or pin the host.", "");
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
  L.push("| Seat | Invalid answers | Forfeits (rate) | Re-asks | Fallbacks (rate) | API errors (attempts) | Truncated calls (rate) | Provider-failure decisions | Tool calls |", "|---|---|---|---|---|---|---|---|---|");
  for (const [seat, a] of [...s.bySeat.entries()].sort()) {
    const tools = Object.entries(a.tools).filter(([n]) => n !== "submit_decision" && n !== "submit_brief").map(([n, v]) => `${n}: ${v}`).join(", ") || "–";
    const rate = (n: number, of = a.decisions) => `${n} (${of ? ((100 * n) / of).toFixed(1) : 0}%)`;
    L.push(`| ${seat} | ${a.invalidAttempts} | ${rate(a.forfeits)} | ${a.reasks} | ${rate(a.fallbacks)} | ${a.apiErrors} | ${rate(a.truncated, a.modelCalls)} | ${a.infraErrors} | ${tools} |`);
  }
  L.push("", "Re-asks are the bridge asking the same in-game step again after an answer failed in-game; they aren't counted as decisions. API errors count failed provider attempts (HTTP errors, in-body errors, empty responses), most of which a retry recovered; information only. Truncated calls stopped at the output-token limit. Provider-failure decisions ended in a provider error after all retries: the match was abandoned (and replayed), so they aren't counted as the agent's play, but they do count towards the exclusion rule.", "");

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

  if (s.warnings.size) {
    L.push("## Bridge warnings", "", "Things the bridge worked around without breaking a decision, each counted once per game; that decision went ahead with less information.", "");
    L.push("| Games | Warning |", "|---|---|");
    for (const [k, v] of [...s.warnings.entries()].sort((a, b) => b[1] - a[1])) L.push(`| ${v} | ${k} |`);
    L.push("");
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
  const capped = [...s.cappedDraws.values()].reduce((a, b) => a + b, 0) / 2;
  L.push("", `Turn-cap draws: ${capped ? `${capped} game(s); by seat: ${[...s.cappedDraws.entries()].sort().map(([seat, n]) => `${seat} ${n}`).join(", ")}` : "none"}. A drawn game counts half a win for each seat in the ratings.`);
  const looped = [...s.loopDraws.values()].reduce((a, b) => a + b, 0) / 2;
  L.push("", `Unbreakable-loop draws: ${looped ? `${looped} game(s); by seat: ${[...s.loopDraws.entries()].sort().map(([seat, n]) => `${seat} ${n}`).join(", ")}` : "none"}. The bridge draws a game whose state recurs unchanged 20 times in one turn (docs/DECISION-PROVENANCE.md); counted like a turn-cap draw.`);
  const errs = s.matches.filter((m) => m.error);
  if (errs.length) L.push("", `**${errs.length} match(es) failed:** ${errs.slice(0, 5).map((m) => `${m.matchId}: ${m.error}`).join("; ")}`);

  L.push("", "## Versions", "");
  for (const v of s.versions) {
    const anchors = [...new Set(Object.values(v.anchors ?? {}))].sort().join(", ");
    L.push(`- ${s.versions.length > 1 ? `${v.run}: ` : ""}${v.provenance ? describeProvenance(v.provenance) : "not recorded (run predates version provenance)"}${anchors ? ` · anchors ${anchors}` : ""}${v.configHash ? ` · config hash ${v.configHash.slice(0, 12)}` : ""}`);
  }
  return L.join("\n") + "\n";
}

export function writeReport(runDir: string, cfg?: BenchConfig) {
  const s = summarize([runDir], cfg);
  fs.writeFileSync(path.join(runDir, "report.md"), renderReport(s, `Run ${path.basename(runDir)}`));
  const json = {
    incomplete: s.incomplete.length ? s.incomplete : undefined,
    specViolations: s.specViolations.size ? Object.fromEntries([...s.specViolations.entries()].map(([k, v]) => [k, { ...v, what: Object.fromEntries(v.what) }])) : undefined,
    versions: s.versions,
    ratings: s.ratings,
    podRatings: s.byPod.pods.length > 1 ? { pods: s.byPod.pods.map((p) => podLabel(p, s.merged)), ratings: Object.fromEntries(s.byPod.ratings), sdBetweenPods: Object.fromEntries(s.byPod.sd) } : undefined,
    excluded: s.excluded.size ? { maxFailureRate: s.maxFailureRate, seats: Object.fromEntries(s.excluded) } : undefined,
    cappedDraws: Object.fromEntries(s.cappedDraws),
    loopDraws: Object.fromEntries(s.loopDraws),
    overBudget: s.overBudget.size ? Object.fromEntries(s.overBudget) : undefined,
    notPlayed: s.notPlayed.size ? Object.fromEntries(s.notPlayed) : undefined,
    censored: Object.fromEntries(s.censored),
    seats: Object.fromEntries([...s.bySeat.entries()].map(([id, a]) => [id, { ...a, latencies: undefined, p50LatencyMs: pct(a.latencies, 0.5), p95LatencyMs: pct(a.latencies, 0.95) }])),
    games: s.games.length, reasons: s.reasons, playWinRate: s.playWinRate,
    delegated: Object.fromEntries([...s.delegated.entries()].map(([k, m]) => [k, Object.fromEntries(m)])),
    forfeited: Object.fromEntries([...s.forfeited.entries()].map(([k, m]) => [k, Object.fromEntries(m)])),
    engineErrors: { matches: s.matchesWithEngineErrors, byKind: Object.fromEntries(s.engineErrors) },
    warnings: s.warnings.size ? Object.fromEntries(s.warnings) : undefined,
    provenance: Object.fromEntries([...s.provenance.entries()].map(([k, p]) => [k, { agent: p.agent, forced: Object.fromEntries(p.forced), policy: Object.fromEntries(p.policy), delegated: Object.fromEntries(p.delegated), forfeit: Object.fromEntries(p.forfeit) }])),
  };
  fs.writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(json, null, 2));
}
