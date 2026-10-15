/**
 * Pilot patch (mtg-rival): deterministic damage / lethal arithmetic rendered into in-game prompts when
 * event.damageMath is on. It reads only what the seat can legally see (its hand, both battlefields, graveyards, life
 * totals) plus the card database, so every seat gets exactly the same section. It states arithmetic (how much face
 * damage the visible cards can deal this turn, and a line that reaches it), never advice.
 *
 * Model (deliberately small, exact for mono-colour burn, approximate elsewhere):
 * - mana: untapped lands (+ the land drop still in hand on your turn) and sacrifice-for-mana tokens;
 * - spells: direct damage to a player parsed from oracle text, with mana cost, flashback (mana or "sacrifice a
 *   Mountain"), madness (needs a discard outlet cast the same turn), spectacle (if the opponent lost life this turn)
 *   and "sacrifice two Mountains rather than pay" alternative costs;
 * - triggers: "whenever you cast a noncreature / instant or sorcery / spell, ~ deals N damage to each opponent" on
 *   your battlefield and on creatures you cast this turn (cast first); "{T}: ~ deals N damage" pings once;
 * - combat: attackers available this turn, the opponent's untapped potential blockers, and which attackers they
 *   cannot block (flying / "can't be blocked"); trample, pump and lifegain are ignored.
 */
import { type CardDb, type CardDef, getCard, isBasicLand, prettyCost } from "../cards/db.ts";
import type { DecisionRequest } from "../types.ts";

const SKIP_KINDS = new Set([
  "play_draw", "mulligan", "london_bottom", "order_triggers", "order_library", "scry_order", "surveil_order", "scry", "surveil",
  "search", "mana_payment", "deckbuild", "draft_pick", "cube_study", "match_notes",
]);

interface Perm { id?: string; name: string; text?: string; pt?: string; tapped?: boolean; summoningSick?: boolean; token?: boolean; attacking?: string }
interface HandCard { id?: string; name: string }
interface Side { life?: number; hand?: HandCard[]; handSize?: number; battlefield?: Perm[]; graveyard?: string[]; exile?: string[]; landsPlayedThisTurn?: number }
interface GameState {
  phase?: string; activePlayer?: string; youAre?: string; you?: Side; opponent?: Side;
  stack?: { controller?: string; source?: string; description?: string }[]; combat?: Perm[]; recentLog?: string[];
}

const TARGETS = "any target|target player|target opponent|each opponent|each player|target creature or player|target player or planeswalker|target creature, player, or planeswalker|target opponent or planeswalker|that player|each opponent and each creature[^.]*?";
const DMG_RE = new RegExp(`deals? (\\d+|X) damage(?: divided as you choose)?(?: among [^.]*?)? to (?:${TARGETS})`, "i");
const DIVIDED_RE = /deals? (\d+) damage divided as you choose among/i;
const ETB_RE = new RegExp(`When(?:ever)? [^,.]*? enters(?: the battlefield)?, [^.]*?deals (\\d+) damage to (?:${TARGETS})`, "i");
const PER_NONCREATURE_RE = new RegExp(`Whenever you cast a noncreature spell, [^.]*?deals (\\d+) damage to (?:${TARGETS})`, "i");
const PER_INSTSORC_RE = new RegExp(`Whenever you cast an instant or sorcery spell, [^.]*?deals (\\d+) damage to (?:${TARGETS})`, "i");
const PER_SPELL_RE = new RegExp(`Whenever you cast a spell, [^.]*?deals (\\d+) damage to (?:${TARGETS})`, "i");
const PING_RE = new RegExp(`\\{T\\}: [^.]*?deals (\\d+) damage to (?:${TARGETS})`, "i");
const ALT_SAC_RE = /you may sacrifice (a|an|one|two|three|four|\d+) ([A-Za-z]+?)s? rather than pay/i;
const BLOOD_RE = /\{1\}, \{T\}, Discard a card, Sacrifice (?:this token|this artifact|[^:]*?): Draw a card/i;

const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4 };
const num = (w: string) => NUMBER_WORDS[w.toLowerCase()] ?? Number(w);

interface Mana { total: number; byColor: Record<string, number> }
interface Pips { mana: number; pips: Record<string, number>; x?: boolean }
interface Triggers { perNoncreature: number; perInstSorc: number; perSpell: number }
interface Outlet { slots: number; mandatory: number }

/** One way of using one card this turn (a card with two costs is two groups sharing a copy limit). */
interface Group {
  key: string;            // name|zone, shared copy limit
  label: string;          // how it reads in the line
  copies: number;
  mana: Pips;
  sac: { n: number; type: string } | null;
  madness: boolean;       // cast by discarding it to an outlet
  fromHand: boolean;      // leaves the hand by being cast normally (not by discard)
  dmg: number;
  dmgNote?: string;
  spell: boolean; creature: boolean; instSorc: boolean; instant: boolean;
  triggers: Triggers | null;   // a creature that, once on the battlefield, triggers on later spells
  outlet: Outlet | null;
  land: boolean;          // nonland card in hand? (for Grab the Prize's condition)
  requiresCast?: string;  // flashback of a card cast from hand earlier this turn: needs that many normal casts of it
}

export function damageMath(req: DecisionRequest, db: CardDb): string | undefined {
  if (req.phase !== "game" || SKIP_KINDS.has(req.kind)) return undefined;
  const st = req.state as GameState | undefined;
  if (!st?.you || !st.opponent || typeof st.opponent.life !== "number") return undefined;
  const you = st.you, opp = st.opponent;
  const oppLife = st.opponent.life;
  const phase = String(st.phase ?? "");
  const myTurn = st.activePlayer === "you";
  const instantOnly = !myTurn || phase === "END_OF_TURN" || phase === "CLEANUP";
  const lines: string[] = [];

  // --- mana -----------------------------------------------------------------------------------------------------
  const mana: Mana = { total: 0, byColor: {} };
  const addSource = (colors: string[]) => { mana.total++; for (const c of colors) mana.byColor[c] = (mana.byColor[c] ?? 0) + 1; };
  const battlefield = you.battlefield ?? [];
  let untappedLands = 0, tokenMana = 0, dorkMana = 0;
  const dorkNotes: string[] = [];
  const elves = countElves(st, db);
  for (const p of battlefield) {
    if (p.tapped) continue;
    if (isLand(p, db)) { untappedLands++; addSource(landColors(p, db)); continue; }
    const t = p.text ?? "";
    const m = t.match(/Sacrifice [^:]*: Add \{([WUBRGC])\}/i) ?? t.match(/Sacrifice [^:]*: Add one mana of any color/i);
    if (m) { tokenMana++; addSource(m[1] ? [m[1].toUpperCase()] : ["W", "U", "B", "R", "G"]); continue; }
    // mana creatures ("dorks"): untapped, not summoning sick (or haste); Priest of Titania-style "for each Elf" counted now
    if (p.pt && (!p.summoningSick || /\bHaste\b/i.test(permText(p, db)))) {
      const text = permText(p, db);
      const each = text.match(/\{T\}: Add \{([WUBRG])\} for each Elf/i);
      const one = text.match(/^\{T\}: Add \{([WUBRGC])\}\.?$/m) ?? text.match(/^\{T\}: Add one mana of any color\.?$/m);
      if (each) { for (let i = 0; i < elves; i++) addSource([each[1].toUpperCase()]); dorkMana += elves; dorkNotes.push(`${p.name} ${elves}`); }
      else if (one) { addSource(one[1] ? [one[1].toUpperCase()] : ["W", "U", "B", "R", "G"]); dorkMana++; dorkNotes.push(`${p.name} 1`); }
    }
  }
  const hand = you.hand ?? [];
  let landDrop: HandCard | undefined;
  if (myTurn && !instantOnly && (you.landsPlayedThisTurn ?? 0) === 0) {
    const lands = hand.filter((h) => isLand(h, db));
    landDrop = lands.find((h) => h.name === "Mountain") ?? lands.find((h) => isBasicLand(h.name)) ?? lands[0];
    if (landDrop) addSource(landColors(landDrop, db));
  }
  const landsTotal = battlefield.filter((p) => isLand(p, db)).length + (landDrop ? 1 : 0);
  const sacPool: Record<string, number> = {};
  const countSac = (p: { name: string }) => {
    const types = typeLine(p, db);
    for (const t of new Set([...types.split(/\s+/), p.name])) if (t) sacPool[t] = (sacPool[t] ?? 0) + 1;
  };
  for (const p of battlefield) countSac(p);
  if (landDrop) countSac(landDrop);

  // --- triggers already on the battlefield ------------------------------------------------------------------------
  const board: Triggers = { perNoncreature: 0, perInstSorc: 0, perSpell: 0 };
  const boardNotes: string[] = [];
  let pings = 0;
  const pingNotes: string[] = [];
  for (const p of battlefield) {
    const text = permText(p, db);
    const t = castTriggers(text);
    if (t) {
      board.perNoncreature += t.perNoncreature; board.perInstSorc += t.perInstSorc; board.perSpell += t.perSpell;
      boardNotes.push(`${p.name} ${triggerText(t)}`);
    }
    const ping = text.match(PING_RE);
    if (ping && !p.tapped && !(p.pt && p.summoningSick && !/\bHaste\b/i.test(text))) { pings += Number(ping[1]); pingNotes.push(`${p.name} {T}: ${ping[1]}`); }
  }

  // --- what the opponent lost this turn (spectacle) ----------------------------------------------------------------
  const oppLostLife = opponentLostLifeThisTurn(st);

  // --- groups: every way of using a visible card this turn -------------------------------------------------------
  const groups: Group[] = [];
  const handCount = new Map<string, number>();
  for (const h of hand) handCount.set(h.name, (handCount.get(h.name) ?? 0) + 1);
  for (const [name, copies] of handCount) {
    const c = getCard(db, name);
    if (!c) continue;
    for (const g of cardGroups(c, "hand", copies, you, db, oppLostLife)) groups.push(g);
  }
  const gyCount = new Map<string, number>();
  for (const n of you.graveyard ?? []) gyCount.set(n, (gyCount.get(n) ?? 0) + 1);
  for (const [name, copies] of gyCount) {
    const c = getCard(db, name);
    if (!c) continue;
    for (const g of cardGroups(c, "graveyard", copies, you, db, oppLostLife)) groups.push(g);
  }
  let bloodTokens = 0;
  for (const p of battlefield) if (!p.tapped && BLOOD_RE.test(p.text ?? "")) bloodTokens++;
  if (bloodTokens) groups.push({
    key: "Blood token|battlefield", label: "Blood token ({1}, {T}, discard a card: draw)", copies: bloodTokens,
    mana: { mana: 1, pips: {} }, sac: null, madness: false, fromHand: false, dmg: 0, spell: false, creature: false, instSorc: false,
    instant: true, triggers: null, outlet: { slots: 1, mandatory: 1 }, land: false,
  });
  const usable = groups.filter((g) => !instantOnly || g.instant);

  // --- best lines ---------------------------------------------------------------------------------------------------
  const nonlandInHand = hand.filter((h) => !isLand(h, db)).length;
  const best = search(usable, mana, sacPool, board, hand.length, nonlandInHand, landDrop?.name);

  // --- combat -------------------------------------------------------------------------------------------------------
  const oppCreatures = (opp.battlefield ?? []).filter((p) => p.pt);
  const oppBlockers = oppCreatures.filter((p) => !p.tapped);
  const attackPhases = ["UPKEEP", "DRAW", "MAIN1", "COMBAT_BEGIN", "COMBAT_DECLARE_ATTACKERS"];
  const canAttack = myTurn && (attackPhases.includes(phase) || phase === "") && !(phase === "COMBAT_DECLARE_ATTACKERS" && req.kind !== "attackers");
  const declared = (st.combat ?? []).filter((c) => c.attacking && c.attacking !== "you");
  let combatAll = 0, combatSure = 0;
  const attackerNotes: string[] = [];
  const sureNames: string[] = [];
  const attackers = canAttack
    ? battlefield.filter((p) => p.pt && !p.tapped && (!p.summoningSick || /\bHaste\b/i.test(permText(p, db))) && !/\bDefender\b/i.test(permText(p, db)))
    : declared;
  for (const a of attackers) {
    const pw = power(a.pt);
    combatAll += pw;
    attackerNotes.push(`${a.name} ${a.pt}`);
    if (unblockable(a, oppBlockers, db)) { combatSure += pw; sureNames.push(a.name); }
  }
  // --- tap pumps (Timberwatch Elf-style): activated after blockers on an attacker that got through; the source stays home
  let pumpNet = 0;
  const pumpNotes: string[] = [];
  if (attackers.length) {
    for (const p of battlefield) {
      if (!p.pt || p.tapped || (p.summoningSick && !/\bHaste\b/i.test(permText(p, db)))) continue;
      const m = permText(p, db).match(/\{T\}: Target creature gets \+(\d+|X)\/\+(\d+|X) until end of turn(?:, where X is the number of (Elves|creatures you control))?/i);
      if (!m) continue;
      const n = m[1] === "X" ? (/Elves/i.test(m[3] ?? "") ? elves : battlefield.filter((q) => q.pt).length) : Number(m[1]);
      const attacksToo = attackers.includes(p);
      const net = attacksToo ? n - power(p.pt) : n;
      if (net <= 0) continue;
      pumpNet += net;
      pumpNotes.push(`${p.name} {T}: +${n}/+${n} to one creature${attacksToo ? ` (net +${net}: it then stays home instead of attacking)` : ""}`);
    }
  }

  const leaves = (l: Line) => { const left = landsTotal - l.sacLands; return `afterwards you keep ${left} land${left === 1 ? "" : "s"}`; };
  // --- render -------------------------------------------------------------------------------------------------------
  lines.push(`Opponent life: ${oppLife}. Your life: ${you.life ?? "?"}.`);
  if (instantOnly) {
    const extra = [tokenMana ? `${tokenMana} from tokens` : "", dorkMana ? `${dorkMana} from mana creatures: ${dorkNotes.join(", ")}` : ""].filter(Boolean);
    lines.push(`Not your main phase: only instants and abilities count below. Untapped mana: ${mana.total}${extra.length ? ` (${extra.join("; ")})` : ""}.`);
  } else {
    const parts = [`${untappedLands} untapped land${untappedLands === 1 ? "" : "s"}`];
    if (landDrop) parts.push(`the land drop still in hand (${landDrop.name})`);
    if (tokenMana) parts.push(`${tokenMana} from tokens`);
    if (dorkMana) parts.push(`${dorkMana} from untapped mana creatures that are not summoning sick (${dorkNotes.join(", ")}; a creature tapped for mana cannot attack)`);
    lines.push(`Mana you can make this turn: ${mana.total} (${parts.join(" + ")}).${sacPool.Mountain ? ` Mountains you could sacrifice: ${sacPool.Mountain}.` : ""}`);
  }
  if (boardNotes.length) lines.push(`Triggers on your battlefield: ${boardNotes.join("; ")}.`);
  if (pingNotes.length) lines.push(`Tap abilities available now: ${pingNotes.join("; ")}.`);
  const cardNotes = usable.filter((g) => g.dmg > 0 || g.triggers || g.outlet).map(describeGroup);
  const merged = mergeByCard(cardNotes);
  if (merged.length) lines.push(`Per card (face damage, cost): ${merged.join("; ")}.`);
  const sure = pings + combatSure + (sureNames.length ? pumpNet : 0);
  if (best.any && best.any.dmg > 0) {
    const fixed = pings ? ` + ${pings} from tap abilities` : "";
    if (best.noSac && best.noSac.dmg > 0 && best.noSac.dmg < best.any.dmg) {
      lines.push(`Max face damage this turn without sacrificing lands: ${best.noSac.dmg + pings}${fixed} = ${best.noSac.line}.`);
      lines.push(`Max face damage this turn sacrificing lands: ${best.any.dmg + pings}${fixed} = ${best.any.line}. (Tap the Mountains for mana before sacrificing them; ${leaves(best.any)})`);
    } else {
      const sacNote = best.any.usesSac ? ` (sacrifices ${best.any.sacLands} land${best.any.sacLands === 1 ? "" : "s"}; ${leaves(best.any)})` : "";
      lines.push(`Max face damage this turn${instantOnly ? " at instant speed" : ""}: ${best.any.dmg + pings}${fixed}${sacNote} = ${best.any.line}.`);
    }
  } else if (pings) {
    lines.push(`Max face damage this turn: ${pings} from tap abilities; no damage spell castable with the mana available.`);
  } else {
    lines.push(`No face damage castable ${instantOnly ? "right now" : "this turn"} with the visible cards and mana.`);
  }
  if (attackers.length) {
    const who = canAttack ? "Attackers available this turn" : "Your declared attackers";
    const blockers = oppBlockers.length ? oppBlockers.map((b) => `${b.name} ${b.pt}${keywordsOf(permText(b, db))}`).join(", ") : "none";
    lines.push(`${who}: ${attackerNotes.join(", ")} (${combatAll} power). Opponent's untapped potential blockers: ${blockers}. Attackers they cannot block: ${sureNames.length ? `${sureNames.join(", ")} (${combatSure} power)` : "none"}.`);
  } else if (myTurn && !instantOnly && canAttack) {
    lines.push(`Attackers available this turn: none.`);
  }
  const spells = best.any?.dmg ?? 0;
  const spellsNoSac = best.noSac?.dmg ?? 0;
  const guaranteed = spells + sure;
  const optimistic = spells + pings + combatAll + pumpNet;
  if (pumpNotes.length) lines.push(`Pump from tap abilities, usable after blockers are declared: ${pumpNotes.join("; ")}. Counted below only on an attacker they cannot block.`);
  if (guaranteed >= oppLife) {
    const how = spellsNoSac + sure >= oppLife ? (best.any?.usesSac ? " without sacrificing lands" : "") : " using the land-sacrifice line";
    const shown = spellsNoSac + sure >= oppLife ? spellsNoSac : spells;
    lines.push(`LETHAL CHECK: ${shown + sure} (${shown} spells${pings ? ` + ${pings} tap abilities` : ""}${combatSure ? ` + ${combatSure} unblockable combat` : ""}${sureNames.length && pumpNet ? ` + ${pumpNet} pump` : ""}) >= ${oppLife}: lethal is available this turn${how}.`);
  } else if (optimistic >= oppLife && combatAll > combatSure) {
    lines.push(`LETHAL CHECK: ${guaranteed} guaranteed < ${oppLife}; ${optimistic} if every attacker goes unblocked (the opponent has ${oppBlockers.length} untapped blocker${oppBlockers.length === 1 ? "" : "s"}).`);
  } else {
    lines.push(`LETHAL CHECK: not lethal this turn: ${guaranteed} guaranteed${combatAll > combatSure ? `, ${optimistic} if every attacker goes unblocked` : ""} vs ${oppLife} (short by ${oppLife - guaranteed}).`);
  }

  // --- incoming combat ------------------------------------------------------------------------------------------------
  const incoming = (st.combat ?? []).filter((c) => c.attacking === "you");
  if (incoming.length) {
    const total = incoming.reduce((s, c) => s + power(c.pt), 0);
    const list = incoming.map((c) => `${c.name} ${c.pt}${keywordsOf(permText(c, db))}`).join(", ");
    const myBlockers = battlefield.filter((p) => p.pt && !p.tapped).map((p) => `${p.name} ${p.pt}`);
    const life = you.life ?? 0;
    lines.push(`Incoming combat damage if you block nothing: ${total} (${list}); your life ${life} -> ${life - total}${total >= life ? " = LETHAL ON YOU" : ""}. Your untapped creatures: ${myBlockers.length ? myBlockers.join(", ") : "none"}.`);
  }

  return `## Damage math\nComputed by the harness from the visible state: exact arithmetic for the cards listed, assuming no responses from the opponent; lifegain, trample and pump spells are not counted (only pump from tap abilities).\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

// ---------------------------------------------------------------------------------------------------------------------

function cardGroups(c: CardDef, zone: "hand" | "graveyard", copies: number, you: Side, db: CardDb, oppLostLife: boolean | undefined): Group[] {
  const out: Group[] = [];
  const types = c.types ?? "";
  const creature = /\bCreature\b/.test(types);
  const instant = /\bInstant\b/.test(types) || /\bFlash\b/.test(c.oracle);
  const instSorc = /\b(Instant|Sorcery)\b/.test(types);
  const land = /\bLand\b/.test(types) || isBasicLand(c.name);
  if (land) return out;
  const spellDmg = spellDamage(c, creature, you, db);
  const triggers = creature ? castTriggers(c.oracle) : null;
  const outlet = discardOutlet(c.oracle);
  const relevant = spellDmg.face > 0 || triggers || outlet;
  if (!relevant) return out;
  const base = {
    key: `${c.name}|${zone}`, copies, sac: null as Group["sac"], madness: false, dmg: spellDmg.face, dmgNote: spellDmg.note,
    spell: true, creature, instSorc, instant, triggers, outlet, land: false,
  };
  const kw = (name: string) => c.keywords.filter((k) => k.toLowerCase().startsWith(name.toLowerCase() + ":")).map((k) => k.slice(name.length + 1));
  if (zone === "hand") {
    const mana = parseForgeCost(c.manaCost);
    if (mana) out.push({ ...base, label: `${c.name} (${prettyCost(c.manaCost) || "free"})`, mana, fromHand: true });
    const alt = c.oracle.match(ALT_SAC_RE);
    if (alt) out.push({ ...base, label: `${c.name} (sacrifice ${alt[1]} ${alt[2]}${num(alt[1]) > 1 ? "s" : ""})`, mana: { mana: 0, pips: {} }, sac: { n: num(alt[1]), type: cap(alt[2]) }, fromHand: true });
    for (const cost of kw("Madness")) {
      const m = parseForgeCost(cost);
      if (m) out.push({ ...base, label: `${c.name} (madness ${prettyCost(cost)}, discarded to an outlet)`, mana: m, madness: true, fromHand: false });
    }
    if (oppLostLife) for (const cost of kw("Spectacle")) {
      const m = parseForgeCost(cost);
      if (m) out.push({ ...base, label: `${c.name} (spectacle ${prettyCost(cost)})`, mana: m, fromHand: true });
    }
    // Cast from hand, then flashed back from the graveyard the same turn.
    for (const cost of kw("Flashback")) {
      const parsed = parseForgeCostWithSac(cost);
      if (!parsed) continue;
      const how = parsed.sac ? `sacrifice ${parsed.sac.n === 1 ? "a" : parsed.sac.n} ${parsed.sac.type}${parsed.sac.n > 1 ? "s" : ""}` : prettyCost(cost);
      out.push({ ...base, key: `${c.name}|flashafter`, label: `flashback ${c.name} after casting it (${how})`, mana: parsed.mana, sac: parsed.sac, fromHand: false, requiresCast: c.name });
    }
  } else {
    for (const cost of kw("Flashback")) {
      const parsed = parseForgeCostWithSac(cost);
      if (!parsed) continue;
      const label = parsed.sac ? `flashback ${c.name} (sacrifice ${parsed.sac.n === 1 ? "a" : parsed.sac.n} ${parsed.sac.type}${parsed.sac.n > 1 ? "s" : ""})` : `flashback ${c.name} (${prettyCost(cost)})`;
      out.push({ ...base, label, mana: parsed.mana, sac: parsed.sac, fromHand: false });
    }
  }
  return out;
}

function spellDamage(c: CardDef, creature: boolean, you: Side, db: CardDb): { face: number; note?: string } {
  const oracle = c.oracle ?? "";
  if (creature || !/\b(Instant|Sorcery)\b/.test(c.types ?? "")) {
    const m = oracle.match(ETB_RE);
    return m ? { face: Number(m[1]), note: "when it enters" } : { face: 0 };
  }
  const div = oracle.match(DIVIDED_RE);
  if (div) return { face: Number(div[1]), note: "divided" };
  const m = oracle.match(DMG_RE);
  if (!m) return { face: 0 };
  if (m[1] === "X") return { face: 0, note: "X damage" };
  let face = Number(m[1]);
  let note: string | undefined;
  const sentence = sentenceAround(oracle, m.index ?? 0);
  if (/^if\b/i.test(sentence)) note = sentence.replace(/,.*$/, "").replace(/^If\s+/i, "if ");
  const instead = oracle.match(/deals (\d+) damage instead if you control three or more artifacts/i);
  if (instead) {
    const artifacts = (you.battlefield ?? []).filter((p) => /\bArtifact\b/.test(typeLine(p, db))).length;
    if (artifacts >= 3) face = Number(instead[1]); else note = `${instead[1]} with three artifacts`;
  }
  return { face, note };
}

function castTriggers(text: string): Triggers | null {
  const t: Triggers = { perNoncreature: 0, perInstSorc: 0, perSpell: 0 };
  const a = text.match(PER_NONCREATURE_RE); if (a) t.perNoncreature += Number(a[1]);
  const b = text.match(PER_INSTSORC_RE); if (b) t.perInstSorc += Number(b[1]);
  const c = text.match(PER_SPELL_RE); if (c) t.perSpell += Number(c[1]);
  return t.perNoncreature || t.perInstSorc || t.perSpell ? t : null;
}

function triggerText(t: Triggers): string {
  const parts: string[] = [];
  if (t.perNoncreature) parts.push(`+${t.perNoncreature} per noncreature spell you cast`);
  if (t.perInstSorc) parts.push(`+${t.perInstSorc} per instant or sorcery you cast`);
  if (t.perSpell) parts.push(`+${t.perSpell} per spell you cast`);
  return parts.join(", ");
}

function discardOutlet(oracle: string): Outlet | null {
  const m = oracle.match(/discard (a|one|two|three|\d+) cards?/i);
  if (!m) return null;
  const sentence = sentenceAround(oracle, m.index ?? 0);
  if (/(target|each) (player|opponent)[^.]*discards?/i.test(sentence)) return null;
  const n = num(m[1]);
  const mandatory = /as an additional cost/i.test(sentence) ? n : 0;
  return { slots: n, mandatory };
}

function sentenceAround(text: string, index: number): string {
  const start = text.lastIndexOf(".", index - 1) + 1;
  const endDot = text.indexOf(".", index);
  return text.slice(start, endDot < 0 ? undefined : endDot).replace(/\n/g, " ").trim();
}

/** Forge mana syntax: "1 R R", "R", "X R", "W/U", "" (no cost). Colourless {C} and hybrid are counted as generic. */
function parseForgeCost(cost: string): Pips | null {
  const out: Pips = { mana: 0, pips: {} };
  const c = (cost ?? "").trim();
  if (!c || c === "no cost") return out;
  for (const tok of c.split(/\s+/)) {
    if (/^\d+$/.test(tok)) { out.mana += Number(tok); continue; }
    if (/^[XYZ]$/.test(tok)) { out.x = true; continue; }
    if (/^[WUBRG]$/.test(tok)) { out.mana++; out.pips[tok] = (out.pips[tok] ?? 0) + 1; continue; }
    if (/^(C|S|[WUBRG2]\/[WUBRGP])$/.test(tok)) { out.mana++; continue; }
    return null;
  }
  return out;
}

/** A Forge cost string that may mix mana with Sac<n/Type>; other cost parts are unsupported. */
function parseForgeCostWithSac(cost: string): { mana: Pips; sac: Group["sac"] } | null {
  let sac: Group["sac"] = null;
  const manaToks: string[] = [];
  for (const tok of cost.trim().split(/\s+/)) {
    const m = tok.match(/^Sac<(\d+)\/([A-Za-z]+)>$/);
    if (m) { sac = { n: Number(m[1]), type: m[2] }; continue; }
    if (/^[A-Za-z]+</.test(tok)) return null;
    manaToks.push(tok);
  }
  const mana = parseForgeCost(manaToks.join(" "));
  return mana ? { mana, sac } : null;
}

// ---------------------------------------------------------------------------------------------------------------------

interface Line { dmg: number; line: string; usesSac: boolean; sacs: number; sacLands: number; cards: number }
interface Best { any: Line | null; noSac: Line | null }

const NODE_CAP = 400000;

/** Exhaustive search over how many copies of each group to use, pruned by mana and sacrifice pools. */
function search(groups: Group[], mana: Mana, sacPool: Record<string, number>, board: Triggers, handSize: number, nonlandInHand: number, landDrop?: string): Best {
  const best: Best = { any: null, noSac: null };
  const counts = new Array<number>(groups.length).fill(0);
  let nodes = 0;
  const limits = new Map<string, number>();
  for (const g of groups) limits.set(g.key, g.copies);
  const used = new Map<string, number>();
  const sacUsed: Record<string, number> = {};
  let manaUsed = 0; const pipsUsed: Record<string, number> = {};

  const evaluate = () => {
    let dmg = 0, noncreature = 0, instSorc = 0, spells = 0, slots = 0, mandatory = 0, madness = 0, castFromHand = 0, cards = 0, sacs = 0, sacLands = 0;
    const t: Triggers = { ...board };
    const chosen: { g: Group; n: number }[] = [];
    const castByName = new Map<string, number>();
    for (let i = 0; i < groups.length; i++) {
      const n = counts[i]; if (!n) continue;
      const g = groups[i];
      if (g.fromHand) castByName.set(g.key.split("|")[0], (castByName.get(g.key.split("|")[0]) ?? 0) + n);
    }
    for (let i = 0; i < groups.length; i++) {
      const n = counts[i]; if (!n) continue;
      const g = groups[i];
      if (g.requiresCast && n > (castByName.get(g.requiresCast) ?? 0)) return;
      chosen.push({ g, n });
      cards += n;
      if (g.spell) { spells += n; if (!g.creature) noncreature += n; if (g.instSorc) instSorc += n; }
      if (g.triggers) { t.perNoncreature += g.triggers.perNoncreature * n; t.perInstSorc += g.triggers.perInstSorc * n; t.perSpell += g.triggers.perSpell * n; }
      if (g.outlet) { slots += g.outlet.slots * n; mandatory += g.outlet.mandatory * n; }
      if (g.madness) madness += n;
      if (g.fromHand) castFromHand += n;
      if (g.sac) { sacs += n; sacLands += g.sac.n * n; }
    }
    // Discards: madness cards need a slot each; mandatory discards need a card in hand that isn't being cast normally.
    const fillers = handSize - castFromHand;
    if (madness > slots || fillers < Math.max(mandatory, madness)) return;
    const nonlandFillers = nonlandInHand - castFromHand;
    for (const { g, n } of chosen) {
      let d = g.dmg;
      if (g.dmgNote?.startsWith("if the discarded card") && !(madness > 0 || nonlandFillers > 0)) d = 0;
      dmg += d * n;
    }
    dmg += t.perNoncreature * noncreature + t.perInstSorc * instSorc + t.perSpell * spells;
    if (dmg <= 0) return;
    const better = (cur: Line | null) => !cur || dmg > cur.dmg || (dmg === cur.dmg && (sacs < cur.sacs || (sacs === cur.sacs && cards < cur.cards)));
    if (better(best.any) || (sacs === 0 && better(best.noSac))) {
      const prefix = landDrop && manaUsed > mana.total - 1 ? `play ${landDrop} -> ` : "";
      const line = prefix + describeLine(chosen, t, board, madness);
      const l: Line = { dmg, line, usesSac: sacs > 0, sacs, sacLands, cards };
      if (better(best.any)) best.any = l;
      if (sacs === 0 && better(best.noSac)) best.noSac = l;
    }
  };

  const rec = (i: number) => {
    if (++nodes > NODE_CAP) return;
    if (i === groups.length) { evaluate(); return; }
    const g = groups[i];
    const left = limits.get(g.key)! - (used.get(g.key) ?? 0);
    for (let n = 0; n <= left; n++) {
      if (n > 0) {
        // add one more copy
        manaUsed += g.mana.mana;
        for (const [c, k] of Object.entries(g.mana.pips)) pipsUsed[c] = (pipsUsed[c] ?? 0) + k;
        if (g.sac) sacUsed[g.sac.type] = (sacUsed[g.sac.type] ?? 0) + g.sac.n;
        used.set(g.key, (used.get(g.key) ?? 0) + 1);
        counts[i] = n;
        const ok = manaUsed <= mana.total && Object.entries(pipsUsed).every(([c, k]) => k <= (mana.byColor[c] ?? 0))
          && Object.entries(sacUsed).every(([t, k]) => k <= (sacPool[t] ?? 0));
        if (!ok) break;
      }
      rec(i + 1);
    }
    // undo everything added for this group
    for (let n = counts[i]; n > 0; n--) {
      manaUsed -= g.mana.mana;
      for (const [c, k] of Object.entries(g.mana.pips)) pipsUsed[c] -= k;
      if (g.sac) sacUsed[g.sac.type] -= g.sac.n;
      used.set(g.key, used.get(g.key)! - 1);
    }
    counts[i] = 0;
  };
  rec(0);
  return best;
}

/** Order: trigger creatures first, then outlets with their madness casts, then mana spells, then land sacrifices. */
function describeLine(chosen: { g: Group; n: number }[], t: Triggers, board: Triggers, madness: number): string {
  const rank = (g: Group) => g.triggers ? 0 : g.outlet ? 1 : g.madness ? 2 : g.sac ? 4 : 3;
  const sorted = [...chosen].sort((a, b) => rank(a.g) - rank(b.g) || b.g.dmg - a.g.dmg);
  const parts: string[] = [];
  for (const { g, n } of sorted) {
    let bonus = 0;
    if (g.spell && !g.creature) bonus += t.perNoncreature;
    if (g.spell && g.instSorc) bonus += t.perInstSorc;
    if (g.spell) bonus += t.perSpell;
    const each = g.dmg + bonus;
    const label = g.triggers ? `${g.label} first` : g.label;
    const d = each > 0 ? ` ${g.dmg}${bonus ? `+${bonus}` : ""}` : "";
    const note = g.dmgNote?.startsWith("if the discarded") ? " (discarding a nonland card)" : g.dmgNote === "when it enters" ? "" : g.dmgNote ? ` (${g.dmgNote})` : "";
    parts.push(`${n > 1 ? `${n}x ` : ""}${label}${d}${note}${n > 1 && each ? ` each` : ""}`);
  }
  return parts.join(" -> ");
}

function describeGroup(g: Group): string {
  const cost = g.label.replace(/^flashback /, "").replace(/^[^(]*\(/, "(");
  const base = g.label.replace(/^flashback /, "").replace(/\s*\(.*$/, "");
  const what = g.dmg > 0 ? `${g.dmg}${g.dmgNote ? ` ${g.dmgNote}` : ""}` : g.triggers ? `trigger source (${triggerText(g.triggers)})` : g.outlet ? `discard outlet (${g.outlet.slots} card${g.outlet.slots === 1 ? "" : "s"})` : "0";
  return `${base}|${what}|${g.label.startsWith("flashback") ? "from graveyard: " : ""}${cost}`;
}

/** "Name|dmg|cost" entries from the same card become "Name dmg (cost A, or cost B)". */
function mergeByCard(entries: string[]): string[] {
  const byCard = new Map<string, { what: string; costs: string[] }>();
  for (const e of entries) {
    const [name, what, cost] = e.split("|");
    const cur = byCard.get(name);
    if (cur) { if (!cur.costs.includes(cost)) cur.costs.push(cost); if (cur.what === "0") cur.what = what; }
    else byCard.set(name, { what, costs: [cost] });
  }
  return [...byCard].map(([name, { what, costs }]) => `${name} ${what} ${costs.join(" or ")}`);
}

// ---------------------------------------------------------------------------------------------------------------------

function isLand(p: { name: string; text?: string; pt?: string }, db: CardDb): boolean {
  if (p.pt) return false;
  if (isBasicLand(p.name)) return true;
  const c = getCard(db, p.name);
  if (c) return /\bLand\b/.test(c.types ?? "");
  return /\{T\}: Add/.test(p.text ?? "");
}

/** Elves on both battlefields (Priest of Titania counts every Elf, changelings included). */
function countElves(st: GameState, db: CardDb): number {
  let n = 0;
  for (const side of [st.you, st.opponent]) for (const p of side?.battlefield ?? []) {
    if (!p.pt) continue;
    const types = typeLine(p, db);
    if (/\bElf\b/.test(types) || /\bElf\b/.test(p.text ?? "") || /\bChangeling\b/i.test(permText(p, db))) n++;
  }
  return n;
}

const BASIC_COLORS: Record<string, string> = { Plains: "W", Island: "U", Swamp: "B", Mountain: "R", Forest: "G", Wastes: "C" };

function landColors(p: { name: string; text?: string }, db: CardDb): string[] {
  if (BASIC_COLORS[p.name]) return [BASIC_COLORS[p.name]];
  const text = p.text ?? getCard(db, p.name)?.oracle ?? "";
  if (/Add one mana of any color/i.test(text)) return ["W", "U", "B", "R", "G"];
  const colors = new Set<string>();
  for (const m of text.matchAll(/Add \{([WUBRGC])\}/g)) colors.add(m[1]);
  for (const m of text.matchAll(/Add \{([WUBRG])\}(?:, \{([WUBRG])\})*(?:,? or \{([WUBRG])\})/g)) for (const c of m.slice(1)) if (c) colors.add(c);
  const t = getCard(db, p.name)?.types ?? "";
  for (const [basic, c] of Object.entries(BASIC_COLORS)) if (new RegExp(`\\b${basic}\\b`).test(t)) colors.add(c);
  return colors.size ? [...colors] : ["C"];
}

function typeLine(p: { name: string; text?: string; token?: boolean }, db: CardDb): string {
  const c = getCard(db, p.name);
  if (c) return c.types ?? "";
  const t = p.text ?? "";
  const types: string[] = [];
  if (/\bToken\b/.test(t) || p.token) types.push("Token");
  if (/\bartifact\b/i.test(t)) types.push("Artifact");
  if (/creature/i.test(t)) types.push("Creature");
  return types.join(" ");
}

function permText(p: Perm, db: CardDb): string {
  if (p.text) return p.text;
  const c = getCard(db, p.name);
  return c ? [...c.keywords.map((k) => k.split(":")[0]), c.oracle].join("\n") : "";
}

function power(pt?: string): number {
  const m = (pt ?? "").match(/^(-?\d+|\*)\//);
  return m && m[1] !== "*" ? Math.max(0, Number(m[1])) : 0;
}

function keywordsOf(text: string): string {
  const kws = ["Flying", "Reach", "First strike", "Double strike", "Trample", "Deathtouch", "Lifelink", "Hexproof", "Indestructible", "Menace"];
  const found = kws.filter((k) => new RegExp(`\\b${k}\\b`, "i").test(text));
  return found.length ? ` (${found.map((k) => k.toLowerCase()).join(", ")})` : "";
}

function unblockable(a: Perm, blockers: Perm[], db: CardDb): boolean {
  const text = permText(a, db);
  const has = (p: Perm, kw: string) => new RegExp(`\\b${kw}\\b`, "i").test(permText(p, db));
  if (/can't be blocked\b(?! except| by)/i.test(text) || /can't be blocked\.$/im.test(text)) return true;
  if (/can't be blocked except by creatures with flying/i.test(text)) return !blockers.some((b) => has(b, "Flying"));
  if (/can't be blocked except by two or more creatures/i.test(text) || has(a, "Menace")) return blockers.length < 2;
  if (has(a, "Flying")) return !blockers.some((b) => has(b, "Flying") || has(b, "Reach"));
  return blockers.length === 0;
}

/** From the recent log: did the opponent lose life since the current turn started? Undefined when the log doesn't reach back. */
function opponentLostLifeThisTurn(st: GameState): boolean | undefined {
  const log = st.recentLog ?? [];
  const me = st.youAre;
  if (!me) return undefined;
  const opp = me === "P1" ? "P2" : "P1";
  let start = -1;
  for (let i = log.length - 1; i >= 0; i--) if (/^Turn \d+ \(/.test(log[i])) { start = i; break; }
  if (start < 0) return undefined;
  for (let i = start; i < log.length; i++) {
    const m = log[i].match(/^Life: (P\d) (\d+) > (\d+)$/);
    if (m && m[1] === opp && Number(m[3]) < Number(m[2])) return true;
  }
  return false;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
