import type { TokenUsage } from "../../analytics/recorder.ts";
import type { ToolDef } from "../../knowledge/tools.ts";

export interface ToolCall { id: string; name: string; input: any }

/** Provider-neutral conversation format used by the LLM agent loop. */
export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: "tool"; results: { id: string; content: string; isError?: boolean }[] };

export interface ModelTurn {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  stopReason?: string;
  httpStatus?: number;
  /** Upstream host that served the call, when a gateway reports it. */
  servedBy?: string;
  /** Provider-native assistant message, replayed verbatim on the next turn (keeps thinking signatures etc). */
  raw?: unknown;
}

export interface CompleteArgs {
  system: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  signal?: AbortSignal;
  /** The agent's decision clock: provider retries pause it and give back the time of failed attempts. */
  clock?: Pausable;
  /** Told about every failed attempt the provider layer retries (recorded as an API error). */
  onRetry?: (r: RetryInfo) => void;
  /** Overrides the seat's output cap for this call (a retry after a truncated answer). */
  maxTokens?: number;
  /** Offline providers (echo) may peek at the request; real providers must ignore it. */
  debug?: { optionIds: string[]; min: number; max: number; kind: string };
}

export interface RetryInfo { error: string; status?: number; latencyMs: number; waitMs: number }

export interface Pausable { pause(refundMs?: number): void; resume(): void }

export interface Provider {
  readonly name: string;
  readonly model: string;
  complete(args: CompleteArgs): Promise<ModelTurn>;
}

export class ProviderError extends Error {
  constructor(msg: string, readonly status?: number, readonly retryable = false) { super(msg); }
}

export interface PostOptions {
  signal?: AbortSignal;
  clock?: Pausable;
  onRetry?: (r: RetryInfo) => void;
  /** Returns an error message when an HTTP 200 body is really a provider failure; it's retried like a 5xx. */
  bodyError?: (json: any) => string | undefined;
}

/**
 * fetch with retry on 429 / 5xx / network errors / in-body provider errors, honouring Retry-After (capped at 60 s).
 * Provider time isn't the agent's: the clock is paused while backing off and refunded the failed attempt's duration.
 */
export async function postJson(url: string, body: unknown, headers: Record<string, string>, opts: PostOptions = {}): Promise<{ status: number; json: any }> {
  const { signal, clock, onRetry, bodyError } = opts;
  let delay = 2000;
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    let failure: { error: string; status?: number; retryable: boolean; waitMs: number };
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
      const text = await res.text();
      if (res.ok) {
        let json: any;
        try { json = JSON.parse(text); } catch { throw new ProviderError(`invalid JSON from provider: ${text.slice(0, 300)}`, res.status); }
        const err = bodyError?.(json);
        if (!err) return { status: res.status, json };
        failure = { error: `provider error in HTTP ${res.status} body: ${err}`, status: res.status, retryable: true, waitMs: delay };
      } else {
        const ra = Number(res.headers.get("retry-after"));
        failure = {
          error: `HTTP ${res.status}: ${text.slice(0, 500)}`, status: res.status,
          retryable: res.status === 429 || res.status === 408 || res.status === 529 || res.status >= 500,
          waitMs: Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60000) : delay,
        };
      }
    } catch (e: any) {
      if (e instanceof ProviderError) throw e;
      if (signal?.aborted) throw new ProviderError(`aborted: ${signal.reason?.message ?? signal.reason ?? e?.message ?? e}`);
      failure = { error: `network error: ${e?.message ?? e}`, retryable: true, waitMs: delay };
    }
    if (!failure.retryable || attempt >= 6) throw new ProviderError(failure.error, failure.status, failure.retryable);
    onRetry?.({ error: failure.error, status: failure.status, latencyMs: Date.now() - t0, waitMs: failure.waitMs });
    clock?.pause(Date.now() - t0);
    try { await sleep(failure.waitMs, signal); } finally { clock?.resume(); }
    if (signal?.aborted) throw new ProviderError(`aborted: ${signal.reason?.message ?? signal.reason}`);
    delay = Math.min(delay * 2, 60000);
  }
}

/** Resolves after `ms`, or early when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => { signal?.removeEventListener("abort", done); resolve(); }, ms);
    const done = () => { clearTimeout(t); resolve(); };
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * A decision's time budget, like a chess clock: its signal aborts the model call in flight when the budget is used
 * up. The provider layer pauses it while it backs off and refunds failed attempts, so only the model's time counts.
 */
export class DecisionClock implements Pausable {
  private ctrl = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private deadline = 0;
  private left: number;
  constructor(readonly budgetMs: number) { this.left = budgetMs; this.resume(); }
  get signal() { return this.ctrl.signal; }
  get expired() { return this.ctrl.signal.aborted; }
  pause(refundMs = 0) {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; this.left = this.deadline - Date.now(); }
    this.left += refundMs;
  }
  resume() {
    if (this.timer || this.expired) return;
    this.deadline = Date.now() + this.left;
    this.timer = setTimeout(() => this.ctrl.abort(new Error(`time budget of ${Math.round(this.budgetMs / 1000)}s used up`)), Math.max(0, this.left));
  }
  stop() { this.pause(); }
}
