/**
 * Seat = one of the 8 agent slots. Wraps any DecisionAgent (LLM or bot) with
 * the parts that must be identical for everyone: auto-resolving forced
 * choices, validation, fallback on failure, notes carry-over, and analytics.
 */
import { type TokenUsage, ZERO_USAGE, type Recorder } from "../analytics/recorder.ts";
import type { SeatConfig } from "../config.ts";
import { type DecisionRequest, type DecisionResponse, type DecideContext, validateResponse } from "../types.ts";
import { debug } from "../util/log.ts";
import type { Bot } from "./bots.ts";

export interface AgentResult {
  response: DecisionResponse | null;
  usage: TokenUsage;
  modelCalls: number;
  toolCalls: Record<string, number>;
  invalidAttempts: number;
  error?: string;
}

export interface CallInfo {
  turn: number; latencyMs: number; usage: TokenUsage; stopReason?: string; httpStatus?: number; error?: string; toolCallsRequested: number;
}
export type CallObserver = (c: CallInfo) => void;

export interface DecisionAgent {
  readonly kind: string;
  readonly model?: string;
  decide(req: DecisionRequest, ctx: DecideContext, onCall: CallObserver): Promise<AgentResult>;
}

export class Seat {
  /** notes keyed by scope: "pod:<n>" for draft+deckbuild, "match:<id>" for games. */
  private notes = new Map<string, string>();
  /** This seat's own pre-draft cube strategy brief (null = none / study disabled / failed). */
  brief: string | null = null;
  constructor(
    readonly config: SeatConfig,
    readonly agent: DecisionAgent,
    private fallback: Bot,
    private recorder: Recorder,
  ) {}

  get id() { return this.config.id; }
  get provider() { return this.config.provider; }
  get model() { return this.agent.model ?? this.config.model ?? this.config.provider; }
  /** True when Forge's own AI should play this seat's games. */
  get usesForgeAi() { return this.config.provider === "forge-ai"; }
  get isLlm() { return typeof (this.agent as any).study === "function"; }

  /** Run cube study once; the brief is reused for every pod in this run. */
  async study(cubeCards: string[], pod: number): Promise<string | null> {
    if (!this.isLlm) return null;
    const base = { pod, seat: this.id, provider: this.provider, model: this.model, phase: "study" as const, kind: "cube_study" as const, requestId: `study-${this.id}` };
    const t0 = Date.now();
    const r = await (this.agent as any).study(cubeCards, (c: CallInfo) =>
      this.recorder.call({ ...base, ...c.usage, turn: c.turn, latencyMs: c.latencyMs, stopReason: c.stopReason, httpStatus: c.httpStatus, error: c.error, toolCallsRequested: c.toolCallsRequested }));
    this.recorder.decision({ ...base, ...r.usage, numOptions: 0, choice: [], choiceLabels: [], valid: !!r.brief, invalidAttempts: 0,
      fallback: !r.brief, autoResolved: false, modelCalls: r.modelCalls, toolCalls: r.toolCalls, latencyMs: Date.now() - t0, error: r.error });
    this.brief = r.brief;
    return r.brief;
  }

  async decide(req: DecisionRequest, ctx: DecideContext): Promise<DecisionResponse> {
    const scope = req.phase === "game" ? `match:${ctx.matchId}` : `pod:${ctx.pod}`;
    const base = {
      pod: ctx.pod, seat: this.id, provider: this.provider, model: this.model, phase: req.phase, kind: req.kind,
      requestId: req.requestId, matchId: ctx.matchId, game: ctx.game,
    };
    // Forced choice: exactly one legal answer -> don't spend tokens.
    const forced = forcedChoice(req);
    if (forced) {
      this.recorder.decision({ ...base, ...ZERO_USAGE, numOptions: req.options.length, choice: forced.choice, choiceLabels: labels(req, forced.choice),
        valid: true, invalidAttempts: 0, fallback: false, autoResolved: true, modelCalls: 0, toolCalls: {}, latencyMs: 0 });
      return forced;
    }
    const t0 = Date.now();
    let result: AgentResult;
    try {
      result = await this.agent.decide(req, { ...ctx, notes: this.notes.get(scope), brief: this.brief ?? undefined }, (c) =>
        this.recorder.call({ ...base, ...c.usage, turn: c.turn, latencyMs: c.latencyMs, stopReason: c.stopReason, httpStatus: c.httpStatus, error: c.error, toolCallsRequested: c.toolCallsRequested }));
    } catch (e: any) {
      result = { response: null, usage: ZERO_USAGE, modelCalls: 0, toolCalls: {}, invalidAttempts: 0, error: String(e?.message ?? e) };
    }
    let response = result.response;
    let fallback = false;
    if (!response || validateResponse(req, response)) {
      fallback = true;
      response = this.fallback.choose(req);
      debug(`[${this.id}] fallback on ${req.kind}: ${result.error}`);
    }
    if (response.notes !== undefined) this.notes.set(scope, response.notes);
    this.recorder.decision({
      ...base, ...result.usage, numOptions: req.options.length, choice: response.choice, choiceLabels: labels(req, response.choice),
      valid: !fallback, invalidAttempts: result.invalidAttempts, fallback, autoResolved: false, modelCalls: result.modelCalls,
      toolCalls: result.toolCalls, latencyMs: Date.now() - t0, rationale: response.rationale, error: fallback ? result.error : undefined,
    });
    return response;
  }

  /** Carry draft notes into deckbuilding explicitly (same scope already, kept for clarity). */
  clearScope(scope: string) { this.notes.delete(scope); }
}

function labels(req: DecisionRequest, ids: string[]) {
  const m = new Map(req.options.map((o) => [o.id, o.label]));
  return ids.map((i) => m.get(i) ?? i);
}

export function forcedChoice(req: DecisionRequest): DecisionResponse | null {
  if (req.kind === "deckbuild") return null;
  if (req.options.length === 0 && req.min === 0) return { choice: [] };
  if (req.min === req.options.length && req.max === req.options.length) return { choice: req.options.map((o) => o.id) };
  if (req.options.length === 1 && req.min === 1) return { choice: [req.options[0].id] };
  return null;
}
