/**
 * MOCK ENGINE — a deliberately simplified Magic engine used to test the harness
 * end-to-end without Forge. It is NOT a faithful rules engine and its results
 * must never be reported as benchmark results.
 *
 * Supported: lands (tap for their colours), creatures (P/T + Flying, Reach, Haste,
 * Vigilance, Defender, Lifelink, Deathtouch, Trample, First Strike), and sorcery-speed
 * spells parsed from Forge scripts: DealDamage, Destroy (creature), Draw, GainLife,
 * Pump (until end of turn), bounce (ChangeZone to hand). Everything else is not castable.
 * No stack, no instant-speed interaction, no triggered/activated abilities.
 */
import type { Seat } from "../../agents/agent.ts";
import { type CardDb, getCard, prettyCost } from "../../cards/db.ts";
import type { DecisionOption, DecisionRequest } from "../../types.ts";
import { Rng } from "../../util/rng.ts";
import { type GameEngine, type GameResult, type MatchResult, type MatchSpec, matchOver, matchWinner } from "../types.ts";

type Color = "W" | "U" | "B" | "R" | "G" | "C";
const KEYWORDS = ["Flying", "Reach", "Haste", "Vigilance", "Defender", "Lifelink", "Deathtouch", "Trample", "First Strike"];

interface SpellEffect { api: "DealDamage" | "Destroy" | "Draw" | "GainLife" | "Pump" | "Bounce"; amount: number; def?: number; target: "any" | "creature" | "player" | "none" }

interface Obj {
  id: string; name: string; owner: 0 | 1;
  isLand: boolean; isCreature: boolean;
  produces: Color[]; entersTapped: boolean;
  cost: string; cmc: number;
  power: number; toughness: number; keywords: Set<string>;
  effect?: SpellEffect;
  tapped: boolean; sick: boolean; damage: number; pumpP: number; pumpT: number; deathtouched: boolean;
}

interface PState { life: number; library: Obj[]; hand: Obj[]; battlefield: Obj[]; graveyard: Obj[]; landsPlayed: number; lost?: string }

function parseParams(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of line.split("|")) {
    const m = part.trim().match(/^([A-Za-z]+)\$\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function makeObj(db: CardDb, name: string, id: string, owner: 0 | 1): Obj {
  const c = getCard(db, name);
  const types = c?.types ?? "";
  const o: Obj = {
    id, name: c?.name ?? name, owner, isLand: types.includes("Land"), isCreature: types.includes("Creature"),
    produces: [], entersTapped: false, cost: c?.manaCost ?? "", cmc: c?.cmc ?? 0,
    power: 0, toughness: 0, keywords: new Set(), tapped: false, sick: true, damage: 0, pumpP: 0, pumpT: 0, deathtouched: false,
  };
  if (!c) return o;
  if (o.isLand) {
    const basics: Record<string, Color> = { Plains: "W", Island: "U", Swamp: "B", Mountain: "R", Forest: "G" };
    for (const [t, col] of Object.entries(basics)) if (types.includes(t)) o.produces.push(col);
    for (const a of c.abilities) {
      const p = parseParams(a);
      if (a.startsWith("AB$ Mana") && p.Produced) {
        const prod = p.Produced.replace(/^Combo\s+/, "");
        if (prod === "Any") o.produces.push("W", "U", "B", "R", "G");
        else for (const col of prod.split(/\s+/)) if ("WUBRGC".includes(col) && col) o.produces.push(col as Color);
      }
    }
    if (o.produces.length === 0) o.produces.push("C");
    o.produces = [...new Set(o.produces)];
    o.entersTapped = /enters (the battlefield )?tapped\./i.test(c.oracle) && !/unless/i.test(c.oracle);
  }
  if (o.isCreature) {
    const [p, t] = (c.pt ?? "0/0").split("/");
    o.power = Number.parseInt(p) || 0; o.toughness = Number.parseInt(t) || 1;
    for (const k of c.keywords) for (const kw of KEYWORDS) if (k.toLowerCase() === kw.toLowerCase()) o.keywords.add(kw);
  } else if (!o.isLand) {
    for (const a of c.abilities) {
      if (!a.startsWith("SP$")) continue;
      const p = parseParams(a);
      const api = a.slice(3).trim().split(/\s|\|/)[0];
      const tg = (p.ValidTgts ?? "").toLowerCase();
      const target: SpellEffect["target"] = !p.ValidTgts ? "none" : tg.startsWith("any") ? "any" : tg.includes("creature") ? "creature" : tg.includes("player") ? "player" : "none";
      const num = (s?: string) => { const n = Number.parseInt((s ?? "").replace("+", "")); return Number.isFinite(n) ? n : NaN; };
      if (api === "DealDamage" && Number.isFinite(num(p.NumDmg)) && target !== "none") o.effect = { api, amount: num(p.NumDmg), target };
      else if (api === "Destroy" && target === "creature") o.effect = { api, amount: 0, target };
      else if (api === "Draw" && (p.NumCards === undefined || Number.isFinite(num(p.NumCards)))) o.effect = { api, amount: num(p.NumCards) || 1, target: "none" };
      else if (api === "GainLife" && Number.isFinite(num(p.LifeAmount))) o.effect = { api, amount: num(p.LifeAmount), target: "none" };
      else if (api === "Pump" && target === "creature" && (Number.isFinite(num(p.NumAtt)) || Number.isFinite(num(p.NumDef))))
        o.effect = { api, amount: num(p.NumAtt) || 0, def: num(p.NumDef) || 0, target };
      else if (api === "ChangeZone" && p.Destination === "Hand" && target === "creature") o.effect = { api: "Bounce", amount: 0, target };
      break; // only the first spell ability
    }
  }
  return o;
}

/** Try to pay `cost` from untapped lands; returns the lands to tap or null. X costs are paid as 0. */
function findPayment(cost: string, lands: Obj[]): Obj[] | null {
  const syms = cost ? cost.trim().split(/\s+/) : [];
  const colored: Color[][] = [];
  let generic = 0;
  for (const s of syms) {
    if (/^\d+$/.test(s)) generic += Number(s);
    else if (s === "X" || s === "Y") continue;
    else {
      const parts = s.split("/").filter((x) => x !== "P");
      if (parts[0] === "2") { colored.push(parts.slice(1) as Color[]); continue; } // treat 2/W as W
      colored.push(parts as Color[]);
    }
  }
  const avail = lands.filter((l) => !l.tapped).sort((a, b) => a.produces.length - b.produces.length);
  const used = new Set<string>();
  const solve = (i: number): boolean => {
    if (i === colored.length) return true;
    for (const l of avail) {
      if (used.has(l.id)) continue;
      if (colored[i].some((c) => l.produces.includes(c))) {
        used.add(l.id);
        if (solve(i + 1)) return true;
        used.delete(l.id);
      }
    }
    return false;
  };
  if (!solve(0)) return null;
  const rest = avail.filter((l) => !used.has(l.id));
  if (rest.length < generic) return null;
  return [...avail.filter((l) => used.has(l.id)), ...rest.slice(0, generic)];
}

class MockGame {
  p: [PState, PState];
  turn = 0;
  active: 0 | 1;
  log: string[] = [];
  decisions: [number, number] = [0, 0];
  private seq = 0;
  constructor(private spec: MatchSpec, private db: CardDb, private rng: Rng, onThePlay: 0 | 1, private gameNo: number) {
    this.active = onThePlay;
    this.p = [0, 1].map((i) => {
      const lib = spec.decks[i].main.map((n, k) => makeObj(db, n, `k${i}${k}`, i as 0 | 1));
      return { life: 20, library: rng.shuffle(lib), hand: [], battlefield: [], graveyard: [], landsPlayed: 0 };
    }) as unknown as [PState, PState];
  }

  private note(s: string) { this.log.push(`T${this.turn}: ${s}`); if (this.log.length > 30) this.log.shift(); }
  private opp(i: 0 | 1): 0 | 1 { return (1 - i) as 0 | 1; }
  private who(viewer: 0 | 1, i: 0 | 1) { return viewer === i ? "you" : "opponent"; }

  private cardView(o: Obj, viewer: 0 | 1) {
    const v: Record<string, unknown> = { id: o.id, name: o.name };
    if (o.isCreature) {
      v.pt = `${o.power + o.pumpP}/${o.toughness + o.pumpT}`;
      if (o.damage) v.damage = o.damage;
      if (o.sick && !o.keywords.has("Haste") && o.owner === viewer) v.summoningSick = true;
    }
    if (o.tapped) v.tapped = true;
    return v;
  }

  view(viewer: 0 | 1, phase: string) {
    const me = this.p[viewer], op = this.p[this.opp(viewer)];
    return {
      game: this.gameNo, turn: this.turn, activePlayer: this.who(viewer, this.active), phase,
      youAre: viewer === 0 ? "P1" : "P2", // names used in recentLog
      you: {
        life: me.life, librarySize: me.library.length, landsPlayedThisTurn: me.landsPlayed,
        hand: me.hand.map((o) => ({ id: o.id, name: o.name })),
        battlefield: me.battlefield.map((o) => this.cardView(o, viewer)),
        graveyard: me.graveyard.map((o) => o.name),
      },
      opponent: {
        life: op.life, librarySize: op.library.length, handSize: op.hand.length,
        battlefield: op.battlefield.map((o) => this.cardView(o, viewer)),
        graveyard: op.graveyard.map((o) => o.name),
      },
      recentLog: this.log.slice(-12),
      engine: "mock (simplified rules: no stack, sorcery-speed only)",
    };
  }

  private async ask(i: 0 | 1, kind: DecisionRequest["kind"], prompt: string, phase: string, options: DecisionOption[], min: number, max: number, extraState: Record<string, unknown> = {}, hints?: Record<string, unknown>) {
    this.decisions[i]++;
    const req: DecisionRequest = {
      requestId: `${this.spec.matchId}-g${this.gameNo}-${++this.seq}`,
      phase: "game", kind, prompt, state: { ...this.view(i, phase), ...extraState }, options, min, max, hints,
    };
    const res = await this.spec.seats[i].decide(req, { pod: this.spec.pod, matchId: this.spec.matchId, game: this.gameNo });
    return res.choice;
  }

  private draw(i: 0 | 1, n = 1) {
    for (let k = 0; k < n; k++) {
      const c = this.p[i].library.shift();
      if (!c) { this.p[i].lost = "decked"; return; }
      this.p[i].hand.push(c);
    }
  }

  private sba() {
    for (const i of [0, 1] as const) {
      const ps = this.p[i];
      if (ps.life <= 0 && !ps.lost) ps.lost = "life";
      for (const o of [...ps.battlefield]) {
        if (o.isCreature && (o.damage >= o.toughness + o.pumpT || o.deathtouched || o.toughness + o.pumpT <= 0)) {
          ps.battlefield = ps.battlefield.filter((x) => x !== o);
          o.damage = 0; o.deathtouched = false; o.pumpP = 0; o.pumpT = 0; o.tapped = false;
          ps.graveyard.push(o);
          this.note(`${o.name} dies`);
        }
      }
    }
  }

  private over() { return this.p[0].lost || this.p[1].lost; }

  async mulligan(i: 0 | 1) {
    const ps = this.p[i];
    for (let mulls = 0; ; mulls++) {
      ps.library.push(...ps.hand); ps.hand = [];
      this.rng.shuffle(ps.library);
      this.draw(i, 7);
      if (mulls >= 3) { await this.bottom(i, mulls); return; }
      const lands = ps.hand.filter((o) => o.isLand).length;
      const choice = await this.ask(i, "mulligan",
        `Opening hand${mulls ? ` after ${mulls} mulligan(s)` : ""}. Keep, or mulligan (shuffle and draw 7, then put ${mulls + 1} card(s) on the bottom)?`,
        "mulligan",
        [{ id: "keep", label: `Keep this hand${mulls ? ` (then bottom ${mulls})` : ""}`, meta: { keep: true } },
         { id: "mulligan", label: `Mulligan to ${6 - mulls}`, meta: { keep: false } }],
        1, 1, { onThePlay: this.active === i }, { handLands: lands, handSize: 7 - mulls });
      if (choice[0] === "keep") { await this.bottom(i, mulls); return; }
      this.note(`${i === 0 ? "P1" : "P2"} mulligans`);
    }
  }

  private async bottom(i: 0 | 1, n: number) {
    if (n <= 0) return;
    const ps = this.p[i];
    const ids = await this.ask(i, "london_bottom", `Choose ${n} card(s) from your hand to put on the bottom of your library.`, "mulligan",
      ps.hand.map((o) => ({ id: o.id, label: o.name, card: o.name })), n, n);
    for (const id of ids) {
      const o = ps.hand.find((x) => x.id === id)!;
      ps.hand = ps.hand.filter((x) => x !== o);
      ps.library.push(o);
    }
  }

  private targetsFor(i: 0 | 1, eff: SpellEffect): DecisionOption[] {
    const opts: DecisionOption[] = [];
    if (eff.target === "any" || eff.target === "player") {
      opts.push({ id: `player${this.opp(i)}`, label: "Opponent", meta: { hostile: true } });
      opts.push({ id: `player${i}`, label: "You (yourself)", meta: { hostile: false } });
    }
    if (eff.target === "any" || eff.target === "creature") {
      for (const j of [0, 1] as const) for (const o of this.p[j].battlefield) if (o.isCreature) {
        opts.push({ id: o.id, label: `${o.name} ${o.power + o.pumpP}/${o.toughness + o.pumpT} (${j === i ? "yours" : "opponent's"})`, card: o.name, meta: { hostile: j !== i } });
      }
    }
    return opts;
  }

  /** One priority window for the active player in a main phase; returns false when they pass. */
  private async mainPhaseAction(i: 0 | 1, phase: string): Promise<boolean> {
    const ps = this.p[i];
    const lands = ps.battlefield.filter((o) => o.isLand);
    const options: DecisionOption[] = [{ id: "pass", label: phase === "main1" ? "Pass priority (go to combat)" : "Pass priority (end turn)", meta: { type: "pass" } }];
    for (const o of ps.hand) {
      if (o.isLand) {
        if (ps.landsPlayed < 1) options.push({ id: `play:${o.id}`, label: `Play land ${o.name}`, card: o.name, meta: { type: "land" } });
        continue;
      }
      if (!o.isCreature && !o.effect) continue; // not supported by the mock engine
      if (!findPayment(o.cost, lands)) continue;
      if (o.effect && o.effect.target !== "none" && this.targetsFor(i, o.effect).length === 0) continue;
      options.push({ id: `cast:${o.id}`, label: `Cast ${o.name} ${prettyCost(o.cost)}`, card: o.name, meta: { type: "spell", cmc: o.cmc } });
    }
    if (options.length === 1) return false;
    const [choice] = await this.ask(i, "priority", "You have priority in your main phase. Play a land, cast a spell, or pass.", phase, options, 1, 1);
    if (choice === "pass") return false;
    const [verb, id] = choice.split(":");
    const card = ps.hand.find((o) => o.id === id)!;
    if (verb === "play") {
      ps.hand = ps.hand.filter((o) => o !== card);
      card.tapped = card.entersTapped; card.sick = false;
      ps.battlefield.push(card); ps.landsPlayed++;
      this.note(`${i === 0 ? "P1" : "P2"} plays ${card.name}`);
      return true;
    }
    const pay = findPayment(card.cost, lands)!;
    for (const l of pay) l.tapped = true;
    ps.hand = ps.hand.filter((o) => o !== card);
    const tag = i === 0 ? "P1" : "P2";
    if (card.isCreature) {
      card.sick = true; card.tapped = false; card.damage = 0;
      ps.battlefield.push(card);
      this.note(`${tag} casts ${card.name}`);
      return true;
    }
    const eff = card.effect!;
    let target: string | undefined;
    if (eff.target !== "none") {
      const tOpts = this.targetsFor(i, eff);
      [target] = await this.ask(i, "targets", `Choose a target for ${card.name}.`, phase, tOpts, 1, 1, { casting: card.name });
    }
    this.resolve(i, card, eff, target);
    ps.graveyard.push(card);
    this.sba();
    return true;
  }

  private findCreature(id: string): Obj | undefined {
    return this.p[0].battlefield.find((o) => o.id === id) ?? this.p[1].battlefield.find((o) => o.id === id);
  }

  private resolve(i: 0 | 1, card: Obj, eff: SpellEffect, target?: string) {
    const tag = i === 0 ? "P1" : "P2";
    const tgtPlayer = target?.startsWith("player") ? (Number(target.slice(6)) as 0 | 1) : undefined;
    const tgtCreature = target && !target.startsWith("player") ? this.findCreature(target) : undefined;
    const tname = tgtPlayer !== undefined ? (tgtPlayer === 0 ? "P1" : "P2") : tgtCreature?.name ?? "nothing";
    switch (eff.api) {
      case "DealDamage":
        if (tgtPlayer !== undefined) this.p[tgtPlayer].life -= eff.amount;
        else if (tgtCreature) tgtCreature.damage += eff.amount;
        break;
      case "Destroy": if (tgtCreature) tgtCreature.deathtouched = true; break;
      case "Draw": this.draw(i, eff.amount); break;
      case "GainLife": this.p[i].life += eff.amount; break;
      case "Pump": if (tgtCreature) { tgtCreature.pumpP += eff.amount; tgtCreature.pumpT += eff.def ?? 0; } break;
      case "Bounce":
        if (tgtCreature) {
          const owner = this.p[tgtCreature.owner];
          for (const ps of this.p) ps.battlefield = ps.battlefield.filter((o) => o !== tgtCreature);
          tgtCreature.damage = 0; tgtCreature.pumpP = 0; tgtCreature.pumpT = 0; tgtCreature.tapped = false;
          owner.hand.push(tgtCreature);
        }
        break;
    }
    this.note(`${tag} casts ${card.name}${target ? ` targeting ${tname}` : ""}`);
  }

  private async combat(a: 0 | 1) {
    const d = this.opp(a);
    const attackersAvail = this.p[a].battlefield.filter((o) => o.isCreature && !o.tapped && !o.keywords.has("Defender") && (!o.sick || o.keywords.has("Haste")));
    if (!attackersAvail.length) return;
    const oppUntapped = this.p[d].battlefield.filter((o) => o.isCreature && !o.tapped);
    const maxBlockP = Math.max(0, ...oppUntapped.map((o) => o.power + o.pumpP));
    const atkIds = await this.ask(a, "attackers", "Declare attackers (all attack the opponent). Choose none to skip combat.", "declare_attackers",
      attackersAvail.map((o) => ({
        id: o.id, label: `${o.name} ${o.power + o.pumpP}/${o.toughness + o.pumpT}${o.keywords.size ? ` [${[...o.keywords].join(", ")}]` : ""}`, card: o.name,
        meta: { power: o.power + o.pumpP, toughness: o.toughness + o.pumpT, evasive: o.keywords.has("Flying") && !oppUntapped.some((b) => b.keywords.has("Flying") || b.keywords.has("Reach")) },
      })), 0, attackersAvail.length, {}, { opponentMaxUntappedPower: maxBlockP });
    const attackers = atkIds.map((id) => attackersAvail.find((o) => o.id === id)!).filter(Boolean);
    if (!attackers.length) return;
    for (const o of attackers) if (!o.keywords.has("Vigilance")) o.tapped = true;
    this.note(`${a === 0 ? "P1" : "P2"} attacks with ${attackers.map((o) => o.name).join(", ")}`);

    // blocks
    const blockersAvail = this.p[d].battlefield.filter((o) => o.isCreature && !o.tapped);
    const pairs: DecisionOption[] = [];
    const incoming = attackers.reduce((s, o) => s + o.power + o.pumpP, 0);
    for (const b of blockersAvail) for (const at of attackers) {
      if (at.keywords.has("Flying") && !(b.keywords.has("Flying") || b.keywords.has("Reach"))) continue;
      const bp = b.power + b.pumpP, bt = b.toughness + b.pumpT, ap = at.power + at.pumpP, att = at.toughness + at.pumpT;
      pairs.push({
        id: `${b.id}->${at.id}`, label: `${b.name} ${bp}/${bt} blocks ${at.name} ${ap}/${att}`, card: b.name,
        meta: { attackerPower: ap, blockerSurvives: ap < bt - b.damage && !at.keywords.has("Deathtouch"), killsAttacker: bp >= att - at.damage || (b.keywords.has("Deathtouch") && bp > 0) },
      });
    }
    let blocks: string[] = [];
    if (pairs.length) {
      blocks = await this.ask(d, "blockers", "Declare blockers. Each of your creatures can block at most one attacker; several may block the same attacker.", "declare_blockers",
        pairs, 0, blockersAvail.length, { attackers: attackers.map((o) => this.cardView(o, d)) }, { incomingLethal: incoming >= this.p[d].life });
    }
    const blockMap = new Map<string, Obj[]>();
    for (const b of blocks) {
      const [bid, aid] = b.split("->");
      const blocker = blockersAvail.find((o) => o.id === bid); if (!blocker) continue;
      blockMap.set(aid, [...(blockMap.get(aid) ?? []), blocker]);
    }
    if (blocks.length) this.note(`${d === 0 ? "P1" : "P2"} blocks: ${blocks.map((b) => { const [x, y] = b.split("->"); return `${this.findCreature(x)?.name}→${this.findCreature(y)?.name}`; }).join(", ")}`);

    // damage (first strike step, then regular)
    for (const step of ["first", "regular"] as const) {
      const hits = (o: Obj) => (step === "first") === o.keywords.has("First Strike");
      for (const at of attackers) {
        if (!this.p[a].battlefield.includes(at)) continue;
        const blockers = (blockMap.get(at.id) ?? []).filter((b) => this.p[d].battlefield.includes(b));
        const wasBlocked = blockMap.has(at.id);
        if (hits(at)) {
          let dmg = at.power + at.pumpP;
          if (!wasBlocked) { this.dealToPlayer(at, d, dmg); }
          else {
            for (const b of blockers) {
              const lethal = at.keywords.has("Deathtouch") ? 1 : Math.max(0, b.toughness + b.pumpT - b.damage);
              const x = Math.min(dmg, lethal); if (x <= 0) continue;
              b.damage += x; if (at.keywords.has("Deathtouch")) b.deathtouched = true; dmg -= x;
              if (at.keywords.has("Lifelink")) this.p[a].life += x;
            }
            if (dmg > 0 && at.keywords.has("Trample")) this.dealToPlayer(at, d, dmg);
          }
        }
        for (const b of blockers) {
          if (!hits(b)) continue;
          const x = b.power + b.pumpP; if (x <= 0) continue;
          at.damage += x; if (b.keywords.has("Deathtouch")) at.deathtouched = true;
          if (b.keywords.has("Lifelink")) this.p[d].life += x;
        }
      }
      this.sba();
      if (this.over()) return;
    }
  }

  private dealToPlayer(src: Obj, to: 0 | 1, dmg: number) {
    if (dmg <= 0) return;
    this.p[to].life -= dmg;
    if (src.keywords.has("Lifelink")) this.p[src.owner].life += dmg;
    this.note(`${src.name} deals ${dmg} to ${to === 0 ? "P1" : "P2"}`);
  }

  private async cleanup(i: 0 | 1) {
    const ps = this.p[i];
    const excess = ps.hand.length - 7;
    if (excess > 0) {
      const ids = await this.ask(i, "discard", `Discard ${excess} card(s) down to 7.`, "cleanup", ps.hand.map((o) => ({ id: o.id, label: o.name, card: o.name })), excess, excess);
      for (const id of ids) { const o = ps.hand.find((x) => x.id === id)!; ps.hand = ps.hand.filter((x) => x !== o); ps.graveyard.push(o); }
    }
    for (const p of this.p) for (const o of p.battlefield) { o.damage = 0; o.pumpP = 0; o.pumpT = 0; }
  }

  async play(maxTurns: number): Promise<{ winner: 0 | 1 | null; reason: string }> {
    const first = this.active;
    await this.mulligan(first);
    await this.mulligan(this.opp(first));
    while (!this.over()) {
      this.turn++;
      if (this.turn > maxTurns) return { winner: null, reason: "turn-cap" };
      const a = this.active, ps = this.p[a];
      ps.landsPlayed = 0;
      for (const o of ps.battlefield) { o.tapped = false; o.sick = false; }
      if (!(this.turn === 1)) this.draw(a);
      if (this.over()) break;
      for (let k = 0; k < 15 && !this.over() && (await this.mainPhaseAction(a, "main1")); k++);
      if (!this.over()) await this.combat(a);
      for (let k = 0; k < 15 && !this.over() && (await this.mainPhaseAction(a, "main2")); k++);
      if (!this.over()) await this.cleanup(a);
      this.active = this.opp(a);
    }
    const l0 = this.p[0].lost, l1 = this.p[1].lost;
    if (l0 && l1) return { winner: null, reason: "simultaneous" };
    return { winner: l0 ? 1 : 0, reason: (l0 ?? l1)! };
  }
}

export class MockEngine implements GameEngine {
  readonly name = "mock";
  constructor(private db: CardDb) {}
  async playMatch(spec: MatchSpec): Promise<MatchResult> {
    const rng = new Rng(spec.seed);
    const games: GameResult[] = [];
    let onThePlay: 0 | 1 = rng.int(2) as 0 | 1;
    while (!matchOver(games, spec.gamesPerMatch)) {
      const t0 = Date.now();
      const g = new MockGame(spec, this.db, rng.fork(games.length), onThePlay, games.length + 1);
      let r: { winner: 0 | 1 | null; reason: string };
      try { r = await g.play(spec.maxGameTurns); }
      catch (e: any) { r = { winner: null, reason: `error: ${e?.message ?? e}` }; }
      games.push({ game: games.length + 1, winner: r.winner, onThePlay, turns: g.turn, reason: r.reason, decisions: g.decisions, durationMs: Date.now() - t0 });
      // loser of the previous game chooses; they choose to play
      if (r.winner !== null) onThePlay = (1 - r.winner) as 0 | 1;
    }
    return { matchId: spec.matchId, pod: spec.pod, round: spec.round, seats: [spec.seats[0].id, spec.seats[1].id], games, winner: matchWinner(games) };
  }
}
