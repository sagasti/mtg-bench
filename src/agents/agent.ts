/**
 * Seat = one of the 8 agent slots. Wraps any DecisionAgent (LLM or bot) with
 * the parts that must be identical for everyone: auto-resolving forced
 * choices, validation, fallback on failure, notes carry-over, and analytics.
 */
import { type CallRecord, costOf, type TokenUsage, ZERO_USAGE, type Recorder } from "../analytics/recorder.ts";
import type { EventConfig, Pricing, SeatConfig } from "../config.ts";
import { type DecisionRequest, type DecisionResponse, type DecideContext, validateResponse } from "../types.ts";
import { debug, info } from "../util/log.ts";
import type { Bot } from "./bots.ts";
import { type LlmAgent, type MatchNotesInput, type StudyResult } from "./llm.ts";
import { hasPrompt } from "./render.ts";

export interface AgentResult {
  response: DecisionResponse | null;
  /** The provider kept failing (HTTP/network/in-body errors) after retries: an infrastructure problem, not the agent's play. */
  infraError?: boolean;
  /** The decision's time budget ran out (model time only; provider backoff excluded): the agent's failure. */
  timedOut?: boolean;
  usage: TokenUsage;
  modelCalls: number;
  toolCalls: Record<string, number>;
  invalidAttempts: number;
  /** Model calls stopped by the output cap. */
  truncated?: number;
  /** First breach of the seat's reasoning/host spec (see checkSeatSpec). */
  specViolation?: string;
  error?: string;
}

export interface CallInfo {
  turn: number; latencyMs: number; usage: TokenUsage; stopReason?: string; httpStatus?: number; error?: string; toolCallsRequested: number; servedBy?: string;
  truncated?: boolean; timedOut?: boolean; specViolation?: string; nativeFinishReason?: string; providerError?: string;
}
export type CallObserver = (c: CallInfo) => void;

export interface DecisionAgent {
  readonly kind: string;
  readonly model?: string;
  decide(req: DecisionRequest, ctx: DecideContext, onCall: CallObserver): Promise<AgentResult>;
}

export class Seat {
  /** Scratchpad keyed by scope: "pod:<n>" for draft+deckbuild; per game ("game:<match>:<n>") once match notes exist, else "match:<id>". */
  private notes = new Map<string, string>();
  /** Match notes, by match id, written between games (prompt versions with between-games.md). */
  private matchNotes = new Map<string, string>();
  /** This seat's own pre-draft cube strategy brief (null = none / study disabled / failed). */
  brief: string | null = null;
  /** Computed cost so far and model-answered decision latencies, for the seat's budgets. */
  private spentUsd = 0;
  private latencies: number[] = [];
  /** Set once the seat goes over a budget; it stays stopped. */
  private stopped: string | null = null;
  constructor(
    readonly config: SeatConfig,
    readonly agent: DecisionAgent,
    private fallback: Bot,
    private recorder: Recorder,
    private event: EventConfig,
    private pricing: Record<string, Pricing> = {},
  ) {}

  get id() { return this.config.id; }
  get provider() { return this.config.provider; }
  get model() { return this.agent.model ?? this.config.model ?? this.config.provider; }
  /** True when Forge's own AI should play this seat's games. */
  get usesForgeAi() { return this.config.provider === "forge-ai"; }
  get isLlm() { return typeof (this.agent as any).study === "function"; }

  /**
   * Why the seat is over its spend or latency budget (SeatConfig.maxSpendUsd / maxP95LatencySec), or null. Sticky: the
   * first time it trips, a `seat_over_budget` event is recorded and the seat stays stopped for the rest of the run.
   */
  overBudget(): string | null {
    if (this.stopped) return this.stopped;
    const { maxSpendUsd, maxP95LatencySec } = this.config;
    let why: string | null = null;
    if (maxSpendUsd !== undefined && this.spentUsd >= maxSpendUsd) why = `spent $${this.spentUsd.toFixed(4)}, budget $${maxSpendUsd}`;
    else if (maxP95LatencySec !== undefined && this.latencies.length >= 20) {
      const p95 = [...this.latencies].sort((a, b) => a - b)[Math.floor(0.95 * this.latencies.length)] / 1000;
      if (p95 > maxP95LatencySec) why = `p95 decision latency ${p95.toFixed(1)}s over ${this.latencies.length} decisions, budget ${maxP95LatencySec}s`;
    }
    if (why) {
      this.stopped = why;
      this.recorder.event("seat_over_budget", { seat: this.id, reason: why, spentUsd: this.spentUsd });
      info(`${this.id} is over budget (${why}): its remaining matches won't be played`);
    }
    return why;
  }

  /** Run cube study once; the brief is reused for every pod in this run. */
  async study(cubeCards: string[], pod: number): Promise<string | null> {
    if (!this.isLlm) return null;
    const base = { pod, seat: this.id, provider: this.provider, model: this.model, phase: "study" as const, kind: "cube_study" as const, requestId: `study-${this.id}` };
    const t0 = Date.now();
    const r: StudyResult = await (this.agent as LlmAgent).study(cubeCards, (c) => this.recordCall(base, c));
    this.recorder.decision({ ...base, ...r.usage, numOptions: 0, choice: [], choiceLabels: [], valid: !!r.brief, invalidAttempts: 0,
      fallback: !r.brief, autoResolved: false, modelCalls: r.modelCalls, toolCalls: r.toolCalls, latencyMs: Date.now() - t0, ...outcome(r) });
    this.brief = r.brief;
    return r.brief;
  }

  /**
   * Between games of a match: an LLM seat rewrites its match notes from the game's public log. Only prompt versions
   * with between-games.md do this. A provider outage abandons the match; a seat that won't submit notes keeps its old ones.
   */
  async betweenGames(pod: number, matchId: string, input: MatchNotesInput): Promise<void> {
    if (!this.isLlm || !hasPrompt(this.event.promptVersion, "between-games.md")) return;
    // Its own phase: notes are written between games, so they aren't in-game decisions (docs/DECISION-PROVENANCE.md).
    const base = { pod, seat: this.id, provider: this.provider, model: this.model, phase: "between_games" as const, kind: "match_notes" as const,
      requestId: `${matchId}-g${input.game}-notes`, matchId, game: input.game };
    const t0 = Date.now();
    const r = await (this.agent as LlmAgent).writeMatchNotes({ ...input, previousNotes: this.matchNotes.get(matchId) }, this.brief ?? undefined,
      (c) => this.recordCall(base, c));
    this.recorder.decision({ ...base, ...r.usage, numOptions: 0, choice: [], choiceLabels: [], valid: !!r.notes, invalidAttempts: 0,
      fallback: false, forfeit: !r.notes && !r.infraError, autoResolved: false, modelCalls: r.modelCalls, toolCalls: r.toolCalls,
      latencyMs: Date.now() - t0, rationale: r.notes ?? undefined, ...outcome(r) });
    if (r.infraError) throw new InfraError(`${this.id}: ${r.error ?? "provider failed"}`);
    if (r.notes) this.matchNotes.set(matchId, r.notes);
  }

  async decide(req: DecisionRequest, ctx: DecideContext): Promise<DecisionResponse> {
    const perGame = req.phase === "game" && hasPrompt(this.event.promptVersion, "between-games.md");
    const scope = req.phase !== "game" ? `pod:${ctx.pod}` : perGame ? `game:${ctx.matchId}:${ctx.game}` : `match:${ctx.matchId}`;
    const base = {
      pod: ctx.pod, seat: this.id, provider: this.provider, model: this.model, phase: req.phase, kind: req.kind,
      requestId: req.requestId, matchId: ctx.matchId, game: ctx.game, ...(req.attempt ? { attempt: req.attempt } : {}),
    };
    // Forced choice: exactly one legal answer -> don't spend tokens.
    const forced = forcedChoice(req);
    if (forced) {
      this.recorder.decision({ ...base, ...ZERO_USAGE, numOptions: req.options.length, choice: forced.choice, choiceLabels: labels(req, forced.choice),
        valid: true, invalidAttempts: 0, fallback: false, autoResolved: true, modelCalls: 0, toolCalls: {}, latencyMs: 0 });
      return forced;
    }
    // A seat over budget plays no more matches; a later pod's draft picks and deck still need making, by rank-bot.
    const stopped = req.phase !== "game" && this.overBudget();
    if (stopped) {
      const response = this.fallback.choose(req);
      this.recorder.decision({ ...base, ...ZERO_USAGE, numOptions: req.options.length, choice: response.choice, choiceLabels: labels(req, response.choice),
        valid: false, invalidAttempts: 0, fallback: true, autoResolved: false, modelCalls: 0, toolCalls: {}, latencyMs: 0, error: `over budget: ${stopped}` });
      return response;
    }
    const t0 = Date.now();
    // Anything the agent throws is a harness error (rendering, templates, the leak guard...): it propagates and the
    // match is abandoned, rather than charged to the agent as a forfeit. Provider failures come back as infraError.
    const matchNotes = req.phase === "game" && ctx.matchId ? this.matchNotes.get(ctx.matchId) : undefined;
    const result = await this.agent.decide(req, { ...ctx, notes: this.notes.get(scope), matchNotes, brief: this.brief ?? undefined },
      (c) => this.recordCall(base, c));
    if (result.infraError) {
      // Recorded first, so the tokens spent before the failure reach the cost tables.
      this.recorder.decision({ ...base, ...result.usage, numOptions: req.options.length, choice: [], choiceLabels: [], valid: false,
        invalidAttempts: result.invalidAttempts, fallback: false, autoResolved: false, modelCalls: result.modelCalls, toolCalls: result.toolCalls,
        latencyMs: Date.now() - t0, ...outcome(result) });
      throw new InfraError(`${this.id}: ${result.error ?? "provider failed"}`);
    }
    let response = result.response;
    let fallback = false;
    let forfeit = false;
    if (!response || validateResponse(req, response)) {
      if (req.phase === "deckbuild") {
        // No strategy-free legal deck exists, so a failed build still uses rank-bot; reported as a fallback.
        fallback = true;
        response = this.fallback.choose(req);
        debug(`[${this.id}] fallback on ${req.kind}: ${result.error}`);
      } else {
        forfeit = true;
        response = forfeitChoice(req);
        debug(`[${this.id}] forfeit on ${req.kind}: ${result.error}`);
      }
    }
    if (response.notes !== undefined) this.notes.set(scope, response.notes);
    if (result.modelCalls > 0) this.latencies.push(Date.now() - t0);
    this.recorder.decision({
      ...base, ...result.usage, numOptions: req.options.length, choice: response.choice, choiceLabels: labels(req, response.choice),
      valid: !fallback && !forfeit, invalidAttempts: result.invalidAttempts, fallback, forfeit, autoResolved: false, modelCalls: result.modelCalls,
      toolCalls: result.toolCalls, latencyMs: Date.now() - t0, rationale: response.rationale, ...outcome(result, fallback || forfeit),
    });
    return response;
  }

  private recordCall(base: Pick<CallRecord, "pod" | "seat" | "provider" | "model" | "phase" | "kind" | "requestId" | "matchId" | "game">, c: CallInfo) {
    const { usage, ...rest } = c;
    this.recorder.call({ ...base, ...usage, ...rest });
    this.spentUsd += costOf(usage, this.pricing[base.model]) ?? 0;
  }

  /** Carry draft notes into deckbuilding explicitly (same scope already, kept for clarity). */
  clearScope(scope: string) { this.notes.delete(scope); }
  /** Scratchpad access for persisting a scope to disk and restoring it in a re-run. */
  getNotes(scope: string) { return this.notes.get(scope); }
  setNotes(scope: string, notes: string) { this.notes.set(scope, notes); }
}

/** The failure details a decision row carries (only the ones that are set). */
function outcome(r: Pick<AgentResult, "error" | "infraError" | "timedOut" | "truncated" | "specViolation">, failed = true) {
  return {
    ...(failed && r.error ? { error: r.error } : {}), ...(r.infraError ? { infraError: true } : {}), ...(r.timedOut ? { timedOut: true } : {}),
    ...(r.truncated ? { truncated: r.truncated } : {}), ...(r.specViolation ? { specViolation: r.specViolation } : {}),
  };
}

function labels(req: DecisionRequest, ids: string[]) {
  const m = new Map(req.options.map((o) => [o.id, o.label]));
  return ids.map((i) => m.get(i) ?? i);
}

/** The provider could not be reached; the match is abandoned rather than played on the agent's behalf. */
export class InfraError extends Error {}

/**
 * What a player who gives up on a decision gets: no help, no strategy. Pass priority when that's an option,
 * decline yes/no questions, choose nothing when nothing is allowed, otherwise the first legal option(s) in
 * the engine's order. The bridge turns a forfeit during casting into a cancelled cast.
 */
export function forfeitChoice(req: DecisionRequest): DecisionResponse {
  const pass = req.options.find((o) => o.meta?.type === "pass");
  if (pass) return { choice: [pass.id], forfeit: true };
  const no = req.options.find((o) => o.id === "no");
  if (no && req.min <= 1) return { choice: [no.id], forfeit: true };
  return { choice: req.options.slice(0, req.min).map((o) => o.id), forfeit: true };
}

export function forcedChoice(req: DecisionRequest): DecisionResponse | null {
  if (req.kind === "deckbuild") return null;
  if (req.options.length === 0 && req.min === 0) return { choice: [] };
  if (req.min === req.options.length && req.max === req.options.length) return { choice: req.options.map((o) => o.id) };
  if (req.options.length === 1 && req.min === 1) return { choice: [req.options[0].id] };
  return null;
}
