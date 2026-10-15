/**
 * Game-engine abstraction. The tournament layer only knows this interface;
 * the Forge bridge and the mock engine both implement it. A new engine (XMage,
 * a custom sim) only has to turn its own decision points into DecisionRequests
 * and call `seat.decide`.
 */
import type { Seat } from "../agents/agent.ts";
import type { Deck } from "../deckbuild/deckbuild.ts";

export interface MatchSpec {
  matchId: string;
  pod: number;
  round: number;
  seats: [Seat, Seat];
  decks: [Deck, Deck];
  deckFiles: [string, string];   // .dck paths (used by Forge)
  gamesPerMatch: number;         // best-of-N
  seed: number;
  maxGameTurns: number;
  runDir: string;
  /** smart = ask only at meaningful priority stops; all = every time the agent gets priority. */
  priorityStops: "smart" | "all";
  /** smart = ask which lands to tap only when it can matter; always = every mana payment. */
  manaPayment: "smart" | "always";
  /** Re-asks after a failed answer before the decision is forfeited (event.maxRetries). */
  maxRetries: number;
  /** Pilot patch: odd rounds put seat 0 on the play, even rounds seat 1 (play_draw answered by policy, not by the agents). */
  playDrawAlternate?: boolean;
  /** Pilot patch: per seat, deck size and land count (for the mulligan section). */
  deckInfo?: [{ size: number; lands: number }, { size: number; lands: number }];
}

/** A decision Forge's AI made on an agent's behalf (answer missing/illegal, or a rare decision type). */
export interface Delegation { seat: 0 | 1; game: number; what: string; reason: string }

/** Actions the bridge took for a seat without asking its agent (docs/DECISION-PROVENANCE.md), counted per game. */
/** An exception Forge logged and carried on from ("== Report a crash =="): the game continued in a possibly corrupt state. */
export interface EngineError { game: number; kind: string; at: string }

export interface AutoAction { seat: 0 | 1; game: number; category: "forced" | "policy" | "delegated"; what: string; reason: string; count: number }

export interface GameResult {
  game: number;                  // 1-based
  winner: 0 | 1 | null;          // index into spec.seats; null = draw
  onThePlay: 0 | 1;
  turns: number;
  reason: string;                // "life", "decked", "poison", "concede", "turn-cap", "timeout", "error"...
  decisions: [number, number];   // decisions asked of each seat
  durationMs: number;
}

export interface MatchResult {
  matchId: string;
  pod: number;
  round: number;
  seats: [string, string];
  games: GameResult[];
  winner: 0 | 1 | null;
  delegations?: Delegation[];
  /** Decisions the bridge forfeited after the agent's answers kept failing in-game (e.g. lands that can't pay). */
  forfeits?: Delegation[];
  /** Forced and policy actions the bridge took without asking the agent. */
  auto?: AutoAction[];
  /** Exceptions Forge logged mid-game (the match still completed). Any count > 0 makes the match suspect. */
  engineErrors?: EngineError[];
  /** Things the bridge worked around without breaking a decision (e.g. a card text Forge couldn't render), by message. */
  warnings?: { msg: string; count: number }[];
  /** Set when the match was abandoned (timeout, bridge crash, provider outage); the match is then censored from standings and ratings. */
  error?: string;
  /** What kind of failure `error` is. Every kind but "harness" (a bug in our code) is replayed once (tournament/run.ts). */
  errorKind?: "infra" | "timeout" | "bridge" | "harness";
  /** This match replays the errored match with this id: same seats, decks and seed, played from scratch. */
  replayOf?: string;
  /** Not played because a seat was over its spend/latency budget (SeatConfig.maxSpendUsd): no games, no result for either seat. */
  notPlayed?: { seat: string; reason: string };
  /** The run the row was read from (set by readMatches), so matches of different runs never share a bootstrap cluster. */
  runId?: string;
}

export interface GameEngine {
  readonly name: string;
  playMatch(spec: MatchSpec): Promise<MatchResult>;
  close?(): Promise<void>;
}

/** An errored match worth one more try: a provider/infrastructure error, a match timeout or a bridge crash, not a harness bug. */
export const replayable = (m: MatchResult) => !!m.error && !!m.errorKind && m.errorKind !== "harness";

/** Best-of-N bookkeeping shared by engines. */
export function matchOver(games: GameResult[], bestOf: number): boolean {
  const need = Math.floor(bestOf / 2) + 1;
  const w0 = games.filter((g) => g.winner === 0).length;
  const w1 = games.filter((g) => g.winner === 1).length;
  return w0 >= need || w1 >= need || games.length >= bestOf + 2; // +2 cap guards endless draws
}

export function matchWinner(games: GameResult[]): 0 | 1 | null {
  const w0 = games.filter((g) => g.winner === 0).length;
  const w1 = games.filter((g) => g.winner === 1).length;
  return w0 > w1 ? 0 : w1 > w0 ? 1 : null;
}
