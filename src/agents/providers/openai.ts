/**
 * OpenAI Chat Completions provider. Also used for any OpenAI-compatible server:
 * OpenRouter, Google Gemini's OpenAI endpoint, xAI, Together, vLLM, Ollama, LM Studio...
 */
import { maxTokensFor, type SeatConfig } from "../../config.ts";
import { type BodyFailure, type CompleteArgs, errorDetail, HostRotation, type ModelTurn, type Provider, ProviderError, postJson, type RetryPolicy, transientStatus } from "./types.ts";

const DEFAULT_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
};

export class OpenAIProvider implements Provider {
  readonly name: string;
  readonly model: string;
  private url: string;
  private key: string;
  /** Primary host, then SeatConfig.backupProviders (OpenRouter only). */
  private hosts?: HostRotation;
  constructor(private seat: SeatConfig, private retry: Partial<RetryPolicy> = {}) {
    this.name = seat.provider;
    this.model = seat.model!;
    const base = seat.baseUrl ?? DEFAULT_BASE[seat.provider];
    if (!base) throw new ProviderError(`seat ${seat.id}: baseUrl is required`);
    this.url = base.replace(/\/$/, "") + "/chat/completions";
    this.key = seat.apiKeyEnv ? process.env[seat.apiKeyEnv] ?? "" : "";
    if (seat.apiKeyEnv && !this.key) throw new ProviderError(`seat ${seat.id}: env var ${seat.apiKeyEnv} is empty`);
    if (seat.backupProviders?.length) {
      const pin = seat.extraBody?.provider as { order?: string[] } | undefined;
      this.hosts = new HostRotation([pin?.order?.join(",") ?? "default", ...seat.backupProviders]);
    }
  }

  /** The request body routed to host i of the rotation: a backup is pinned alone, without fallbacks. */
  private bodyFor(body: any, i: number) {
    if (i === 0) return body;
    return { ...body, provider: { ...(body.provider ?? {}), order: [this.seat.backupProviders![i - 1]], allow_fallbacks: false } };
  }

  async complete({ system, messages, tools, signal, clock, onRetry, maxTokens: cap }: CompleteArgs): Promise<ModelTurn> {
    const msgs: any[] = [{ role: "system", content: system }];
    for (const m of messages) {
      if (m.role === "user") msgs.push({ role: "user", content: m.content });
      else if (m.role === "assistant") {
        const raw = m.raw as any;
        msgs.push(raw ?? {
          role: "assistant",
          content: m.text || null,
          ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.input) } })) } : {}),
        });
      } else {
        for (const r of m.results) msgs.push({ role: "tool", tool_call_id: r.id, content: r.content });
      }
    }
    const body: any = {
      model: this.model,
      messages: msgs,
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
      tool_choice: "auto",
    };
    const maxTokens = cap ?? maxTokensFor(this.seat);
    if (this.seat.provider === "openai") body.max_completion_tokens = maxTokens; else body.max_tokens = maxTokens;
    if (this.seat.temperature !== undefined) body.temperature = this.seat.temperature;
    if (this.seat.reasoningEffort) body.reasoning_effort = this.seat.reasoningEffort;
    if (this.seat.provider === "openrouter") body.usage = { include: true };
    Object.assign(body, this.seat.extraBody ?? {});

    const { status, json } = await postJson(this.url, body, {
      ...(this.key ? { authorization: `Bearer ${this.key}` } : {}),
      ...(this.seat.headers ?? {}),
    }, { signal, clock, onRetry, bodyError: openAiBodyError, retry: this.retry,
      ...(this.hosts ? { hosts: { rotation: this.hosts, bodyFor: (i: number) => this.bodyFor(body, i) } } : {}) });

    const choice = json.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    const u = json.usage ?? {};
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    const toolCalls = (msg.tool_calls ?? []).map((t: any) => {
      let input: any = {};
      try { input = t.function?.arguments ? JSON.parse(t.function.arguments) : {}; } catch { input = { __unparseable: t.function?.arguments }; }
      return { id: t.id, name: t.function?.name, input };
    });
    // Keep the assistant message verbatim for replay (some providers attach reasoning fields).
    const raw = { role: "assistant", content: msg.content ?? null, ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) };
    return {
      text: typeof msg.content === "string" ? msg.content : "",
      toolCalls,
      usage: {
        inputTokens: Math.max(0, (u.prompt_tokens ?? 0) - cached),
        outputTokens: u.completion_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
        reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
        reportedCostUsd: typeof u.cost === "number" ? u.cost : 0,
        costReportedCalls: typeof u.cost === "number" ? 1 : 0,
      },
      servedBy: typeof json.provider === "string" ? json.provider : undefined,
      stopReason: choice.finish_reason,
      ...(typeof choice.native_finish_reason === "string" ? { nativeFinishReason: choice.native_finish_reason } : {}),
      ...(choice.error ?? json.error ? { providerError: JSON.stringify(choice.error ?? json.error).slice(0, 500) } : {}),
      httpStatus: status,
      raw,
    };
  }
}

/**
 * A 200 that carries no answer is a provider failure, not the model's: `finish_reason: "error"` (e.g. OpenRouter's
 * Gemini routes), an `error` object, or no content, no tool calls and no output tokens. The upstream model's own
 * finish reason (`native_finish_reason`, e.g. Gemini's SAFETY / RECITATION) goes into the message and the usage row,
 * so a content filter can be told from an outage (MB-051).
 */
export function openAiBodyError(json: any): BodyFailure | undefined {
  const choice = json.choices?.[0];
  const native = typeof choice?.native_finish_reason === "string" ? choice.native_finish_reason : undefined;
  const detail = {
    ...(native ? { nativeFinishReason: native } : {}),
    ...(typeof json.provider === "string" ? { servedBy: json.provider } : {}),
    ...(choice?.error ?? json.error ? { providerError: JSON.stringify(choice?.error ?? json.error).slice(0, 500) } : {}),
  };
  const why = (error: string, transient = false): BodyFailure => ({ error: native ? `${error} (native_finish_reason "${native}")` : error, ...detail, ...(transient ? { transient } : {}) });
  if (json.error) return { ...errorDetail(json), ...why(JSON.stringify(json.error).slice(0, 300), transientError(json.error)) };
  if (!choice) return why("no choices");
  // An error mid-generation is the host's, unless the model's own reason is a content block (deterministic: few retries).
  if (choice.finish_reason === "error") return why(`finish_reason "error"${choice.error ? `: ${JSON.stringify(choice.error).slice(0, 300)}` : ""}`, !CONTENT_BLOCK.test(native ?? ""));
  const msg = choice.message ?? {};
  if (!msg.content && !msg.tool_calls?.length && !(json.usage?.completion_tokens > 0)) return why("empty response (no content, no tool calls, 0 output tokens)");
  return undefined;
}

/** Native finish reasons that mean the upstream model's content filter stopped it (Gemini, OpenAI, Anthropic). */
const CONTENT_BLOCK = /safety|recitation|prohibited|blocklist|spii|content_filter|refusal/i;

/**
 * An in-body error object that says the host is unavailable or rate-limited (e.g. OpenRouter's 502 "JSON error
 * injected into SSE stream" with error_type provider_unavailable): waited out like an HTTP 5xx.
 */
export function transientError(err: any): boolean {
  const code = Number(err?.code);
  if (err?.code !== undefined && err?.code !== null && Number.isFinite(code)) return transientStatus(code);
  return /provider_unavailable|unavailable|overloaded|rate.?limit|timed? ?out|JSON error injected/i.test(JSON.stringify(err ?? ""));
}
