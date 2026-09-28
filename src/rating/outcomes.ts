import type { MatchResult } from "../engine/types.ts";
import type { Outcome } from "./bt.ts";

export function outcomesFromMatches(matches: MatchResult[], level: "game" | "match" = "game"): Outcome[] {
  const out: Outcome[] = [];
  for (const m of matches) {
    if (level === "match") {
      out.push({ a: m.seats[0], b: m.seats[1], scoreA: m.winner === 0 ? 1 : m.winner === 1 ? 0 : 0.5, cluster: m.matchId });
    } else {
      for (const g of m.games) {
        if (g.reason.startsWith("error")) continue;
        out.push({ a: m.seats[0], b: m.seats[1], scoreA: g.winner === 0 ? 1 : g.winner === 1 ? 0 : 0.5, cluster: m.matchId });
      }
    }
  }
  return out;
}
