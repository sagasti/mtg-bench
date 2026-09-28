/**
 * Analytics. Two record streams per run:
 *   usage.jsonl      one row per model API call (tokens, cache, reasoning, latency, stop reason)
 *   decisions.jsonl  one row per decision (kind, options, choice, validity, retries, tool calls, tokens rolled up)
 * The report command (src/analytics/report.ts) aggregates both by seat / model / phase / decision kind.
 */
import path from "node:path";
import { Jsonl } from "../util/log.ts";
import type { DecisionKind, Phase } from "../types.ts";

export interface TokenUsage {
  inputTokens: number;        // uncached prompt tokens billed at the input rate
  outputTokens: number;       // includes reasoning tokens where the provider folds them in
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;    // reported separately when the provider exposes it (subset of output)
}

export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export interface CallRecord extends TokenUsage {
  ts: string;
  runId: string;
  pod: number;
  seat: string;
  provider: string;
  model: string;
  phase: Phase;
  kind: DecisionKind;
  requestId: string;
  matchId?: string;
  game?: number;
  turn: number;              // round-trip index within this decision (0 = first call)
  latencyMs: number;
  stopReason?: string;
  httpStatus?: number;
  error?: string;
  toolCallsRequested: number;
}

export interface DecisionRecord extends TokenUsage {
  ts: string;
  runId: string;
  pod: number;
  seat: string;
  provider: string;
  model: string;
  phase: Phase;
  kind: DecisionKind;
  requestId: string;
  matchId?: string;
  game?: number;
  numOptions: number;
  choice: string[];
  choiceLabels: string[];
  valid: boolean;            // final answer passed validation (false => fallback used)
  invalidAttempts: number;   // answers rejected by validation before the final one
  fallback: boolean;         // harness had to substitute a legal choice
  autoResolved: boolean;     // only one legal option; no model call made
  modelCalls: number;
  toolCalls: Record<string, number>;
  latencyMs: number;
  rationale?: string;
  error?: string;
}

export class Recorder {
  readonly usage: Jsonl;
  readonly decisions: Jsonl;
  readonly events: Jsonl;
  constructor(readonly runDir: string, readonly runId: string) {
    this.usage = new Jsonl(path.join(runDir, "usage.jsonl"));
    this.decisions = new Jsonl(path.join(runDir, "decisions.jsonl"));
    this.events = new Jsonl(path.join(runDir, "events.jsonl"));
  }
  call(r: Omit<CallRecord, "ts" | "runId">) { this.usage.write({ ts: new Date().toISOString(), runId: this.runId, ...r }); }
  decision(r: Omit<DecisionRecord, "ts" | "runId">) { this.decisions.write({ ts: new Date().toISOString(), runId: this.runId, ...r }); }
  event(type: string, data: Record<string, unknown>) { this.events.write({ ts: new Date().toISOString(), runId: this.runId, type, ...data }); }
  close() { this.usage.close(); this.decisions.close(); this.events.close(); }
}
