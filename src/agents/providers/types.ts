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
  /** Offline providers (echo) may peek at the request; real providers must ignore it. */
  debug?: { optionIds: string[]; min: number; max: number; kind: string };
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  complete(args: CompleteArgs): Promise<ModelTurn>;
}

export class ProviderError extends Error {
  constructor(msg: string, readonly status?: number, readonly retryable = false) { super(msg); }
}

/** fetch with retry on 429 / 5xx / network errors, honouring Retry-After. */
export async function postJson(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<{ status: number; json: any }> {
  let delay = 2000;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
    } catch (e: any) {
      if (signal?.aborted || attempt >= 5) throw new ProviderError(`network error: ${e?.message ?? e}`);
      await sleep(delay); delay *= 2; continue;
    }
    const text = await res.text();
    if (res.ok) {
      try { return { status: res.status, json: JSON.parse(text) }; }
      catch { throw new ProviderError(`invalid JSON from provider: ${text.slice(0, 300)}`, res.status); }
    }
    const retryable = res.status === 429 || res.status === 408 || res.status === 529 || res.status >= 500;
    if (retryable && attempt < 6) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : delay);
      delay = Math.min(delay * 2, 60000);
      continue;
    }
    throw new ProviderError(`HTTP ${res.status}: ${text.slice(0, 500)}`, res.status, retryable);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
