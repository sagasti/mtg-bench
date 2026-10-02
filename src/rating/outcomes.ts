import path from "node:path";
import type { MatchResult } from "../engine/types.ts";
import { readJsonl } from "../util/log.ts";
import type { Outcome } from "./bt.ts";

/**
 * A match that ended in an error (timeout, bridge crash, provider outage) is censored: it contributes nothing at
 * either level, including the games it finished, because errors cut off long matches non-randomly (docs/ANALYTICS.md).
 * Bootstrap clusters are run + match, since match ids repeat across runs with the same seats.
 */
export function outcomesFromMatches(matches: MatchResult[], level: "game" | "match" = "game"): Outcome[] {
  const out: Outcome[] = [];
  for (const m of matches) {
    if (m.error) continue;
    const cluster = `${m.runId ?? ""}/${m.matchId}`;
    if (level === "match") {
      out.push({ a: m.seats[0], b: m.seats[1], scoreA: m.winner === 0 ? 1 : m.winner === 1 ? 0 : 0.5, cluster });
    } else {
      for (const g of m.games) {
        if (g.reason.startsWith("error")) continue;
        out.push({ a: m.seats[0], b: m.seats[1], scoreA: g.winner === 0 ? 1 : g.winner === 1 ? 0 : 0.5, cluster });
      }
    }
  }
  return out;
}

/** Errored matches per seat, and the finished games of those matches that the ratings leave out. */
export function censoredBySeat(matches: MatchResult[]): Map<string, { matches: number; games: number }> {
  const out = new Map<string, { matches: number; games: number }>();
  for (const m of matches) {
    if (!m.error) continue;
    for (const seat of m.seats) {
      const c = out.get(seat) ?? { matches: 0, games: 0 };
      c.matches++; c.games += m.games.length;
      out.set(seat, c);
    }
  }
  return out;
}

/** matches.jsonl of several runs, each row tagged with its run dir so bootstrap clusters stay distinct. */
export function readMatches(runDirs: string[]): MatchResult[] {
  return runDirs.flatMap((d) => readJsonl<MatchResult>(path.join(d, "matches.jsonl")).map((m) => ({ ...m, runId: path.resolve(d) })));
}
