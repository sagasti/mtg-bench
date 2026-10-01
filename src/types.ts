/**
 * Core decision protocol. Every choice an agent makes — a draft pick, a deck,
 * a mulligan, casting a spell, declaring blockers — is one DecisionRequest
 * answered by one DecisionResponse. Engines (mock or Forge) and the draft /
 * deckbuild phases all speak this shape, so agents never see engine internals.
 */

export type Phase = "study" | "draft" | "deckbuild" | "game";

export type DecisionKind =
  | "draft_pick"      // choose 1 card from the current pack
  | "deckbuild"       // choose main-deck cards from pool + basic land counts
  | "mulligan"        // keep / mulligan
  | "london_bottom"   // choose N cards to put on the bottom after mulligan
  | "priority"        // play a land / cast / activate, or pass
  | "targets"         // choose targets for the spell/ability just chosen
  | "attackers"       // choose attacking creatures (and whom they attack)
  | "blockers"        // choose blocker -> attacker assignments
  | "choose_entity"   // generic "choose one of these" from an effect
  | "choose_cards"    // generic "choose between min and max cards"
  | "confirm"         // generic yes / no
  | "discard"         // discard to hand size / discard effects
  | "play_draw"       // play or draw first
  | "choose_ability"  // which version of a spell/ability (alternative additional costs, ...)
  | "optional_costs"  // kicker, buyback, entwine, ...
  | "announce_x"      // value of X (or other announced numbers)
  | "choose_mode"     // modes of charms / modal spells
  | "divide"          // divide damage/counters among targets
  | "cost_choice"     // which cards pay a sacrifice/discard/exile/tap cost, delve
  | "mana_payment"    // which mana sources to tap
  | "pay_or_else"     // "counter unless you pay {3}" etc.
  | "order_triggers" | "order_library" | "scry_order" | "surveil_order"   // one pick at a time: "which is first?"
  | "assign_damage"   // split combat damage among blockers (and player, with trample)
  | "exert"
  | "scry" | "surveil" | "search"
  | "choose_number" | "choose_color" | "choose_option"
  | "cube_study";     // pre-draft strategy brief (free text, not an option choice)

export interface DecisionOption {
  /** Stable id the agent returns. Opaque to the agent. */
  id: string;
  /** Human-readable description shown to the agent. */
  label: string;
  /** Card name when the option is (or is about) a single card. */
  card?: string;
  /** Structured hints for built-in bots (never shown to LLM agents). */
  meta?: Record<string, any>;
}

export interface DecisionRequest {
  requestId: string;
  phase: Phase;
  kind: DecisionKind;
  /** Plain-language instruction for this decision. */
  prompt: string;
  /** Player-filtered view of the world (never contains hidden info). */
  state: unknown;
  options: DecisionOption[];
  /** How many option ids must be returned. */
  min: number;
  max: number;
  /** Pre-computed hints for built-in bots only. Never rendered into LLM prompts. */
  hints?: Record<string, unknown>;
  /** Extra constraints the harness validates (e.g. deck size). */
  constraints?: Record<string, unknown>;
}

export interface DecisionResponse {
  choice: string[];
  /** deckbuild only: basic land name -> count. */
  basics?: Record<string, number>;
  /** Free-form scratchpad the agent wants carried to its next decision. */
  notes?: string;
  /** Optional short rationale, logged for analysis (never shown to opponents). */
  rationale?: string;
  /** Set by the harness: the agent failed this decision and this is the null action standing in for it. */
  forfeit?: boolean;
}

/** Everything an agent is told about who it is in this event. */
export interface SeatContext {
  seatId: string;
  eventId: string;
  podIndex: number;
}

export interface Agent {
  readonly seatId: string;
  readonly kind: string; // provider name, e.g. "anthropic", "random"
  decide(req: DecisionRequest, ctx: DecideContext): Promise<DecisionResponse>;
}

export interface DecideContext {
  pod: number;
  matchId?: string;
  game?: number;
  /** Carry-over scratchpad for this phase (draft notes flow into deckbuild). */
  notes?: string;
  /** The seat's own pre-draft cube strategy brief, if cube study is enabled. */
  brief?: string;
}

/** Validate a response against a request. Returns an error string or null. */
export function validateResponse(req: DecisionRequest, res: DecisionResponse): string | null {
  if (!res || !Array.isArray(res.choice)) return "response.choice must be an array of option ids";
  const ids = new Set(req.options.map((o) => o.id));
  const seen = new Set<string>();
  for (const c of res.choice) {
    if (!ids.has(c)) return `unknown option id "${c}"`;
    if (seen.has(c)) return `duplicate option id "${c}"`;
    seen.add(c);
  }
  if (res.choice.length < req.min || res.choice.length > req.max) {
    return `must choose between ${req.min} and ${req.max} options, got ${res.choice.length}`;
  }
  if (req.kind === "deckbuild") {
    const basics = res.basics ?? {};
    const allowed = new Set(["Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes"]);
    let nb = 0;
    for (const [k, v] of Object.entries(basics)) {
      if (!allowed.has(k)) return `unknown basic land "${k}"`;
      if (!Number.isInteger(v) || v < 0) return `basic land count for ${k} must be a non-negative integer`;
      nb += v;
    }
    const size = res.choice.length + nb;
    const minDeck = Number(req.constraints?.minDeckSize ?? 40);
    if (size < minDeck) return `deck has ${size} cards; minimum is ${minDeck}`;
  }
  if (req.kind === "blockers") {
    // each blocker may appear in at most one assignment (no multi-block support in v1)
    const blockers = new Set<string>();
    for (const c of res.choice) {
      const b = c.split("->")[0];
      if (blockers.has(b)) return `creature ${b} assigned to block more than once`;
      blockers.add(b);
    }
  }
  return null;
}
