/**
 * Built-in reference agents ("anchors"). They keep ratings comparable across
 * benchmark versions and act as the fallback when an LLM fails to answer.
 *   random   — uniformly random legal choices; a floor.
 *   rank-bot — drafts by CubeCobra rank with colour commitment, builds a 2-colour
 *              23/17 deck, plays greedily. Also the fallback policy.
 *   forge-ai — drafts/builds like rank-bot; Forge's own AI plays its games.
 */
import { ZERO_USAGE } from "../analytics/recorder.ts";
import { type CardDb, getCard, isBasicLand } from "../cards/db.ts";
import type { DecisionRequest, DecisionResponse, DecideContext } from "../types.ts";
import { Rng } from "../util/rng.ts";
import type { AgentResult, DecisionAgent } from "./agent.ts";

export interface Bot { choose(req: DecisionRequest): DecisionResponse }

const BASIC_FOR: Record<string, string> = { W: "Plains", U: "Island", B: "Swamp", R: "Mountain", G: "Forest" };

export class RandomBot implements Bot {
  constructor(private rng: Rng, private db: CardDb) {}
  choose(req: DecisionRequest): DecisionResponse {
    if (req.kind === "deckbuild") return randomDeck(req, this.db, this.rng);
    // Tapping every offered source lets the engine pick a legal payment; a random subset usually can't pay.
    if (req.kind === "mana_payment") return { choice: req.options.map((o) => o.id) };
    const ids = this.rng.shuffle(req.options.map((o) => o.id));
    const hi = Math.min(req.max, ids.length);
    let k = req.min + this.rng.int(hi - req.min + 1);
    if (req.kind === "blockers") {
      // one assignment per blocker
      const used = new Set<string>(); const out: string[] = [];
      for (const id of ids) { const b = id.split("->")[0]; if (!used.has(b) && out.length < k) { used.add(b); out.push(id); } }
      return { choice: out };
    }
    return { choice: ids.slice(0, k) };
  }
}

function randomDeck(req: DecisionRequest, db: CardDb, rng: Rng): DecisionResponse {
  const spells = req.options.filter((o) => !getCard(db, o.card ?? "")?.types.includes("Land"));
  const chosen = rng.shuffle([...spells]).slice(0, 23);
  return { choice: chosen.map((o) => o.id), basics: basicsFor(chosen.map((o) => o.card!), db, Math.max(0, Number(req.constraints?.minDeckSize ?? 40) - chosen.length)) };
}

function basicsFor(cards: string[], db: CardDb, n: number): Record<string, number> {
  const pips: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const name of cards) {
    const c = getCard(db, name);
    for (const sym of (c?.manaCost ?? "").split(/\s+/)) for (const col of Object.keys(pips)) if (sym.includes(col)) pips[col]++;
  }
  const total = Object.values(pips).reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  if (total === 0) { out.Plains = n; return out; }
  let assigned = 0;
  const entries = Object.entries(pips).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  for (const [col, v] of entries) { const k = Math.floor((v / total) * n); out[BASIC_FOR[col]] = k; assigned += k; }
  for (let i = 0; assigned < n; i++, assigned++) out[BASIC_FOR[entries[i % entries.length][0]]]++;
  return out;
}

export class RankBot implements Bot {
  constructor(private db: CardDb, private rankings: Map<string, number>, private rng: Rng) {}

  private score(name?: string): number {
    if (!name) return 0;
    const r = this.rankings.get(name.toLowerCase());
    return r ? 1 - Math.min(r, 20000) / 20000 : 0.3; // unranked cards: middling
  }

  choose(req: DecisionRequest): DecisionResponse {
    switch (req.kind) {
      case "draft_pick": return this.draftPick(req);
      case "deckbuild": return this.build(req);
      case "mulligan": {
        const lands = Number(req.hints?.handLands ?? 3);
        const size = Number(req.hints?.handSize ?? 7);
        const keep = size <= 5 || (lands >= 2 && lands <= 5);
        return { choice: [req.options.find((o) => o.meta?.keep === keep)?.id ?? req.options[0].id] };
      }
      case "priority": {
        const land = req.options.find((o) => o.meta?.type === "land");
        if (land) return { choice: [land.id] };
        const spells = req.options.filter((o) => o.meta?.type === "spell" && o.meta?.sorcerySpeedOk !== false)
          .sort((a, b) => (b.meta?.cmc ?? 0) - (a.meta?.cmc ?? 0));
        if (spells.length) return { choice: [spells[0].id] };
        const pass = req.options.find((o) => o.meta?.type === "pass") ?? req.options[0];
        return { choice: [pass.id] };
      }
      case "attackers": {
        // attack with creatures that aren't obviously walking into a bigger blocker
        const maxBlockerPower = Number(req.hints?.opponentMaxUntappedPower ?? 0);
        const pick = req.options.filter((o) => (o.meta?.toughness ?? 0) > maxBlockerPower || (o.meta?.evasive ?? false));
        return { choice: pick.slice(0, req.max).map((o) => o.id) };
      }
      case "blockers": {
        // block when the blocker survives, or chump the biggest attacker if the attack is lethal
        const used = new Set<string>(); const out: string[] = [];
        const lethal = Boolean(req.hints?.incomingLethal);
        const opts = [...req.options].sort((a, b) => (b.meta?.attackerPower ?? 0) - (a.meta?.attackerPower ?? 0));
        for (const o of opts) {
          const m = o.meta ?? {};
          const b = o.id.split("->")[0];
          if (used.has(b) || out.length >= req.max) continue;
          if (m.blockerSurvives || m.killsAttacker || (lethal && out.length === 0)) { used.add(b); out.push(o.id); }
        }
        return { choice: out.length >= req.min ? out : req.options.slice(0, req.min).map((o) => o.id) };
      }
      case "mana_payment":
        return { choice: req.options.map((o) => o.id) };
      case "play_draw":
        return { choice: [req.options.find((o) => o.id === "yes")?.id ?? req.options[0].id] };
      case "london_bottom":
      case "discard": {
        const sorted = [...req.options].sort((a, b) => this.score(a.card) - this.score(b.card));
        return { choice: sorted.slice(0, req.min).map((o) => o.id) };
      }
      case "targets": {
        // prefer targets that are marked hostile (opponent's stuff), else first
        const hostile = req.options.filter((o) => o.meta?.hostile);
        const pool = hostile.length >= req.min ? hostile : req.options;
        return { choice: pool.slice(0, Math.max(req.min, Math.min(1, req.max))).map((o) => o.id) };
      }
      default: {
        const k = Math.max(req.min, Math.min(req.max, 1));
        return { choice: req.options.slice(0, k).map((o) => o.id) };
      }
    }
  }

  private draftPick(req: DecisionRequest): DecisionResponse {
    const picks: string[] = (req.state as any)?.picks ?? [];
    const colorWeight: Record<string, number> = {};
    for (const p of picks) for (const col of getCard(this.db, p)?.colors ?? []) colorWeight[col] = (colorWeight[col] ?? 0) + this.score(p);
    const top2 = Object.entries(colorWeight).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c);
    const commit = Math.min(1, picks.length / 12); // colour discipline ramps up over pack 1
    let best = req.options[0], bestScore = -Infinity;
    for (const o of req.options) {
      const c = getCard(this.db, o.card ?? "");
      let s = this.score(o.card);
      if (c && top2.length) {
        const off = c.colors.filter((x) => !top2.includes(x)).length;
        s += c.colors.length === 0 ? 0.05 : off === 0 ? 0.15 * commit : -0.3 * commit * off;
      }
      s += this.rng.next() * 1e-6;
      if (s > bestScore) { bestScore = s; best = o; }
    }
    return { choice: [best.id] };
  }

  private build(req: DecisionRequest): DecisionResponse {
    const minDeck = Number(req.constraints?.minDeckSize ?? 40);
    const colorScore: Record<string, number> = {};
    for (const o of req.options) for (const col of getCard(this.db, o.card ?? "")?.colors ?? []) colorScore[col] = (colorScore[col] ?? 0) + this.score(o.card);
    const top2 = Object.entries(colorScore).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c);
    const isLand = (o: { card?: string }) => getCard(this.db, o.card ?? "")?.types.includes("Land") ?? false;
    const onColor = req.options.filter((o) => {
      const c = getCard(this.db, o.card ?? "");
      return c && !isLand(o) && !isBasicLand(c.name) && c.colors.every((x) => top2.includes(x));
    }).sort((a, b) => this.score(b.card) - this.score(a.card));
    const spells = onColor.slice(0, 23);
    if (spells.length < 23) {
      const rest = req.options.filter((o) => !spells.includes(o) && !isLand(o)).sort((a, b) => this.score(b.card) - this.score(a.card));
      spells.push(...rest.slice(0, 23 - spells.length));
    }
    const basicsNeeded = Math.max(0, minDeck - spells.length);
    return { choice: spells.map((o) => o.id), basics: basicsFor(spells.map((o) => o.card!), this.db, basicsNeeded), rationale: `rank-bot ${top2.join("")}` };
  }
}

/** Adapts a synchronous Bot into a DecisionAgent (zero tokens). */
export class BotAgent implements DecisionAgent {
  constructor(readonly kind: string, private bot: Bot) {}
  get model() { return this.kind; }
  async decide(req: DecisionRequest, _ctx: DecideContext): Promise<AgentResult> {
    return { response: this.bot.choose(req), usage: ZERO_USAGE, modelCalls: 0, toolCalls: {}, invalidAttempts: 0 };
  }
}
