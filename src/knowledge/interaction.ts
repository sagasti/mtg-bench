/**
 * Pilot patch (mtg-rival): "Their open mana" — what the opponent can do at instant speed right now and what answers
 * are still in their list, rendered into in-game prompts when event.openMana is on. Reads the opponent's untapped
 * mana sources, their hand size, and (when the plans file identifies their archetype and lists its deck) the
 * instant-speed cards of that list not yet seen that their open mana can pay for, plus the sorcery-speed answers
 * left. Also the mana this seat keeps after each castable card in hand (to pay a Spell Pierce-style tax). Facts
 * only; the same section for every seat.
 */
import fs from "node:fs";
import { type CardDb, type CardDef, getCard, prettyCost } from "../cards/db.ts";
import type { DecisionRequest } from "../types.ts";
import { type GameState, type Perm, type Side, isLand, landColors, parseForgeCost, permText, typeLine } from "./damage.ts";
import { opponentArchetype } from "./plans.ts";

const KINDS = new Set(["priority", "targets", "attackers"]);
const ANSWER_RE = /destroy target|exile target|target creature|sacrifices? (a|an|one|two|each) creature|each creature|creatures (you don't control|your opponents control) get|counter target|deals? \d+ damage to (any target|target creature)|return target (creature|nonland permanent|permanent)|tap target creature/i;

interface Mana { total: number; byColor: Record<string, number> }

function openSources(side: Side, db: CardDb): Mana {
  const mana: Mana = { total: 0, byColor: {} };
  const add = (colors: string[]) => { mana.total++; for (const c of colors) mana.byColor[c] = (mana.byColor[c] ?? 0) + 1; };
  for (const p of side.battlefield ?? []) {
    if (p.tapped) continue;
    if (isLand(p, db)) { add(landColors(p, db)); continue; }
    const t = permText(p, db);
    const m = t.match(/(?:\{T\}|Sacrifice [^:]*): Add \{([WUBRGC])\}/i) ?? t.match(/(?:\{T\}|Sacrifice [^:]*): Add one mana of any color/i);
    if (m && (!p.pt || !p.summoningSick)) add(m[1] ? [m[1].toUpperCase()] : ["W", "U", "B", "R", "G"]);
  }
  return mana;
}

const payable = (cost: { mana: number; pips: Record<string, number> }, m: Mana) =>
  cost.mana <= m.total && Object.entries(cost.pips).every(([c, k]) => k <= (m.byColor[c] ?? 0));

const colorsText = (m: Mana) => Object.entries(m.byColor).filter(([c]) => c !== "C").map(([c, k]) => c.repeat(k)).join(" ") || (m.total ? "colorless only" : "");

/** "4 Baleful Strix" lines of the [main] section of a Forge .dck file. */
function readDeck(file: string): Map<string, number> {
  const counts = new Map<string, number>();
  let section = "main";
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const l = raw.trim();
    if (/^\[/.test(l)) { section = l.toLowerCase(); continue; }
    if (section !== "[main]" && section !== "main") continue;
    const m = l.match(/^(\d+)\s+(.+?)(?:\|.*)?$/);
    if (m) counts.set(m[2], (counts.get(m[2]) ?? 0) + Number(m[1]));
  }
  return counts;
}

function seenCounts(st: GameState): Map<string, number> {
  const seen = new Map<string, number>();
  const bump = (n?: string) => { if (n) seen.set(n, (seen.get(n) ?? 0) + 1); };
  const opp = st.opponent ?? {};
  for (const p of opp.battlefield ?? []) bump(p.name);
  for (const n of opp.graveyard ?? []) bump(n);
  for (const n of opp.exile ?? []) bump(n);
  for (const s of st.stack ?? []) if (s.controller === "opponent") bump(s.source);
  return seen;
}

/** What a known instant-speed card does, in a few words, and any tax on us. */
function describe(c: CardDef, st: GameState, db: CardDb): string {
  const o = c.oracle;
  const bits: string[] = [];
  if (/counter target spell/i.test(o)) {
    const tax = o.match(/unless its controller pays \{(\d+)\}/i);
    const only = o.match(/counter target (noncreature|creature|instant or sorcery|artifact or enchantment) spell/i);
    bits.push(`counters ${only ? `a ${only[1]} spell` : "any spell"}${tax ? ` unless you pay {${tax[1]}}` : ""}`);
    const x = o.match(/mana value X or less, where X is the number of (\w+)s? you control/i);
    if (x) { const n = (st.opponent?.battlefield ?? []).filter((p) => new RegExp(`\\b${x[1]}\\b`, "i").test(typeLine(p, db)) || new RegExp(`\\b${x[1]}\\b`, "i").test(p.text ?? "")).length + 1; bits.push(`mana value ≤ ${n} (their ${x[1]}s after it enters)`); }
  }
  if (/destroy target/i.test(o)) bits.push(o.match(/destroy target [^.]*/i)![0].toLowerCase());
  if (/exile target creature/i.test(o)) bits.push("exiles target creature");
  if (/^tap target creature/im.test(o)) bits.push("taps target creature");
  if (/deals? (\d+|X) damage/i.test(o) && !/counter target/i.test(o)) bits.push(o.match(/deals? (\d+|X) damage[^.]*/i)![0].toLowerCase());
  if (/gets? -\d+\/-\d+|get -\d+\/-\d+/i.test(o)) bits.push(o.match(/[^.]*-\d+\/-\d+[^.]*/i)![0].trim().toLowerCase());
  if (/sacrifices? a creature/i.test(o)) bits.push("edict: " + (o.match(/sacrifices? a creature[^.]*/i)![0].toLowerCase()));
  if (/return target/i.test(o)) bits.push(o.match(/return target [^.]*/i)![0].toLowerCase());
  const mineHex = (st.you?.battlefield ?? []).some((p) => p.pt && /\bHexproof\b/i.test(p.text ?? ""));
  if (mineHex && /target creature/i.test(o) && !/counter target/i.test(o)) bits.push("your hexproof creatures are immune");
  return bits.length ? bits.join("; ") : o.split("\n")[0].slice(0, 70);
}

export function openMana(req: DecisionRequest, db: CardDb, plansFile?: string): string | undefined {
  if (req.phase !== "game" || !KINDS.has(req.kind)) return undefined;
  const st = req.state as GameState | undefined;
  if (!st?.you || !st.opponent) return undefined;
  const opp = st.opponent;
  const lines: string[] = [];
  const open = openSources(opp, db);
  const handSize = opp.handSize ?? (opp.hand?.length ?? 0);
  if (!open.total) lines.push(`Opponent is TAPPED OUT (no untapped mana source) with ${handSize} card${handSize === 1 ? "" : "s"} in hand: nothing can be countered or killed at instant speed this turn.`);
  else lines.push(`Opponent has ${open.total} untapped mana source${open.total === 1 ? "" : "s"} (${colorsText(open)}) and ${handSize} card${handSize === 1 ? "" : "s"} in hand.`);

  const scan = scanAnswers(req, db, plansFile);
  if (scan) {
    const { live, dead, later } = scan;
    const fmt = (a: Answer) => `${a.name} ×${a.left} (${prettyCost(a.card.manaCost) || "free"}${a.free}: ${describe(a.card, st, db)})`;
    if (open.total) lines.push(live.length ? `Instant-speed answers left in their list that the open mana can pay now: ${live.map(fmt).join("; ")}.` : `No instant-speed answer left in their list is castable with that open mana.`);
    if (dead.length) lines.push(`Left in their list but NOT castable with the open mana${open.total ? "" : " (tapped out)"}: ${dead.map((a) => `${a.name} ×${a.left}`).join(", ")}.`);
    if (later.length) lines.push(`Sorcery-speed answers still unseen: ${later.map((a) => `${a.name} ×${a.left}`).join(", ")}.`);
  }

  // --- our mana after each castable card (to keep a tax up, or to see what a bait leaves) ---------------------------
  const myTurn = st.activePlayer === "you";
  const phase = String(st.phase ?? "");
  if (myTurn && (phase === "MAIN1" || phase === "MAIN2") && req.kind === "priority") {
    const mine = openSources(st.you, db);
    const tokenMana = (st.you.battlefield ?? []).filter((p) => !p.tapped && p.pt && /Sacrifice [^:]*: Add/i.test(permText(p, db))).length;
    const hand = st.you.hand ?? [];
    if ((st.you.landsPlayedThisTurn ?? 0) === 0) { const land = hand.find((h) => isLand(h, db)); if (land) { mine.total++; for (const c of landColors(land, db)) mine.byColor[c] = (mine.byColor[c] ?? 0) + 1; } }
    const after: string[] = [];
    for (const h of hand) {
      const c = getCard(db, h.name);
      if (!c || isLand(h, db)) continue;
      const cost = parseForgeCost(c.manaCost);
      if (!cost || cost.x) continue;
      if (payable(cost, mine)) after.push(`${h.name} (${cost.mana}) → ${mine.total - cost.mana}`);
    }
    if (after.length) lines.push(`Your mana this turn: ${mine.total}${tokenMana ? ` (${tokenMana} of it only by SACRIFICING a creature token: do not count it for a spell that targets that token)` : ""}. Mana left after casting one card: ${after.join(", ")}.`);
    const plan = castingPlan(req, db, plansFile);
    if (plan) for (const l of plan.text) lines.push(l);
  }
  return `## Their open mana\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Answers in the opponent's known list, and the casting order against their live counters.

interface Answer { name: string; left: number; card: CardDef; free: string; can: boolean; instantSpeed: boolean }

/** The opponent's known list minus what they have shown, split by what their open mana can pay right now. */
export function scanAnswers(req: DecisionRequest, db: CardDb, plansFile?: string): { live: Answer[]; dead: Answer[]; later: Answer[] } | undefined {
  const st = req.state as GameState | undefined;
  if (!st?.opponent) return undefined;
  const arch = plansFile ? opponentArchetype(req, plansFile) : undefined;
  if (!arch?.deckFile) return undefined;
  const opp = st.opponent;
  const open = openSources(opp, db);
  const deck = readDeck(arch.deckFile);
  const seen = seenCounts(st);
  const live: Answer[] = [], dead: Answer[] = [], later: Answer[] = [];
  for (const [name, n] of deck) {
    const c = getCard(db, name);
    if (!c || /\bLand\b/.test(c.types)) continue;
    const left = Math.max(0, n - (seen.get(name) ?? 0));
    if (!left) continue;
    const o = c.oracle;
    const instantSpeed = /\bInstant\b/.test(c.types) || /\bFlash\b/i.test(o) || c.keywords.some((k) => /^Flash$/i.test(k));
    const isAnswer = ANSWER_RE.test(o);
    const cost = parseForgeCost(c.manaCost) ?? { mana: 99, pips: {} };
    let free = "";
    const alt = o.match(/you may pay (\d+) life rather than pay this spell's mana cost/i);
    if (alt) {
      const cond = o.match(/^If you control an? (\w+),/im);
      const ok = !cond || (opp.battlefield ?? []).some((p) => new RegExp(`\\b${cond[1]}\\b`).test(typeLine(p, db)) || p.name === cond[1]);
      if (ok) free = ` or free for ${alt[1]} life`;
    }
    const can = open.total > 0 && (payable(cost, open) || !!free);
    const a: Answer = { name, left, card: c, free, can, instantSpeed };
    if (instantSpeed && (isAnswer || /counter target/i.test(o))) (can ? live : dead).push(a);
    else if (isAnswer) later.push(a);
  }
  return { live, dead, later };
}

export interface Counter { name: string; left: number; hard: boolean; tax: number; maxMv?: number; noncreatureOnly: boolean }

/** Counters the opponent can cast right now. */
export function liveCounters(req: DecisionRequest, db: CardDb, plansFile?: string): Counter[] {
  const scan = scanAnswers(req, db, plansFile);
  if (!scan) return [];
  const st = req.state as GameState;
  const out: Counter[] = [];
  for (const a of scan.live) {
    const o = a.card.oracle;
    if (!/counter target[^.]*spell/i.test(o)) continue;
    const tax = Number(o.match(/unless its controller pays \{(\d+)\}/i)?.[1] ?? 0);
    const only = o.match(/counter target (noncreature|creature|instant or sorcery) spell/i)?.[1];
    if (only && only !== "noncreature") continue;   // narrow counters (creature-only, instant-only) are not modelled
    let maxMv: number | undefined;
    const x = o.match(/mana value X or less, where X is the number of (\w+)s? you control/i);
    if (x) maxMv = (st.opponent?.battlefield ?? []).filter((p) => new RegExp(`\\b${x[1]}\\b`, "i").test(typeLine(p, db)) || new RegExp(`\\b${x[1]}\\b`, "i").test(p.text ?? "")).length + 1;
    const fixedMv = o.match(/mana value (\d+) or less/i);
    if (fixedMv && !x) maxMv = Number(fixedMv[1]);
    out.push({ name: a.name, left: a.left, hard: !tax && maxMv === undefined, tax, maxMv, noncreatureOnly: only === "noncreature" });
  }
  return out;
}

const BAIT_RE = /draw a card|scry \d|surveil \d|search your library|reveal the top|^Enchant land|^Enchant Forest/im;
interface Castable { id: string; name: string; cmc: number; role: "key" | "bait"; creature: boolean }

/**
 * Casting order for this main phase against the counters they can cast now: which spells are bait (cantrips, ramp)
 * and which are the ones that matter, the mana each line leaves, and — under sequencePolicy strict — the bait casts
 * that would leave a key spell without the mana to pay a Spell Pierce-style tax (those are dropped from the options).
 */
export function castingPlan(req: DecisionRequest, db: CardDb, plansFile?: string): { text: string[]; drop: { id: string; name: string; reason: string }[] } | undefined {
  if (req.phase !== "game" || req.kind !== "priority") return undefined;
  const st = req.state as GameState | undefined;
  if (!st?.you || !st.opponent || st.activePlayer !== "you" || !/^MAIN/.test(String(st.phase ?? "")) || (st.stack ?? []).length) return undefined;
  const mine = openSources(st.you, db);
  const hand = st.you.hand ?? [];
  let landFirst = "";
  if ((st.you.landsPlayedThisTurn ?? 0) === 0) { const land = hand.find((h) => isLand(h, db)); if (land) { mine.total++; for (const c of landColors(land, db)) mine.byColor[c] = (mine.byColor[c] ?? 0) + 1; landFirst = land.name; } }
  const creatures = (st.you.battlefield ?? []).filter((p) => p.pt);
  const haveTarget = creatures.some((p) => !p.token);
  const castables: Castable[] = [];
  for (const o of req.options) {
    const m = o.label.match(/^cast spell: your (.+?) \[Hand\]/); if (!m) continue;
    const c = getCard(db, m[1]); if (!c) continue;
    const cost = parseForgeCost(c.manaCost); if (!cost || cost.x || !payable(cost, mine)) continue;
    const aura = /\bAura\b/.test(c.types) && /^Enchant creature/m.test(c.oracle);
    if (aura && !haveTarget) continue;
    const creature = /\bCreature\b/.test(c.types);
    const role: Castable["role"] = creature || aura ? "key" : BAIT_RE.test(c.oracle) ? "bait" : "key";
    if (!castables.some((x) => x.name === c.name)) castables.push({ id: o.id, name: c.name, cmc: cost.mana, role, creature });
  }
  if (!castables.length) return undefined;
  const counters = liveCounters(req, db, plansFile);
  const open = openSources(st.opponent, db);
  const text: string[] = []; const drop: { id: string; name: string; reason: string }[] = [];
  const keys = castables.filter((c) => c.role === "key").sort((a, b) => b.cmc - a.cmc);
  const baits = castables.filter((c) => c.role === "bait").sort((a, b) => a.cmc - b.cmc);
  const names = (xs: Castable[]) => xs.map((c) => `${c.name} (${c.cmc})`).join(", ");
  if (!counters.length) {
    text.push(open.total ? `No counter of theirs is live right now: cast what you want this turn${landFirst ? `, land (${landFirst}) first` : ""}. Spells that matter: ${names(keys) || "none"}; cantrips/ramp: ${names(baits) || "none"}.` : `They are tapped out: cast everything you want this turn${landFirst ? `, land (${landFirst}) first` : ""}.`);
    return { text, drop };
  }
  text.push(`Live counters: ${counters.map((c) => `${c.name} ×${c.left} (${c.hard ? "hard counter" : c.tax ? `unless you pay {${c.tax}}` : ""}${c.noncreatureOnly ? ", noncreature spells only" : ""}${c.maxMv !== undefined ? `, mana value ≤ ${c.maxMv}` : ""})`).join("; ")}.`);
  const taxers = counters.filter((c) => c.tax > 0);
  const hard = counters.filter((c) => c.hard);
  const sprite = counters.filter((c) => c.maxMv !== undefined);
  if (taxers.length) {
    const tax = Math.max(...taxers.map((c) => c.tax));
    const hits = (c: Castable) => taxers.some((t) => !t.noncreatureOnly || !c.creature);
    const plan: string[] = []; let left = mine.total;
    for (const k of keys) { if (k.cmc > left) { plan.push(`${k.name} (${k.cmc}) does not fit this turn`); continue; } const after = left - k.cmc; plan.push(`${k.name} (${k.cmc}) → ${after} left${hits(k) ? (after >= tax ? `, pays the {${tax}} tax ✔` : `, CANNOT pay the tax ✘`) : ""}`); left = after; }
    for (const b of baits) { if (left >= b.cmc) { left -= b.cmc; plan.push(`${b.name} (${b.cmc}) → ${left} left`); } }
    text.push(`Order against the tax: ${landFirst ? `play ${landFirst}, then ` : ""}${plan.join("; ")}. Cantrips and ramp go AFTER the spell that matters, never before.`);
    for (const k of keys) {
      if (!hits(k) || mine.total - k.cmc < tax) continue;   // a key spell that can be cast with the tax up
      for (const b of baits) if (mine.total - b.cmc - k.cmc < tax) drop.push({ id: b.id, name: b.name, reason: `cast first it leaves ${k.name} exposed to ${taxers.map((t) => t.name).join("/")}` });
      break;
    }
  }
  if (hard.length && castables.length >= 2) text.push(`${hard.map((c) => c.name).join("/")} live: lead with the spell you can afford to lose (${names(baits.length ? baits : keys.slice(-1))}), the one that matters second.`);
  if (sprite.length) { const n = Math.max(...sprite.map((c) => c.maxMv!)); const exposed = castables.filter((c) => c.cmc <= n), safe = castables.filter((c) => c.cmc > n); text.push(`${sprite.map((c) => c.name).join("/")} counters mana value ≤ ${n} right now: exposed ${names(exposed) || "nothing"}; out of its reach ${names(safe) || "nothing"}.`); }
  return { text, drop };
}
