import path from "node:path";
import type { MatchResult } from "../engine/types.ts";
import { readJsonl } from "../util/log.ts";
import type { Outcome } from "./bt.ts";

/**
 * A match that ended in an error (timeout, bridge crash, provider outage) is censored: it contributes nothing at
 * either level, including the games it finished, because errors cut off long matches non-randomly (docs/ANALYTICS.md).
 * Bootstrap clusters are run + match, since match ids repeat across runs with the same seats; pods are run + pod index.
 * A drawn game (turn cap) or drawn match scores 0.5 for each seat.
 */
export function outcomesFromMatches(matches: MatchResult[], level: "game" | "match" = "game"): Outcome[] {
  const out: Outcome[] = [];
  for (const m of matches) {
    if (m.error) continue;
    const cluster = `${m.runId ?? ""}/${m.matchId}`;
    const pod = podKey(m);
    if (level === "match") {
      out.push({ a: m.seats[0], b: m.seats[1], scoreA: m.winner === 0 ? 1 : m.winner === 1 ? 0 : 0.5, cluster, pod });
    } else {
      for (const g of m.games) {
        if (g.reason.startsWith("error")) continue;
        out.push({ a: m.seats[0], b: m.seats[1], scoreA: g.winner === 0 ? 1 : g.winner === 1 ? 0 : 0.5, cluster, pod });
      }
    }
  }
  return out;
}

/** A pod is run + pod index; `podLabel` turns the key back into "pod N" (prefixed by the run's dir name when merged). */
export const podKey = (m: MatchResult) => `${m.runId ?? ""}#${m.pod}`;
export function podLabel(key: string, merged: boolean): string {
  const i = key.lastIndexOf("#");
  return `${merged ? `${path.basename(key.slice(0, i))} ` : ""}pod ${key.slice(i + 1)}`;
}

/** Games that ended at the turn cap (a draw), per seat: the bridge's "Draw (turn cap of N turns)", the mock's "turn-cap". */
export function cappedDrawsBySeat(matches: MatchResult[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of matches) for (const g of m.games) {
    if (g.winner !== null || !/turn.cap/i.test(g.reason)) continue;
    for (const seat of m.seats) out.set(seat, (out.get(seat) ?? 0) + 1);
  }
  return out;
}

/**
 * Per seat: censored matches (errored with no replay, or whose replay errored too: counted once), the finished games
 * of those that the ratings leave out, and errored matches that were replayed (whatever the replay's outcome).
 */
export function censoredBySeat(matches: MatchResult[]): Map<string, { matches: number; games: number; replayed: number }> {
  const replayed = new Set(matches.filter((m) => m.replayOf).map((m) => `${m.runId ?? ""}/${m.replayOf}`));
  const out = new Map<string, { matches: number; games: number; replayed: number }>();
  for (const m of matches) {
    if (!m.error) continue;
    for (const seat of m.seats) {
      const c = out.get(seat) ?? { matches: 0, games: 0, replayed: 0 };
      if (replayed.has(`${m.runId ?? ""}/${m.matchId}`)) c.replayed++;
      else { c.matches++; c.games += m.games.length; }
      out.set(seat, c);
    }
  }
  return out;
}

/** matches.jsonl of several runs, each row tagged with its run dir so bootstrap clusters stay distinct. */
export function readMatches(runDirs: string[]): MatchResult[] {
  return runDirs.flatMap((d) => readJsonl<MatchResult>(path.join(d, "matches.jsonl")).map((m) => ({ ...m, runId: path.resolve(d) })));
}
