/** Anthropic Messages API provider (tool use, optional extended thinking, prompt caching). */
import { maxTokensFor, type SeatConfig } from "../../config.ts";
import { type CompleteArgs, type ModelTurn, type Provider, ProviderError, postJson, type RetryPolicy } from "./types.ts";

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  readonly model: string;
  private url: string;
  private key: string;
  constructor(private seat: SeatConfig, private retry: Partial<RetryPolicy> = {}) {
    this.model = seat.model!;
    this.url = (seat.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "") + "/v1/messages";
    this.key = seat.apiKeyEnv ? process.env[seat.apiKeyEnv] ?? "" : "";
    if (!this.key) throw new ProviderError(`seat ${seat.id}: env var ${seat.apiKeyEnv} is empty`);
  }

  async complete({ system, messages, tools, signal, clock, onRetry, maxTokens: cap }: CompleteArgs): Promise<ModelTurn> {
    const msgs: any[] = [];
    for (const m of messages) {
      if (m.role === "user") msgs.push({ role: "user", content: m.content });
      else if (m.role === "assistant") {
        msgs.push({
          role: "assistant",
          content: (m.raw as any[]) ?? [
            ...(m.text ? [{ type: "text", text: m.text }] : []),
            ...m.toolCalls.map((t) => ({ type: "tool_use", id: t.id, name: t.name, input: t.input })),
          ],
        });
      } else {
        msgs.push({ role: "user", content: m.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })) });
      }
    }
    const maxTokens = cap ?? maxTokensFor(this.seat);
    const body: any = {
      model: this.model,
      max_tokens: this.seat.thinkingBudget ? Math.max(maxTokens, this.seat.thinkingBudget + 4096) : maxTokens,
      // System prompt is identical for every decision of a phase -> cache it.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: msgs,
      tools: tools.map((t, i) => ({ name: t.name, description: t.description, input_schema: t.input_schema, ...(i === tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}) })),
      tool_choice: { type: "auto" },
    };
    if (this.seat.thinkingBudget) body.thinking = { type: "enabled", budget_tokens: this.seat.thinkingBudget };
    else if (this.seat.temperature !== undefined) body.temperature = this.seat.temperature;
    Object.assign(body, this.seat.extraBody ?? {});

    const { status, json } = await postJson(this.url, body, {
      "x-api-key": this.key,
      "anthropic-version": "2023-06-01",
      ...(this.seat.headers ?? {}),
    }, { signal, clock, onRetry, retry: this.retry, bodyError: (j) => (j.type === "error" ? { error: JSON.stringify(j.error ?? j).slice(0, 300), providerError: JSON.stringify(j.error ?? j).slice(0, 500),
        transient: /overloaded|rate_limit|api_error|timeout/i.test(String(j.error?.type)) }
      : !j.content?.length && !(j.usage?.output_tokens > 0) ? { error: `empty response (no content, 0 output tokens, stop_reason "${j.stop_reason}")` } : undefined) });

    const content: any[] = json.content ?? [];
    const u = json.usage ?? {};
    return {
      text: content.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
      toolCalls: content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input })),
      usage: {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        reasoningTokens: 0, // Anthropic bills thinking inside output_tokens and does not split it out
        reportedCostUsd: 0, // the Messages API reports tokens, not cost
        costReportedCalls: 0,
      },
      stopReason: json.stop_reason,
      httpStatus: status,
      raw: content,
    };
  }
}
