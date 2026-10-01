/**
 * Offline stand-in for an LLM. Runs through the exact same prompt building,
 * tool loop, validation and analytics path as a real model, but answers
 * randomly and estimates tokens as chars/4. Use it to smoke-test a config
 * before spending money.
 */
import type { SeatConfig } from "../../config.ts";
import { Rng } from "../../util/rng.ts";
import type { CompleteArgs, ModelTurn, Provider } from "./types.ts";

export class EchoProvider implements Provider {
  readonly name = "echo";
  readonly model: string;
  private rng: Rng;
  private n = 0;
  constructor(private seat: SeatConfig) {
    this.model = seat.model ?? "echo";
    this.rng = new Rng([...seat.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7));
  }
  async complete({ system, messages, tools, debug }: CompleteArgs): Promise<ModelTurn> {
    const promptChars = system.length + JSON.stringify(messages).length;
    const last = messages[messages.length - 1];
    const toolNames = tools.map((t) => t.name);
    const usedTool = messages.some((m) => m.role === "tool");
    const id = `echo_${++this.n}`;
    let toolCalls;
    if (toolNames.includes("submit_notes")) {
      const first = messages[0];
      const prompt = first?.role === "user" ? first.content : "";
      const lines = prompt.split("\n").filter((l: string) => / cast /.test(l)).slice(0, 5);
      toolCalls = [{ id, name: "submit_notes", input: { notes: `Echo notes. Opponent cast:\n${lines.join("\n") || "(nothing seen)"}` } }];
    } else if (toolNames.includes("submit_brief") && usedTool) {
      toolCalls = [{ id, name: "submit_brief", input: { brief: "Echo brief: draft the best card, stay open, aim for two colours with a low curve." } }];
    } else if (toolNames.includes("submit_brief")) {
      toolCalls = [{ id, name: "search_cube", input: { type: "Instant", max_cmc: 2 } }];
    } else
    // First turn: sometimes consult a knowledge tool, to exercise that path.
    if (!usedTool && toolNames.includes("search_rules") && this.rng.next() < 0.2) {
      toolCalls = [{ id, name: this.rng.pick(["lookup_card", "search_rules"]), input: { name: "Lightning Bolt", query: "first strike" } }];
    } else {
      const ids = debug?.optionIds ?? [];
      const min = debug?.min ?? 1, max = debug?.max ?? 1;
      // Occasionally answer illegally to exercise the retry path. Test knob: extraBody.invalidRate (0-1) applies to
      // retries too, so a high rate drives decisions all the way to a forfeit.
      const rate = Number(this.seat.extraBody?.invalidRate);
      const bad = Number.isFinite(rate) ? this.rng.next() < rate : this.rng.next() < 0.03 && last.role !== "tool";
      const k = Math.min(ids.length, min + this.rng.int(Math.max(1, Math.min(max, ids.length) - min + 1)));
      const choice = bad ? ["not-an-option"] : this.rng.shuffle([...ids]).slice(0, k);
      const input: any = { choice, rationale: "echo" };
      if (debug?.kind === "deckbuild") input.choice = ids.slice(0, 23), input.basics = { Island: 9, Mountain: 8 };
      toolCalls = [{ id, name: "submit_decision", input }];
    }
    const out = JSON.stringify(toolCalls);
    return {
      text: "",
      toolCalls,
      usage: { inputTokens: Math.round(promptChars / 4), outputTokens: Math.round(out.length / 4) + 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, reportedCostUsd: 0, costReportedCalls: 0 },
      stopReason: "tool_use",
    };
  }
}
