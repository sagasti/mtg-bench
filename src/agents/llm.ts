/** LLM agent: one tool-use conversation per decision. */
import { addUsage, type TokenUsage, ZERO_USAGE } from "../analytics/recorder.ts";
import type { CardDb } from "../cards/db.ts";
import type { EventConfig, SeatConfig } from "../config.ts";
import { cardText, getCard } from "../cards/db.ts";
import { type KnowledgeBase, studyTools, toolsForTier } from "../knowledge/tools.ts";
import { type DecisionRequest, type DecisionResponse, type DecideContext, validateResponse } from "../types.ts";
import type { AgentResult, CallObserver, DecisionAgent } from "./agent.ts";
import type { ChatMessage, Provider } from "./providers/types.ts";
import { renderRequest, systemPrompt } from "./render.ts";

export class LlmAgent implements DecisionAgent {
  readonly kind: string;
  constructor(
    readonly seat: SeatConfig,
    private provider: Provider,
    private event: EventConfig,
    /** Only used to assert it never leaks into a prompt. */
    private cubeName: string,
    private db: CardDb,
    private kb: KnowledgeBase,
  ) { this.kind = seat.provider; }

  get model() { return this.provider.model; }

  /** Pre-draft cube study (see runCubeStudy). */
  study(cubeCards: string[], onCall: CallObserver) {
    return runCubeStudy(this, this.provider, this.event, this.db, this.kb, cubeCards, this.cubeName, onCall);
  }

  async decide(req: DecisionRequest, ctx: DecideContext, onCall: CallObserver): Promise<AgentResult> {
    const system = systemPrompt(this.event, req.phase, ctx.brief);
    const tools = toolsForTier(this.event.knowledge);
    const first = renderRequest(req, this.event, this.db, ctx.notes);
    assertNoLeak(system + "\n" + first, [this.cubeName, this.event.name]);
    const messages: ChatMessage[] = [{ role: "user", content: first }];
    const signal = AbortSignal.timeout(this.event.decisionTimeoutSec * 1000);
    let usage: TokenUsage = { ...ZERO_USAGE };
    const toolCalls: Record<string, number> = {};
    let knowledgeCalls = 0;
    let invalidAttempts = 0;
    let modelCalls = 0;
    let lastError: string | undefined;
    const maxRounds = this.event.maxToolCallsPerDecision + this.event.maxRetries + 3;

    for (let round = 0; round < maxRounds; round++) {
      const t0 = Date.now();
      let turn;
      try {
        turn = await this.provider.complete({
          system, messages, tools, signal,
          debug: { optionIds: req.options.map((o) => o.id), min: req.min, max: req.max, kind: req.kind },
        });
      } catch (e: any) {
        lastError = String(e?.message ?? e);
        onCall({ turn: round, latencyMs: Date.now() - t0, usage: ZERO_USAGE, error: lastError, httpStatus: e?.status, toolCallsRequested: 0 });
        break;
      }
      modelCalls++;
      usage = addUsage(usage, turn.usage);
      onCall({ turn: round, latencyMs: Date.now() - t0, usage: turn.usage, stopReason: turn.stopReason, httpStatus: turn.httpStatus, toolCallsRequested: turn.toolCalls.length });
      messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls, raw: turn.raw });

      if (turn.toolCalls.length === 0) {
        // Model answered in prose. Try to salvage a JSON answer, else nudge once more.
        const salvaged = salvageJson(turn.text);
        if (salvaged) {
          const err = validateResponse(req, salvaged);
          if (!err) return { response: salvaged, usage, modelCalls, toolCalls, invalidAttempts };
          invalidAttempts++;
          lastError = err;
        }
        if (invalidAttempts > this.event.maxRetries) break;
        messages.push({ role: "user", content: "Please answer by calling the submit_decision tool with option ids from the Options list." });
        continue;
      }

      const results: { id: string; content: string; isError?: boolean }[] = [];
      let final: DecisionResponse | null = null;
      for (const call of turn.toolCalls) {
        toolCalls[call.name] = (toolCalls[call.name] ?? 0) + 1;
        if (call.name === "submit_decision") {
          const resp: DecisionResponse = {
            choice: Array.isArray(call.input?.choice) ? call.input.choice.map(String) : [],
            basics: call.input?.basics,
            notes: typeof call.input?.notes === "string" ? call.input.notes.slice(0, 2000) : undefined,
            rationale: typeof call.input?.rationale === "string" ? call.input.rationale.slice(0, 1000) : undefined,
          };
          const err = validateResponse(req, resp);
          if (err) {
            invalidAttempts++;
            lastError = err;
            results.push({ id: call.id, content: `Rejected: ${err}. Choose again from the Options list.`, isError: true });
          } else if (!final) {
            final = resp;
            results.push({ id: call.id, content: "Accepted." });
          } else {
            results.push({ id: call.id, content: "Ignored: a decision was already submitted." });
          }
        } else if (knowledgeCalls >= this.event.maxToolCallsPerDecision) {
          results.push({ id: call.id, content: "Tool budget for this decision is used up. Call submit_decision now.", isError: true });
        } else {
          knowledgeCalls++;
          let out: string;
          try { out = this.kb.run(call.name, call.input); } catch (e: any) { out = `Tool error: ${e?.message ?? e}`; }
          results.push({ id: call.id, content: out });
        }
      }
      if (final) return { response: final, usage, modelCalls, toolCalls, invalidAttempts };
      if (invalidAttempts > this.event.maxRetries) break;
      messages.push({ role: "tool", results });
    }
    return { response: null, usage, modelCalls, toolCalls, invalidAttempts, error: lastError ?? "no valid answer" };
  }
}

/** Hard guard: the cube / event name must never reach an agent. */
export function assertNoLeak(text: string, secrets: string[]) {
  const lower = text.toLowerCase();
  for (const s of secrets) {
    if (s && s.length >= 4 && lower.includes(s.toLowerCase())) {
      throw new Error(`prompt leak: "${s}" appears in a prompt sent to an agent`);
    }
  }
}

export interface StudyResult { brief: string | null; usage: TokenUsage; modelCalls: number; toolCalls: Record<string, number>; error?: string }

/** Pre-draft cube study: one conversation that ends with submit_brief. */
export async function runCubeStudy(
  agent: LlmAgent, provider: Provider, event: EventConfig, db: CardDb, kb: KnowledgeBase, cubeCards: string[], cubeName: string,
  onCall: CallObserver,
): Promise<StudyResult> {
  const unique = [...new Set(cubeCards)].sort();
  const listing = unique.map((n) => {
    const c = getCard(db, n);
    return c ? cardText(c, { includeOracle: event.knowledge !== "names" }) : n;
  }).join("\n");
  const system = systemPrompt(event, "study");
  const user = `The cube contains ${unique.length} different cards (${cubeCards.length} total). Full list:\n\n${listing}\n\nWrite your strategy brief and submit it with submit_brief.`;
  assertNoLeak(system + "\n" + user, [cubeName, event.name]);
  const tools = studyTools(event.knowledge);
  const messages: ChatMessage[] = [{ role: "user", content: user }];
  let usage: TokenUsage = { ...ZERO_USAGE };
  const toolCalls: Record<string, number> = {};
  let modelCalls = 0, knowledgeCalls = 0;
  const signal = AbortSignal.timeout(Math.max(600, event.decisionTimeoutSec * 3) * 1000);
  for (let round = 0; round < event.maxToolCallsPerDecision * 2 + 3; round++) {
    const t0 = Date.now();
    let turn;
    try { turn = await provider.complete({ system, messages, tools, signal }); }
    catch (e: any) {
      onCall({ turn: round, latencyMs: Date.now() - t0, usage: ZERO_USAGE, error: String(e?.message ?? e), httpStatus: e?.status, toolCallsRequested: 0 });
      return { brief: null, usage, modelCalls, toolCalls, error: String(e?.message ?? e) };
    }
    modelCalls++;
    usage = addUsage(usage, turn.usage);
    onCall({ turn: round, latencyMs: Date.now() - t0, usage: turn.usage, stopReason: turn.stopReason, httpStatus: turn.httpStatus, toolCallsRequested: turn.toolCalls.length });
    messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls, raw: turn.raw });
    if (!turn.toolCalls.length) {
      if (turn.text.trim().length > 200) return { brief: capWords(turn.text, event.briefMaxWords), usage, modelCalls, toolCalls };
      messages.push({ role: "user", content: "Please submit your brief with the submit_brief tool." });
      continue;
    }
    const results: { id: string; content: string; isError?: boolean }[] = [];
    for (const call of turn.toolCalls) {
      toolCalls[call.name] = (toolCalls[call.name] ?? 0) + 1;
      if (call.name === "submit_brief") {
        const b = String(call.input?.brief ?? "").trim();
        if (b) return { brief: capWords(b, event.briefMaxWords), usage, modelCalls, toolCalls };
        results.push({ id: call.id, content: "Empty brief.", isError: true });
      } else if (knowledgeCalls++ >= event.maxToolCallsPerDecision * 2) {
        results.push({ id: call.id, content: "Tool budget used up. Submit your brief now.", isError: true });
      } else {
        results.push({ id: call.id, content: kb.run(call.name, call.input) });
      }
    }
    messages.push({ role: "tool", results });
  }
  return { brief: null, usage, modelCalls, toolCalls, error: "no brief submitted" };
}

function capWords(text: string, max: number): string {
  const words = text.split(/\s+/);
  return words.length <= max ? text : words.slice(0, max).join(" ") + " …[truncated]";
}

function salvageJson(text: string): DecisionResponse | null {
  const m = text.match(/\{[\s\S]*"choice"[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return Array.isArray(j.choice) ? { choice: j.choice.map(String), basics: j.basics, rationale: j.rationale } : null;
  } catch { return null; }
}
