/** LLM agent: one tool-use conversation per decision. */
import { addUsage, type TokenUsage, ZERO_USAGE } from "../analytics/recorder.ts";
import type { CardDb } from "../cards/db.ts";
import { type EventConfig, maxTokensFor, reasoningDisabled, type SeatConfig } from "../config.ts";
import { cardText, getCard } from "../cards/db.ts";
import { type KnowledgeBase, SUBMIT_NOTES_TOOL, studyTools, toolsForTier } from "../knowledge/tools.ts";
import { type DecisionRequest, type DecisionResponse, type DecideContext, validateResponse } from "../types.ts";
import type { AgentResult, CallObserver, DecisionAgent } from "./agent.ts";
import { type ChatMessage, type CompleteArgs, DecisionClock, type FailureDetail, type ModelTurn, type Provider, ProviderError } from "./providers/types.ts";
import { info, type Jsonl } from "../util/log.ts";
import { hasPrompt, renderRequest, renderTemplate, systemPrompt } from "./render.ts";
import { mulliganVerdict } from "../knowledge/mulligan.ts";
import { suicidalAttackers } from "../knowledge/combat.ts";
import { deckKey, deckStats, renderDeckStats } from "../deckbuild/stats.ts";

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
    /** When set, every rendered decision prompt is appended here (event.recordPrompts). */
    private promptLog?: Jsonl,
  ) { this.kind = seat.provider; }

  get model() { return this.provider.model; }

  /** Pre-draft cube study (see runCubeStudy). */
  study(cubeCards: string[], onCall: CallObserver) {
    return runCubeStudy(this, this.event, this.db, this.kb, cubeCards, this.cubeName, onCall);
  }

  /**
   * Between games of a match: rewrite match notes from the game's public log (MTR 2.11 allows notes taken during a
   * match to be used for the rest of it). Uses the game-phase system prompt so the provider's prompt cache is reused.
   */
  async writeMatchNotes(input: MatchNotesInput, brief: string | undefined, onCall: CallObserver): Promise<MatchNotesResult> {
    const system = systemPrompt(this.event, "game", brief);
    const user = renderTemplate(this.event.promptVersion, "between-games.md", {
      game: input.game, your_wins: input.yourWins, opponent_wins: input.opponentWins,
      your_name: input.yourName, opponent_name: input.opponentName, max_words: MATCH_NOTES_MAX_WORDS,
      previous_notes: input.previousNotes?.trim() || "(none yet)", log: input.log.join("\n"),
    });
    assertNoLeak(system + "\n" + user, [this.cubeName, this.event.name]);
    const messages: ChatMessage[] = [{ role: "user", content: user }];
    const clock = new DecisionClock(this.event.decisionTimeoutSec * 1000);
    let usage: TokenUsage = { ...ZERO_USAGE };
    const toolCalls: Record<string, number> = {};
    if (auraPolicy) toolCalls.aura_policy = auraPolicy;
    if (combatPolicy) toolCalls.combat_policy = combatPolicy;
    let modelCalls = 0, truncated = 0;
    let specViolation: string | undefined;
    const result = (notes: string | null, extra: Partial<MatchNotesResult> = {}): MatchNotesResult =>
      ({ notes, usage, modelCalls, toolCalls, truncated, specViolation, ...extra });
    try {
      for (let round = 0; round <= this.event.maxRetries; round++) {
        let out;
        try { out = await this.call({ system, messages, tools: [SUBMIT_NOTES_TOOL] }, clock, round, onCall); }
        catch (e: any) { return result(null, failure(e, clock)); }
        modelCalls += out.calls; usage = addUsage(usage, out.usage); truncated += out.truncated; specViolation ??= out.specViolation;
        const turn = out.turn;
        messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls, raw: turn.raw });
        const call = turn.toolCalls.find((c) => c.name === "submit_notes");
        for (const c of turn.toolCalls) toolCalls[c.name] = (toolCalls[c.name] ?? 0) + 1;
        const notes = typeof call?.input?.notes === "string" ? call.input.notes.trim() : "";
        if (notes) return result(capWords(notes, MATCH_NOTES_MAX_WORDS));
        if (!turn.toolCalls.length) messages.push({ role: "user", content: "Please submit your match notes with the submit_notes tool." });
        else messages.push({ role: "tool", results: turn.toolCalls.map((c) => ({ id: c.id, content: "Call submit_notes with non-empty `notes`.", isError: true })) });
      }
      return result(null, { error: "no notes submitted" });
    } finally { clock.stop(); }
  }

  /**
   * One model call as every agent loop sees it. Each failed provider attempt is recorded (an API error); an answer
   * cut off by the output cap is recorded as truncated and asked again once with a bigger cap; every answer is checked
   * against the seat's spec. Throws when the provider keeps failing or the clock runs out.
   */
  async call(args: Pick<CompleteArgs, "system" | "messages" | "tools" | "debug" | "reasoningEffort" | "maxTokens">, clock: DecisionClock, round: number, onCall: CallObserver): Promise<CallOutcome> {
    let usage: TokenUsage = { ...ZERO_USAGE };
    let calls = 0, truncated = 0;
    let specViolation: string | undefined;
    let maxTokens: number | undefined = args.maxTokens;
    for (;;) {
      const t0 = Date.now();
      let turn: ModelTurn;
      try {
        turn = await this.provider.complete({
          ...args, signal: clock.signal, clock, maxTokens,
          onRetry: (r) => onCall({ turn: round, latencyMs: r.latencyMs, usage: ZERO_USAGE, error: r.error, httpStatus: r.status, toolCallsRequested: 0, ...detail(r) }),
        });
      } catch (e: any) {
        if (clock.expired) onCall({ turn: round, latencyMs: Date.now() - t0, usage: ZERO_USAGE, stopReason: "timeout", timedOut: true, toolCallsRequested: 0 });
        else if (e instanceof ProviderError) onCall({ turn: round, latencyMs: Date.now() - t0, usage: ZERO_USAGE, error: e.message, httpStatus: e.status, toolCallsRequested: 0, ...detail(e.detail) });
        throw e;
      }
      calls++;
      usage = addUsage(usage, turn.usage);
      const cut = turn.stopReason === "length" || turn.stopReason === "max_tokens";
      const violation = checkSeatSpec(this.seat, turn);
      onCall({ turn: round, latencyMs: Date.now() - t0, usage: turn.usage, stopReason: turn.stopReason, httpStatus: turn.httpStatus,
        toolCallsRequested: turn.toolCalls.length, servedBy: turn.servedBy, ...detail(turn), ...(cut ? { truncated: true } : {}), ...(violation ? { specViolation: violation } : {}) });
      if (violation) warnSpec(this.seat.id, violation);
      specViolation ??= violation;
      if (cut) truncated++;
      const bigger = Math.min(2 * maxTokensFor(this.seat), TRUNCATION_RETRY_MAX_TOKENS);
      if (cut && maxTokens === undefined && bigger > maxTokensFor(this.seat)) { maxTokens = bigger; continue; }
      return { turn, usage, calls, truncated, specViolation };
    }
  }

  /** Pilot patch: the last confirm question of this game and how many times in a row it was asked and answered the same way. */
  private lastConfirm: { key: string; count: number; choice: string } | undefined;

  async decide(req: DecisionRequest, ctx: DecideContext, onCall: CallObserver): Promise<AgentResult> {
    // Pilot patch: Forge re-asks the same yes/no (e.g. "Sacrifice Eldrazi Spawn Token?" to pay a cost) forever while the
    // answer stays No; 450 identical confirms ate an hour and the match. After three identical answers in a row, flip it.
    if (req.kind === "confirm" && req.options.length === 2) {
      const key = `${ctx.matchId}:${ctx.game}:${req.prompt}`;
      const last = this.lastConfirm;
      if (last && last.key === key && last.count >= 3) {
        const other = req.options.find((o) => o.id !== last.choice) ?? req.options[0];
        info(`[${this.seat.id}] loop breaker: same confirm asked ${last.count} times, answering ${other.label}`);
        this.lastConfirm = { key, count: 0, choice: other.id };
        return { response: { choice: [other.id], rationale: `loop breaker: the same question was answered "${req.options.find((o) => o.id === last.choice)?.label}" ${last.count} times in a row` }, usage: ZERO_USAGE, modelCalls: 0, toolCalls: { loop_break: 1 }, invalidAttempts: 0 };
      }
      const r = await this.decideInner(req, ctx, onCall);
      const choice = r.response?.choice?.[0] ?? "";
      this.lastConfirm = last && last.key === key && last.choice === choice ? { key, count: last.count + 1, choice } : { key, count: 1, choice };
      return r;
    }
    this.lastConfirm = undefined;
    return this.decideInner(req, ctx, onCall);
  }

  private async decideInner(req: DecisionRequest, ctx: DecideContext, onCall: CallObserver): Promise<AgentResult> {
    // Pilot patch: clear-cut mulligans are a policy, not a model call (the model kept one-landers against the verdict).
    if (req.kind === "mulligan" && this.event.mulliganPolicy === "strict" && this.event.mulliganMath) {
      const v = mulliganVerdict(req, this.db);
      const want = v?.action === "mulligan" ? /^Button: Mulligan$/i : /^Button: Keep$/i;
      const opt = v?.binding ? req.options.find((o) => want.test(o.label)) : undefined;
      if (v && opt) {
        info(`[${this.seat.id}] mulligan policy: ${v.action} (${v.why})`);
        return { response: { choice: [opt.id], rationale: `mulligan policy (${v.verdict}): ${v.why}` }, usage: ZERO_USAGE, modelCalls: 0, toolCalls: { mulligan_policy: 1 }, invalidAttempts: 0 };
      }
    }
    // Pilot patch: a buff Aura this seat casts never goes on a token or a non-hexproof creature while a hexproof creature
    // of ours is a legal target (it eats their removal and the aura goes with it). The options are narrowed before rendering.
    let auraPolicy = 0;
    if (this.event.auraPolicy === "strict" && req.kind === "priority") {
      const perms: any[] = (req.state as any)?.you?.battlefield ?? [];
      const creatures = perms.filter((p) => p.pt);
      if (creatures.length && creatures.every((p) => p.token) && !creatures.some((p) => /\bHexproof\b/i.test(p.text ?? ""))) {
        const drop = req.options.filter((o) => { const m = o.label.match(/^cast spell: your (.+?) \[Hand\]/); const c = m ? getCard(this.db, m[1]) : undefined; return !!c && /\bAura\b/.test(c.types) && /^Enchant creature/m.test(c.oracle) && /Enchanted creature (gets \+|has |can't be blocked)/.test(c.oracle); });
        if (drop.length && drop.length < req.options.length) {
          req = { ...req, options: req.options.filter((o) => !drop.includes(o)) };
          auraPolicy = 1;
          info(`[${this.seat.id}] aura policy: only tokens on board, not offering ${drop.map((o) => o.label.replace(/^cast spell: your /, "").replace(/ \[Hand\].*$/, "")).join(", ")}`);
        }
      }
    }
    // Pilot patch: an aura-wearing attacker without first strike never attacks into an untapped deathtouch blocker unless
    // the attack is lethal (the model kept trading a creature with three auras for one Baleful Strix).
    let combatPolicy = 0;
    if (this.event.combatPolicy === "strict" && this.event.combatMath && req.kind === "attackers") {
      const drop = suicidalAttackers(req, this.db);
      if (drop.length) {
        const ids = new Set(drop.map((d) => d.id));
        req = { ...req, options: req.options.filter((o) => !ids.has(o.id)) };
        combatPolicy = drop.length;
        info(`[${this.seat.id}] combat policy: not offering ${drop.map((d) => `${d.name} (${d.auras} aura${d.auras === 1 ? "" : "s"}, dies to ${d.blocker})`).join(", ")}`);
      }
    }
    if (this.event.auraPolicy === "strict" && req.kind === "targets") {
      const m = req.prompt.match(/^You are casting (.+?); choose its targets\./m);
      const card = m ? getCard(this.db, m[1]) : undefined;
      if (card && /\bAura\b/.test(card.types) && /^Enchant creature/m.test(card.oracle) && /Enchanted creature (gets \+|has |can't be blocked)/.test(card.oracle) && !/can't attack|can't block|doesn't untap/i.test(card.oracle)) {
        const perms = new Map<string, any>(((req.state as any)?.you?.battlefield ?? []).map((p: any) => [p.id, p]));
        const own = req.options.filter((o) => /^select card as target: your /.test(o.label));
        const hex = own.filter((o) => { const p = perms.get(o.id); return p && !p.token && /\bHexproof\b/i.test(p.text ?? ""); });
        if (hex.length && hex.length < req.options.length) {
          const keep = new Set(hex.map((o) => o.id));
          req = { ...req, options: req.options.filter((o) => keep.has(o.id)) };
          auraPolicy = 1;
          info(`[${this.seat.id}] aura policy: ${card.name} limited to hexproof targets (${hex.map((o) => o.label.replace(/^select card as target: your /, "")).join(", ")})`);
        }
      }
    }
    const system = systemPrompt(this.event, req.phase, ctx.brief);
    const tools = toolsForTier(this.event.knowledge);
    const first = renderRequest(req, this.event, this.db, ctx.notes, ctx.matchNotes);
    assertNoLeak(system + "\n" + first, [this.cubeName, this.event.name]);
    this.promptLog?.write({ seat: this.seat.id, matchId: ctx.matchId, game: ctx.game, kind: req.kind, requestId: req.requestId, prompt: first });
    const messages: ChatMessage[] = [{ role: "user", content: first }];
    let clock = new DecisionClock(this.event.decisionTimeoutSec * 1000);
    let usage: TokenUsage = { ...ZERO_USAGE };
    const toolCalls: Record<string, number> = {};
    let knowledgeCalls = 0;
    let invalidAttempts = 0;
    let modelCalls = 0, truncated = 0;
    let specViolation: string | undefined;
    let lastError: string | undefined;
    // Two-step deckbuilding (prompt versions with deck-review.md, MB-049): each valid deck is a proposal; the harness
    // answers with its derived stats and the agent confirms it (the same deck again) or revises it, up to
    // DECK_REVISIONS times. If the agent fails after a valid proposal, its latest proposal stands.
    const review = req.kind === "deckbuild" && hasPrompt(this.event.promptVersion, "deck-review.md");
    const proposals: { response: DecisionResponse; key: string; cards: number; lands: number }[] = [];
    let confirmed = false;
    const deckReview = () => (review && proposals.length
      ? { deckReview: { proposals: proposals.map((p) => ({ cards: p.cards, lands: p.lands })), confirmed } }
      : {});
    const propose = (resp: DecisionResponse) => {
      const cards = new Map(req.options.map((o) => [o.id, o.card ?? o.label]));
      const stats = deckStats(resp.choice.map((id) => cards.get(id)!), resp.basics ?? {}, this.db, Number(req.constraints?.minDeckSize ?? 40));
      proposals.push({ response: resp, key: deckKey(resp.choice, resp.basics), cards: stats.cards, lands: stats.lands });
      return stats;
    };
    let fellBack = false;
    const result = (response: DecisionResponse | null, extra: Partial<AgentResult> = {}): AgentResult => {
      if (fellBack) extra = { timeoutFallback: true, ...extra };
      // A failure after a valid proposal (invalid answers, the clock, the provider): that proposal is the agent's deck;
      // the failure is kept on the review record.
      if (!response && proposals.length) {
        const d = deckReview().deckReview!;
        return { response: proposals.at(-1)!.response, usage, modelCalls, toolCalls, invalidAttempts, truncated, specViolation,
          deckReview: { ...d, error: `${extra.error ?? lastError ?? "no answer"}; proposal ${proposals.length} stands` } };
      }
      return { response, usage, modelCalls, toolCalls, invalidAttempts, truncated, specViolation, ...deckReview(), ...extra };
    };
    /**
     * A valid answer under review: a new proposal with a revision still allowed after it gets its stats back (the
     * review text, and the caller asks again); otherwise it is final: the same deck again confirms the last proposal, a
     * different one after the last review is the final revision. Undefined = accept the answer.
     */
    const reviewOf = (resp: DecisionResponse): string | undefined => {
      if (!review) return undefined;
      const key = deckKey(resp.choice, resp.basics);
      if (proposals.length < DECK_REVISIONS && key !== proposals.at(-1)?.key) {
        const stats = propose(resp);
        const left = DECK_REVISIONS + 1 - proposals.length;
        return renderTemplate(this.event.promptVersion, "deck-review.md", {
          proposal: proposals.length, stats: renderDeckStats(stats), revisions_left: left,
          last: left === 1 ? " This is your last revision: a different deck submitted now is final, without another review." : "",
        });
      }
      if (key === proposals.at(-1)?.key) confirmed = true; else propose(resp);
      return undefined;
    };
    /** Each review step gets its own time budget: reading the stats and answering again is a new decision step. */
    const nextReviewStep = () => {
      clock.stop();
      clock = new DecisionClock(this.event.decisionTimeoutSec * 1000);
      debug.proposal = proposals.length + 1;
    };
    const maxRounds = this.event.maxToolCallsPerDecision + this.event.maxRetries + 3 + (review ? DECK_REVISIONS + 1 : 0);
    const debug: NonNullable<CompleteArgs["debug"]> = { optionIds: req.options.map((o) => o.id), min: req.min, max: req.max, kind: req.kind,
      ...(review ? { proposal: 1 } : {}) };

    try {
      for (let round = 0; round < maxRounds; round++) {
        let out;
        const byKind = this.seat.reasoningEffortByKind?.[req.kind];
        const fast = fellBack ? { reasoningEffort: this.seat.fallbackReasoningEffort, maxTokens: 4096 } : byKind ? { reasoningEffort: byKind } : {};
        try { out = await this.call({ system, messages, tools, debug, ...fast }, clock, round, onCall); }
        catch (e: any) {
          // Pilot patch: one fast re-ask (reasoning off) under a fresh short budget instead of the null action.
          if (clock.expired && this.seat.fallbackReasoningEffort && !fellBack && req.kind !== "deckbuild") {
            fellBack = true;
            clock.stop();
            clock = new DecisionClock((this.seat.fallbackTimeoutSec ?? 60) * 1000);
            messages.push({ role: "user", content: "Your time budget for this decision ran out. Answer NOW: call submit_decision with your best option ids. No further analysis." });
            continue;
          }
          return result(null, failure(e, clock));
        }
        modelCalls += out.calls; usage = addUsage(usage, out.usage); truncated += out.truncated; specViolation ??= out.specViolation;
        const turn = out.turn;
        messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls, raw: turn.raw });

        if (turn.toolCalls.length === 0) {
          // Model answered in prose. Try to salvage a JSON answer, else nudge once more.
          const salvaged = salvageJson(turn.text);
          if (salvaged) {
            const err = validateResponse(req, salvaged);
            if (!err) {
              // A salvaged deck goes through the same review as one submitted with the tool.
              const reviewText = reviewOf(salvaged);
              if (!reviewText) return result(salvaged);
              messages.push({ role: "user", content: reviewText });
              nextReviewStep();
              continue;
            }
            invalidAttempts++;
            lastError = err;
          }
          if (invalidAttempts > this.event.maxRetries) break;
          messages.push({ role: "user", content: "Please answer by calling the submit_decision tool with option ids from the Options list." });
          continue;
        }

        const results: { id: string; content: string; isError?: boolean }[] = [];
        let final: DecisionResponse | null = null;
        let reviewed = false;
        for (const call of turn.toolCalls) {
          toolCalls[call.name] = (toolCalls[call.name] ?? 0) + 1;
          if (call.name === "submit_decision") {
            const input = call.input ?? {};
            const resp: DecisionResponse = {
              choice: Array.isArray(input.choice) ? input.choice.map(String) : [],
              basics: input.basics,
              notes: typeof input.notes === "string" ? input.notes.slice(0, 2000) : undefined,
              rationale: typeof input.rationale === "string" ? input.rationale.slice(0, 1000) : undefined,
            };
            // A missing or malformed choice is a failed answer, not a deliberate "none".
            const err = "__unparseable" in input ? "the submit_decision arguments are not valid JSON"
              : !Array.isArray(input.choice) ? "`choice` must be an array of option ids" : validateResponse(req, resp);
            if (err) {
              invalidAttempts++;
              lastError = err;
              results.push({ id: call.id, content: `Rejected: ${err}. Choose again from the Options list.`, isError: true });
            } else if (!final && !reviewed) {
              const reviewText = reviewOf(resp);
              if (reviewText) { results.push({ id: call.id, content: reviewText }); reviewed = true; }
              else { final = resp; results.push({ id: call.id, content: "Accepted." }); }
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
        if (final) return result(final);
        if (invalidAttempts > this.event.maxRetries) break;
        messages.push({ role: "tool", results });
        if (reviewed) nextReviewStep();
      }
      return result(null, { error: lastError ?? "no valid answer" });
    } finally { clock.stop(); }
  }
}

/** The provider's own account of a call (only the fields that are set), for its usage row. */
function detail(d: FailureDetail): FailureDetail {
  return { ...(d.nativeFinishReason ? { nativeFinishReason: d.nativeFinishReason } : {}), ...(d.providerError ? { providerError: d.providerError } : {}),
    ...(d.servedBy ? { servedBy: d.servedBy } : {}) };
}

/** Two-step deckbuilding (prompt versions with deck-review.md): revisions allowed after the first proposal. */
export const DECK_REVISIONS = 2;

/** An answer cut off by the output cap is asked again once with twice the cap, up to this. */
const TRUNCATION_RETRY_MAX_TOKENS = 32768;

export interface CallOutcome { turn: ModelTurn; usage: TokenUsage; calls: number; truncated: number; specViolation?: string }

/**
 * Why a model call threw. The clock running out is the agent's failure (a chess clock); a provider that kept failing
 * through the provider layer's retries is infrastructure; anything else is a harness bug and propagates.
 */
function failure(e: any, clock: DecisionClock): { error: string; timedOut?: boolean; infraError?: boolean } {
  if (clock.expired) return { error: `decision time budget of ${Math.round(clock.budgetMs / 1000)}s used up`, timedOut: true };
  if (e instanceof ProviderError) return { error: e.message, infraError: true };
  throw e;
}

/**
 * A seat's reasoning regime and host are part of the event spec. Returns what this call broke, if anything:
 * reasoning tokens with reasoning disabled, or a host outside a pinned `provider.order` (and the seat's
 * `backupProviders`) with `allow_fallbacks: false`.
 */
export function checkSeatSpec(seat: SeatConfig, turn: Pick<ModelTurn, "usage" | "servedBy">): string | undefined {
  const out: string[] = [];
  if (reasoningDisabled(seat) && turn.usage.reasoningTokens > 0) out.push(`${turn.usage.reasoningTokens} reasoning tokens with reasoning disabled`);
  const pin = seat.extraBody?.provider as { order?: string[]; allow_fallbacks?: boolean } | undefined;
  const allowed = [...(pin?.order ?? []), ...(seat.backupProviders ?? [])];
  if (pin?.order?.length && pin.allow_fallbacks === false && turn.servedBy && !allowed.some((h) => sameHost(h, turn.servedBy!))) {
    out.push(`served by ${turn.servedBy}, pinned to ${allowed.join(", ")}`);
  }
  return out.join("; ") || undefined;
}

/** OpenRouter pins hosts by slug ("google-vertex") but reports a display name ("Google"), so compare loosely. */
function sameHost(slug: string, servedBy: string): boolean {
  const norm = (h: string) => h.split("/")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
  const a = norm(slug), b = norm(servedBy);
  return a.startsWith(b) || b.startsWith(a);
}

const warned = new Set<string>();
function warnSpec(seat: string, violation: string) {
  const key = `${seat}:${violation.replace(/\d+/g, "#")}`;
  if (warned.has(key)) return;
  warned.add(key);
  info(`WARNING ${seat} broke its seat spec: ${violation} (every such call is marked specViolation in usage.jsonl and decisions.jsonl)`);
}

export const MATCH_NOTES_MAX_WORDS = 400;

export interface MatchNotesInput {
  game: number; yourWins: number; opponentWins: number; yourName: string; opponentName: string;
  previousNotes?: string; log: string[];
}
export interface MatchNotesResult {
  notes: string | null; usage: TokenUsage; modelCalls: number; toolCalls: Record<string, number>; error?: string;
  infraError?: boolean; timedOut?: boolean; truncated?: number; specViolation?: string;
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

export interface StudyResult {
  brief: string | null; usage: TokenUsage; modelCalls: number; toolCalls: Record<string, number>; error?: string;
  infraError?: boolean; timedOut?: boolean; truncated?: number; specViolation?: string;
}

/** Pre-draft cube study: one conversation that ends with submit_brief. */
export async function runCubeStudy(
  agent: LlmAgent, event: EventConfig, db: CardDb, kb: KnowledgeBase, cubeCards: string[], cubeName: string,
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
  let modelCalls = 0, knowledgeCalls = 0, truncated = 0;
  let specViolation: string | undefined;
  const result = (brief: string | null, extra: Partial<StudyResult> = {}): StudyResult =>
    ({ brief, usage, modelCalls, toolCalls, truncated, specViolation, ...extra });
  const clock = new DecisionClock(Math.max(600, event.decisionTimeoutSec * 3) * 1000);
  try {
    for (let round = 0; round < event.maxToolCallsPerDecision * 2 + 3; round++) {
      let out;
      try { out = await agent.call({ system, messages, tools }, clock, round, onCall); }
      catch (e: any) { return result(null, failure(e, clock)); }
      modelCalls += out.calls; usage = addUsage(usage, out.usage); truncated += out.truncated; specViolation ??= out.specViolation;
      const turn = out.turn;
      messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls, raw: turn.raw });
      if (!turn.toolCalls.length) {
        if (turn.text.trim().length > 200) return result(capWords(turn.text, event.briefMaxWords));
        messages.push({ role: "user", content: "Please submit your brief with the submit_brief tool." });
        continue;
      }
      const results: { id: string; content: string; isError?: boolean }[] = [];
      for (const call of turn.toolCalls) {
        toolCalls[call.name] = (toolCalls[call.name] ?? 0) + 1;
        if (call.name === "submit_brief") {
          const b = String(call.input?.brief ?? "").trim();
          if (b) return result(capWords(b, event.briefMaxWords));
          results.push({ id: call.id, content: "Empty brief.", isError: true });
        } else if (knowledgeCalls++ >= event.maxToolCallsPerDecision * 2) {
          results.push({ id: call.id, content: "Tool budget used up. Submit your brief now.", isError: true });
        } else {
          results.push({ id: call.id, content: kb.run(call.name, call.input) });
        }
      }
      messages.push({ role: "tool", results });
    }
    return result(null, { error: "no brief submitted" });
  } finally { clock.stop(); }
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
