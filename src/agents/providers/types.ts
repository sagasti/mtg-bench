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
  /** The upstream model's own finish reason when a gateway reports it (OpenRouter `native_finish_reason`, e.g. Gemini's SAFETY). */
  nativeFinishReason?: string;
  /** An `error` object the provider attached to an otherwise successful answer (JSON, truncated). */
  providerError?: string;
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
  debug?: { optionIds: string[]; min: number; max: number; kind: string; proposal?: number };
}

/** What a failed provider attempt said about itself, beyond the message (recorded on its usage row). */
export interface FailureDetail {
  /** The upstream model's finish reason (OpenRouter `native_finish_reason`): tells a content filter from an outage. */
  nativeFinishReason?: string;
  /** The provider's `error` object, JSON, truncated. */
  providerError?: string;
  /** The host that failed, when the gateway names it. */
  servedBy?: string;
}

export interface RetryInfo extends FailureDetail { error: string; status?: number; latencyMs: number; waitMs: number }

export interface Pausable { pause(refundMs?: number): void; resume(): void }

export interface Provider {
  readonly name: string;
  readonly model: string;
  complete(args: CompleteArgs): Promise<ModelTurn>;
}

/** At most `n` calls in flight (SeatConfig.concurrency). Time spent queued isn't charged to the agent's clock. */
export function limitConcurrency(p: Provider, n: number): Provider {
  let active = 0;
  const queue: (() => void)[] = [];
  return {
    name: p.name,
    model: p.model,
    async complete(args) {
      if (active < n) active++;
      else {
        args.clock?.pause();
        await new Promise<void>((r) => queue.push(r)); // the releasing call hands its slot over
        args.clock?.resume();
      }
      try { return await p.complete(args); }
      finally { const next = queue.shift(); if (next) next(); else active--; }
    },
  };
}

export class ProviderError extends Error {
  constructor(msg: string, readonly status?: number, readonly retryable = false, readonly detail: FailureDetail = {}) { super(msg); }
}

/**
 * An HTTP 200 body that is really a provider failure (see PostOptions.bodyError). `transient`: the host says it is
 * unavailable or rate-limited, so it is waited out like a 503 (RetryPolicy.windowMs) rather than retried a few times.
 */
export interface BodyFailure extends FailureDetail { error: string; transient?: boolean }

/** The `error` object of a JSON error body, and the host it names (OpenRouter puts it in metadata.provider_name). */
export function errorDetail(json: any): FailureDetail {
  const err = json?.error;
  if (!err || typeof err !== "object") return {};
  const host = err.metadata?.provider_name;
  return { providerError: JSON.stringify(err).slice(0, 500), ...(typeof host === "string" ? { servedBy: host } : {}) };
}

/**
 * How long the provider layer keeps retrying (MB-054). Transient failures (429, 408, 5xx, 529, network errors, in-body
 * errors that say the host is unavailable or rate-limited) are retried with capped exponential backoff until `windowMs`
 * has passed since the call's first failure. Other retryable failures (an empty answer, an unrecognised in-body error)
 * may be deterministic, e.g. a content filter, so they get `maxAttempts` attempts only.
 */
export interface RetryPolicy {
  windowMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { windowMs: 20 * 60_000, maxAttempts: 7, baseDelayMs: 2000, maxDelayMs: 60_000 };

/**
 * A seat's hosts in order of preference: the primary, then backups (SeatConfig.backupProviders). A call starts on the
 * first host not cooling down and moves to the next one after `switchAfter` consecutive failures there; a host failed
 * over from is skipped by new calls for `cooldownMs`, then tried first again. Shared by all calls of a seat.
 */
export class HostRotation {
  private downUntil: number[];
  constructor(readonly labels: string[], readonly switchAfter = 2, readonly cooldownMs = 5 * 60_000) {
    this.downUntil = labels.map(() => 0);
  }
  first(): number {
    const now = Date.now();
    const i = this.downUntil.findIndex((t) => t <= now);
    return i < 0 ? 0 : i;
  }
  failOver(from: number): number {
    this.downUntil[from] = Date.now() + this.cooldownMs;
    return (from + 1) % this.labels.length;
  }
}

export interface PostOptions {
  signal?: AbortSignal;
  clock?: Pausable;
  onRetry?: (r: RetryInfo) => void;
  /** Says why an HTTP 200 body is really a provider failure, or undefined; it's retried like a 5xx. */
  bodyError?: (json: any) => BodyFailure | undefined;
  retry?: Partial<RetryPolicy>;
  /** Backup hosts: `bodyFor(i)` is the request body that routes to host i (0 = the primary, i.e. `body`). */
  hosts?: { rotation: HostRotation; bodyFor: (host: number) => unknown };
}

/** HTTP statuses worth waiting out: rate limits, timeouts, overload and server errors. */
export const transientStatus = (status: number) => status === 429 || status === 408 || status === 529 || status >= 500;

/**
 * fetch with retry on 429 / 5xx / network errors / in-body provider errors, honouring Retry-After (capped at the
 * maximum backoff), within the RetryPolicy, failing over to backup hosts when given. Provider time isn't the agent's:
 * the clock is paused while backing off and refunded the failed attempt's duration.
 */
export async function postJson(url: string, body: unknown, headers: Record<string, string>, opts: PostOptions = {}): Promise<{ status: number; json: any; host: number }> {
  const { signal, clock, onRetry, bodyError, hosts } = opts;
  const policy = { ...DEFAULT_RETRY, ...opts.retry };
  let delay = policy.baseDelayMs;
  let firstFailure: number | undefined;
  let capped = 0;
  let host = hosts?.rotation.first() ?? 0;
  let onHost = 0; // consecutive failures on this host
  const tried = new Set([host]);
  for (;;) {
    const t0 = Date.now();
    let failure: { error: string; status?: number; retryable: boolean; transient: boolean; waitMs: number; detail: FailureDetail };
    try {
      const payload = hosts ? hosts.bodyFor(host) : body;
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload), signal });
      const text = await res.text();
      if (res.ok) {
        let json: any;
        try { json = JSON.parse(text); } catch { throw new ProviderError(`invalid JSON from provider: ${text.slice(0, 300)}`, res.status); }
        const err = bodyError?.(json);
        if (!err) return { status: res.status, json, host };
        const { error, transient, ...detail } = err;
        failure = { error: `provider error in HTTP ${res.status} body: ${error}`, status: res.status, retryable: true, transient: !!transient, waitMs: delay, detail };
      } else {
        const ra = Number(res.headers.get("retry-after"));
        let json: any;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        const transient = transientStatus(res.status);
        failure = {
          error: `HTTP ${res.status}: ${text.slice(0, 500)}`, status: res.status, retryable: transient, transient,
          waitMs: Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, policy.maxDelayMs) : delay, detail: errorDetail(json),
        };
      }
    } catch (e: any) {
      if (e instanceof ProviderError) throw e;
      if (signal?.aborted) throw new ProviderError(`aborted: ${signal.reason?.message ?? signal.reason ?? e?.message ?? e}`);
      failure = { error: `network error: ${e?.message ?? e}`, retryable: true, transient: true, waitMs: delay, detail: {} };
    }
    firstFailure ??= t0;
    const hostNote = hosts && hosts.rotation.labels.length > 1 ? ` [host ${hosts.rotation.labels[host]}]` : "";
    if (!failure.retryable) throw new ProviderError(failure.error + hostNote, failure.status, false, failure.detail);
    if (!failure.transient && ++capped >= policy.maxAttempts) {
      throw new ProviderError(`${failure.error}${hostNote} (${capped} failures of this kind)`, failure.status, true, failure.detail);
    }
    const elapsed = Date.now() - firstFailure;
    if (failure.transient && elapsed + failure.waitMs > policy.windowMs) {
      throw new ProviderError(`${failure.error}${hostNote} (still failing after ${Math.round(elapsed / 1000)}s; retry window ${Math.round(policy.windowMs / 1000)}s)`,
        failure.status, true, failure.detail);
    }
    onRetry?.({ error: failure.error + hostNote, status: failure.status, latencyMs: Date.now() - t0, waitMs: failure.waitMs, ...failure.detail });
    let waitMs = failure.waitMs;
    if (hosts && hosts.rotation.labels.length > 1 && ++onHost >= hosts.rotation.switchAfter) {
      host = hosts.rotation.failOver(host);
      onHost = 0;
      // A host this call hasn't tried yet may be fine: try it after the shortest wait. Once every host has failed, the
      // backoff keeps growing as for a single host.
      if (!tried.has(host)) waitMs = Math.min(waitMs, policy.baseDelayMs);
      tried.add(host);
    }
    delay = Math.min(delay * 2, policy.maxDelayMs);
    clock?.pause(Date.now() - t0);
    try { await sleep(waitMs, signal); } finally { clock?.resume(); }
    if (signal?.aborted) throw new ProviderError(`aborted: ${signal.reason?.message ?? signal.reason}`);
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
