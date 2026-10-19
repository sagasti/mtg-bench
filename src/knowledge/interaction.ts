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

  const arch = plansFile ? opponentArchetype(req, plansFile) : undefined;
  if (arch?.deckFile) {
    const deck = readDeck(arch.deckFile);
    const seen = seenCounts(st);
    const live: string[] = [], dead: string[] = [], later: string[] = [];
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
      const entry = `${name} ×${left} (${prettyCost(c.manaCost) || "free"}${free}: ${describe(c, st, db)})`;
      if (instantSpeed && (isAnswer || /counter target/i.test(o))) (can ? live : dead).push(entry);
      else if (isAnswer) later.push(`${name} ×${left}`);
    }
    if (open.total) lines.push(live.length ? `Instant-speed answers left in their list that the open mana can pay now: ${live.join("; ")}.` : `No instant-speed answer left in their list is castable with that open mana.`);
    if (dead.length) lines.push(`Left in their list but NOT castable with the open mana${open.total ? "" : " (tapped out)"}: ${dead.map((d) => d.replace(/ \(.*$/, "")).join(", ")}.`);
    if (later.length) lines.push(`Sorcery-speed answers still unseen: ${later.join(", ")}.`);
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
  }
  return `## Their open mana\n${lines.map((l) => `- ${l}`).join("\n")}`;
}
