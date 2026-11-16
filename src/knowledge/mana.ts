/**
 * Pilot patch (mtg-rival): mana colours. Which colours the seat's deck needs (coloured, non-hybrid pips of its known
 * list, or of the cards it has shown when the list is unknown), which colours its battlefield makes, and the
 * decisions the model kept getting wrong: the colour named for a mana Aura (Utopia Sprawl on a Forest: it named green
 * in a green-white deck and sat on Ethereal Armor and Armadillo Cloak for sixteen turns), the basic land fetched by a
 * land search, and a landcycling land played as a colourless land with the missing colour stuck in hand.
 *
 * event.manaPolicy:
 *   advise  a "Mana colours" section with the facts, in those three decisions and in priority decisions where a card
 *           in hand needs a colour the battlefield does not make and the hand has a way to get it that is not a plain
 *           land drop (a landcycler, a mana Aura).
 *   strict  the section, plus the clear-cut case is answered by the harness: exactly one colour the deck needs has no
 *           source on the battlefield and no other way in from the hand (and, for land-or-cycle, cycling costs nothing
 *           this turn). Otherwise the colour options are narrowed to the deck's colours (known list only) and the model
 *           chooses. Also while a cost is being paid: a land with a plain mana ability and an any-colour one (Abundant
 *           Growth on a Forest) uses the any-colour one, and asked which colour to make it makes the one nothing else
 *           untapped makes (the two-button question has the ids "ok"/"cancel": the model read "cancel" as cancelling,
 *           made green and had Armadillo Cloak cancelled ten times in one game).
 */
import type { CardDb, CardDef } from "../cards/db.ts";
import { getCard } from "../cards/db.ts";
import type { DecisionOption, DecisionRequest } from "../types.ts";
import { type GameState, type Perm, isLand, parseForgeCost } from "./damage.ts";
import { readDeck } from "./interaction.ts";
import { ownArchetype } from "./plans.ts";

const COLORS = ["W", "U", "B", "R", "G"];
const COLOR_NAME: Record<string, string> = { W: "white", U: "blue", B: "black", R: "red", G: "green" };
const BASIC_COLOR: Record<string, string> = { Plains: "W", Island: "U", Swamp: "B", Mountain: "R", Forest: "G" };
/** A colour the list barely uses (a one-card splash) is not worth a binding answer unless the hand holds that card. */
const SPLASH_MIN = 4;

const CHOSEN_COLOR_RE = /mana of the chosen color/i;
const NAMED = "adds the colour you name";
const LAND = "land";
const ANY_COLOR_AURA_RE = /Enchanted (?:land|permanent|[A-Z][a-z]+) has "\{T\}: Add one mana of any color/i;

interface Fixer { name: string; colors: Set<string>; how: string }

export interface ManaColours {
  /** The seat's list is known (its archetype in the plans file names a deck). */
  known: boolean;
  /** Colour -> copies in the list (or cards seen) with a pip of it, and their names. */
  need: Record<string, { cards: number; names: string[] }>;
  /** Colour -> permanents on the seat's battlefield that make it. */
  sources: Record<string, number>;
  /** Colour -> cards in hand that need it. */
  stuck: Record<string, string[]>;
  /** Cards in hand that would make a colour. */
  fixers: Fixer[];
  /** Needed colours with no source on the battlefield. */
  missing: string[];
  /** Colour -> basic lands of it left in the library (known list only). */
  basics: Record<string, number>;
}

const basicOf = (name: string) => BASIC_COLOR[name.replace(/^Snow-Covered /, "")];
const basicFor = (col: string) => Object.keys(BASIC_COLOR).find((b) => BASIC_COLOR[b] === col)!;

function pips(c: CardDef | undefined): string[] {
  const cost = c ? parseForgeCost(c.manaCost) : null;
  return cost ? COLORS.filter((col) => (cost.pips[col] ?? 0) > 0) : [];
}

/** Colours a permanent adds to the pool every turn (tap abilities, basic land types, a mana Aura's chosen colour). */
function produces(p: Perm, db: CardDb): Set<string> {
  const out = new Set<string>();
  const c = getCard(db, p.name);
  const text = `${p.text ?? ""}\n${c?.oracle ?? ""}`;
  for (const m of text.matchAll(/^\(?([^:\n"]*\{T\}[^:\n"]*): Add ([^\n]+)$/gm)) {
    if (/Sacrifice/i.test(m[1])) continue;
    if (/one mana of any color/i.test(m[2])) for (const x of COLORS) out.add(x);
    for (const s of m[2].matchAll(/\{([WUBRG])\}/g)) out.add(s[1]);
  }
  const basic = basicOf(p.name);
  if (basic) out.add(basic);
  if (c && /\bLand\b/.test(c.types)) for (const [type, col] of Object.entries(BASIC_COLOR)) if (new RegExp(`\\b${type}\\b`).test(c.types)) out.add(col);
  const chosen = (p.text ?? "").match(/\(Chosen colors?: ([^)]+)\)/i);
  if (chosen && CHOSEN_COLOR_RE.test(text)) for (const w of chosen[1].split(/,\s*/)) { const col = COLORS.find((x) => COLOR_NAME[x] === w.trim().toLowerCase()); if (col) out.add(col); }
  return out;
}

/** What a card in hand would do for the mana: a land, a landcycler, an Aura that makes a land tap for other colours. */
function fixer(name: string, db: CardDb): Fixer | undefined {
  const c = getCard(db, name);
  const basic = basicOf(name);
  if (!c) return basic ? { name, colors: new Set([basic]), how: LAND } : undefined;
  const all = new Set(COLORS);
  const cycling = c.oracle.match(/\b(Basic land|Plains|Island|Swamp|Mountain|Forest)cycling (\{[^ ]+\})/i);
  if (/\bLand\b/.test(c.types)) {
    const colors = produces({ name }, db);
    if (cycling && /^basic land$/i.test(cycling[1])) return { name, colors: all, how: `basic landcycling ${cycling[2]} fetches any basic land; played as a land it makes ${colors.size ? [...colors].map((x) => COLOR_NAME[x]).join("/") : "colourless"} only` };
    return colors.size ? { name, colors, how: LAND } : undefined;
  }
  if (cycling) return { name, colors: /^basic land$/i.test(cycling[1]) ? all : new Set([BASIC_COLOR[cycling[1]]]), how: `${cycling[1].toLowerCase()}cycling ${cycling[2]}` };
  if (ANY_COLOR_AURA_RE.test(c.oracle)) return { name, colors: all, how: "the enchanted land taps for any colour" };
  if (/choose a color/i.test(c.oracle) && CHOSEN_COLOR_RE.test(c.oracle)) return { name, colors: all, how: NAMED };
  return undefined;
}

export function manaState(req: DecisionRequest, db: CardDb, plansFile?: string): ManaColours | undefined {
  const st = req.state as GameState | undefined;
  if (req.phase !== "game" || !st?.you) return undefined;
  const need: ManaColours["need"] = {};
  const bump = (name: string, copies: number) => {
    for (const col of pips(getCard(db, name))) {
      const n = (need[col] ??= { cards: 0, names: [] });
      n.cards += copies;
      if (!n.names.includes(name)) n.names.push(name);
    }
  };
  // One signature card is not enough to trust a list (a shared card would narrow the colours of another deck).
  const arch = plansFile ? ownArchetype(req, plansFile) : undefined;
  const known = !!arch?.deckFile && arch.hits.length >= 2;
  const basics: Record<string, number> = {};
  if (known) {
    const out = new Map<string, number>();
    const see = (name: string) => out.set(name, (out.get(name) ?? 0) + 1);
    for (const c of st.you.hand ?? []) see(c.name);
    for (const p of st.you.battlefield ?? []) see(p.name);
    for (const z of [st.you.graveyard, st.you.exile]) for (const n of z ?? []) see(typeof n === "string" ? n : (n as any)?.name ?? "");
    for (const [name, copies] of readDeck(arch!.deckFile!)) {
      bump(name, copies);
      const col = basicOf(name);
      if (col) basics[col] = (basics[col] ?? 0) + Math.max(0, copies - (out.get(name) ?? 0));
    }
  } else {
    for (const c of st.you.hand ?? []) bump(c.name, 1);
    for (const p of st.you.battlefield ?? []) bump(p.name, 1);
    for (const z of [st.you.graveyard, st.you.exile]) for (const n of z ?? []) bump(typeof n === "string" ? n : (n as any)?.name ?? "", 1);
  }
  const sources: Record<string, number> = {};
  for (const p of st.you.battlefield ?? []) for (const col of produces(p, db)) sources[col] = (sources[col] ?? 0) + 1;
  const stuck: Record<string, string[]> = {};
  const fixers: Fixer[] = [];
  for (const c of st.you.hand ?? []) {
    for (const col of pips(getCard(db, c.name))) if (!(stuck[col] ??= []).includes(c.name)) stuck[col].push(c.name);
    const f = fixer(c.name, db);
    if (f && !fixers.some((x) => x.name === f.name)) fixers.push(f);
  }
  for (const col of Object.keys(stuck)) if (!need[col]) need[col] = { cards: stuck[col].length, names: [...stuck[col]] };
  const missing = COLORS.filter((col) => need[col] && !sources[col]);
  return { known, need, sources, stuck, fixers, missing, basics };
}

/** The colour is being named for a mana effect of ours (not protection, not a hate card): the source is on top of the stack. */
function manaColourChoice(req: DecisionRequest, db: CardDb): { source: string; options: { o: DecisionOption; color: string }[] } | undefined {
  if (req.kind !== "choose_color" && req.kind !== "choose_entity") return undefined;
  if (!/^Choose a color\b/i.test(req.prompt.trim())) return undefined;
  const options = req.options.map((o) => ({ o, color: COLORS.find((x) => COLOR_NAME[x] === o.label.trim().toLowerCase()) ?? "" }));
  if (!options.length || options.some((x) => !x.color)) return undefined;
  const entry = ownManaSpell(req.state as GameState, db);
  return entry ? { source: entry.card.name, options } : undefined;
}

/** Our spell on the stack that names a colour for mana (Utopia Sprawl), if any. */
function ownManaSpell(st: GameState, db: CardDb): { card: CardDef; description?: string } | undefined {
  for (const s of st.stack ?? []) {
    const c = s.controller === "you" && s.source ? getCard(db, s.source) : undefined;
    if (c && /choose a color/i.test(c.oracle) && CHOSEN_COLOR_RE.test(c.oracle)) return { card: c, description: s.description };
  }
  return undefined;
}

/** A search of our library where every card offered is a basic land. */
function basicLandSearch(req: DecisionRequest): { o: DecisionOption; name: string; color: string }[] | undefined {
  if (req.kind !== "choose_cards" || req.min > 1 || req.max < 1 || req.options.length < 2) return undefined;
  const out: { o: DecisionOption; name: string; color: string }[] = [];
  for (const o of req.options) {
    const m = o.label.match(/^select card: your (.+?) \[Library\]$/);
    const color = m ? basicOf(m[1]) : undefined;
    if (!m || !color) return undefined;
    out.push({ o, name: m[1], color });
  }
  return out;
}

/**
 * A land in hand that can be played or cycled for a basic. The bridge shows one option per card in the priority
 * decision and asks which play in a second prompt.
 */
function landOrCycle(req: DecisionRequest): { name: string; cycle: DecisionOption; cost: number; costText: string } | undefined {
  if (req.kind !== "choose_ability") return undefined;
  const name = req.prompt.trim().match(/^Choose (?:what to do with|how to cast\/activate) (.+?)\.?$/i)?.[1];
  const cycle = req.options.find((o) => /^Basic landcycling \{/i.test(o.label));
  if (!name || !cycle || !req.options.some((o) => /^Play land\b/i.test(o.label))) return undefined;
  const costText = cycle.label.match(/^Basic landcycling ((?:\{[^}]+\})+)/i)![1];
  const cost = [...costText.matchAll(/\{([^}]+)\}/g)].reduce((n, t) => n + (/^\d+$/.test(t[1]) ? Number(t[1]) : 1), 0);
  return { name, cycle, cost, costText };
}

const PLAIN_MANA_RE = /^\{T\}: Add (?:(?:\{[WUBRGC]\})+|one mana of any color)\.$/i;
const ANY_COLOR_ABILITY_RE = /^\{T\}: Add one mana of any color\.$/i;

/** A permanent asked which of its mana abilities to use, all of them plain "{T}: Add …" and exactly one any colour. */
function anyColourAbility(req: DecisionRequest): DecisionOption | undefined {
  if (req.kind !== "choose_ability" || req.options.length < 2) return undefined;
  if (!/^Choose (?:what to do with|how to cast\/activate) /i.test(req.prompt.trim())) return undefined;
  if (!req.options.every((o) => PLAIN_MANA_RE.test(o.label.trim()))) return undefined;
  const any = req.options.filter((o) => ANY_COLOR_ABILITY_RE.test(o.label.trim()));
  return any.length === 1 ? any[0] : undefined;
}

/** A permanent tapped for a cost asks which colour it makes ("Forest (32)" / "Select Mana to Produce"). */
function producedColour(req: DecisionRequest): { source: string; id: string; options: { o: DecisionOption; color: string }[] } | undefined {
  if (req.kind !== "choose_color" || req.options.length < 2) return undefined;
  const m = req.prompt.trim().match(/^(.+?) \((\d+)\)\s+Select Mana to Produce\b/i);
  if (!m) return undefined;
  const options = req.options.map((o) => ({ o, color: COLORS.find((x) => COLOR_NAME[x] === o.label.replace(/^Button:\s*/i, "").match(/^[A-Za-z]+/)?.[0].toLowerCase()) ?? "" }));
  return options.some((x) => !x.color) ? undefined : { source: m[1], id: `c${m[2]}`, options };
}

/** Colour -> our other untapped permanents that make it (a mana Aura counts through its land: untapped, and not `except`). */
function otherSources(st: GameState, except: string, db: CardDb): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const field = st.you?.battlefield ?? [];
  for (const p of field) {
    if (p.id === except || p.tapped || (p.summoningSick && p.pt)) continue;
    const host = p.text?.match(/\*Attached to .+? \((\d+)\)\*/);
    if (host) {
      const land = field.find((x) => x.id === `c${host[1]}`);
      if (!land || land.tapped || land.id === except) continue;
    }
    for (const col of produces(p, db)) (out[col] ??= []).push(p.name);
  }
  return out;
}

/** Fixers that count as another way in while a colour is named: not a second colour-naming Aura (one of the two has
 *  to name it, and the one resolving now cannot be countered or discarded any more). */
const NOT_NAMED = (f: Fixer) => f.how !== NAMED;
/** While a basic is fetched (or a land is cycled for one): only a land in hand that makes the colour. An Aura can be
 *  countered and a second landcycler costs its mana again. */
const LANDS_ONLY = (f: Fixer) => f.how === LAND;

/** Needed colours with no source on the battlefield and no other way in from the hand (`counts`: the fixers that are one). */
function unreachable(m: ManaColours, counts: (f: Fixer) => boolean): string[] {
  return m.missing.filter((col) => !m.fixers.some((f) => counts(f) && f.colors.has(col)) && (m.stuck[col]?.length || (m.known && m.need[col].cards >= SPLASH_MIN)));
}

export interface ManaChoice {
  /** The harness answers. */
  choice?: { id: string; label: string; why: string };
  /** The option ids left for the model, when some were dropped. */
  keep?: string[];
  dropped?: string[];
}

/** event.manaPolicy strict: the colour for a mana Aura, the basic land of a land search, land drop or landcycling. */
export function manaChoice(req: DecisionRequest, db: CardDb, plansFile?: string): ManaChoice | undefined {
  // The any-colour ability makes everything the plain one does: Forge then asks the colour only if two are still owed.
  const ability = anyColourAbility(req);
  if (ability) return { choice: { id: ability.id, label: ability.label, why: `the any-colour ability: it makes every colour the other one${req.options.length > 2 ? "s make" : " makes"}` } };
  const made = producedColour(req);
  if (made) {
    // Forge offers the colours the cost still owes. Clear-cut: exactly one of them has no other untapped source.
    const others = otherSources(req.state as GameState, made.id, db);
    const only = made.options.filter((x) => !others[x.color]?.length);
    if (only.length !== 1) return undefined;
    const rest = made.options.filter((x) => x !== only[0]).map((x) => `${COLOR_NAME[x.color]} can come from ${[...new Set(others[x.color])].join(", ")}`);
    return { choice: { id: only[0].o.id, label: only[0].o.label, why: `${made.source} (${made.id}) makes ${COLOR_NAME[only[0].color]} for this cost: nothing else untapped does, and ${rest.join("; ")}` } };
  }
  const colour = manaColourChoice(req, db);
  const search = colour ? undefined : basicLandSearch(req);
  const cyc = colour || search ? undefined : landOrCycle(req);
  if (!colour && !search && !cyc) return undefined;
  const m = manaState(req, db, plansFile);
  if (!m) return undefined;
  const why = (col: string) => {
    const held = m.stuck[col] ?? [];
    return `no ${COLOR_NAME[col]} source on the battlefield${m.fixers.some((f) => f.colors.has(col)) ? "" : " and none in hand"}; ${held.length ? `${held.join(", ")} in hand need${held.length === 1 ? "s" : ""} it` : `${m.need[col].cards} cards of the list need it`}`;
  };
  if (cyc) {
    // Only when cycling is free: the fetched basic is this turn's land drop, and after paying for the cycling every
    // spell castable now is still castable from the lands already there (untapped lands only: an undercount).
    if (!m.known) return undefined;
    const st = req.state as GameState;
    const want = unreachable(m, LANDS_ONLY).filter((col) => (m.basics[col] ?? 0) > 0);
    if (want.length !== 1) return undefined;
    const open = (st.you?.battlefield ?? []).filter((p) => isLand(p, db) && !p.tapped).length;
    let spend = 0;
    for (const c of st.you?.hand ?? []) {
      const def = getCard(db, c.name);
      if (def && /\bLand\b/.test(def.types)) continue;
      const cost = def ? parseForgeCost(def.manaCost) : null;
      if (!cost || cost.x) return undefined;
      if (Object.keys(cost.pips).every((col) => m.sources[col])) spend += cost.mana;
    }
    if (open < cyc.cost || spend > open - cyc.cost) return undefined;
    return { choice: { id: cyc.cycle.id, label: cyc.cycle.label, why: `${cyc.name} cycles for a ${basicFor(want[0])} instead of entering as a land: ${why(want[0])}; the ${basicFor(want[0])} is still this turn's land drop and ${spend ? "every spell castable now stays castable" : "no spell is castable now anyway"}` } };
  }
  if (colour) {
    const want = unreachable(m, NOT_NAMED).filter((col) => colour.options.some((x) => x.color === col));
    if (want.length === 1) {
      const pick = colour.options.find((x) => x.color === want[0])!;
      return { choice: { id: pick.o.id, label: pick.o.label, why: `${colour.source} names ${COLOR_NAME[want[0]]}: ${why(want[0])}` } };
    }
    if (!m.known) return undefined;
    const keep = colour.options.filter((x) => m.need[x.color]);
    if (keep.length === 1) return { choice: { id: keep[0].o.id, label: keep[0].o.label, why: `${colour.source} names ${COLOR_NAME[keep[0].color]}: the only colour the list uses` } };
    if (keep.length && keep.length < colour.options.length) return { keep: keep.map((x) => x.o.id), dropped: colour.options.filter((x) => !m.need[x.color]).map((x) => x.o.label) };
    return undefined;
  }
  const want = [...new Set(unreachable(m, LANDS_ONLY).filter((col) => search!.some((x) => x.color === col)))];
  if (want.length !== 1) return undefined;
  const pick = search!.find((x) => x.color === want[0])!;
  return { choice: { id: pick.o.id, label: pick.o.label, why: `fetch ${pick.name}: ${why(want[0])}` } };
}

/** The "Mana colours" section (event.manaPolicy advise or strict). */
export function manaColours(req: DecisionRequest, db: CardDb, plansFile?: string): string | undefined {
  const colour = manaColourChoice(req, db);
  const search = colour ? undefined : basicLandSearch(req);
  const cyc = colour || search ? undefined : landOrCycle(req);
  if (!colour && !search && !cyc && req.kind !== "priority") return undefined;
  const m = manaState(req, db, plansFile);
  if (!m) return undefined;
  const st = req.state as GameState;
  const needed = COLORS.filter((col) => m.need[col]);
  if (needed.length < 2 && !m.missing.length) return undefined;
  // Outside the two mana decisions: only when a card in hand is stuck on a colour, the mana base is already started and
  // the hand can fix it with something less obvious than a land drop (a landcycler, a mana Aura).
  const started = Object.keys(m.sources).length > 0;
  const actionable = started ? m.missing.filter((col) => m.stuck[col]?.length && m.fixers.some((f) => f.how !== LAND && f.colors.has(col))) : [];
  if (!colour && !search && !cyc && !actionable.length) return undefined;
  if ((search || cyc) && !m.missing.length) return undefined;
  const lines: string[] = [];
  lines.push(m.known
    ? `- Your list needs: ${needed.map((col) => `${COLOR_NAME[col]} (${m.need[col].cards} cards${m.need[col].names.length <= 6 ? `: ${m.need[col].names.join(", ")}` : ""})`).join("; ")}.`
    : `- The cards you have shown need: ${needed.map((col) => COLOR_NAME[col]).join(", ")}.`);
  const made = COLORS.filter((col) => m.sources[col]);
  lines.push(`- Your battlefield makes: ${made.length ? made.map((col) => `${COLOR_NAME[col]} (${m.sources[col]} source${m.sources[col] === 1 ? "" : "s"})`).join(", ") : "no coloured mana"}.${m.missing.length ? ` NO ${m.missing.map((col) => COLOR_NAME[col]).join(" or ")} source yet.` : ""}`);
  for (const col of m.missing) {
    const held = m.stuck[col] ?? [];
    if (held.length) lines.push(`- Uncastable until you have ${COLOR_NAME[col]}: ${held.join(", ")} (in your hand).`);
    const ways = m.fixers.filter((f) => f.colors.has(col));
    if (ways.length) lines.push(`- ${COLOR_NAME[col][0].toUpperCase()}${COLOR_NAME[col].slice(1)} can come from your hand: ${ways.map((f) => `${f.name} (${f.how})`).join("; ")}.`);
    else lines.push(`- Nothing in your hand makes ${COLOR_NAME[col]}.`);
  }
  if (colour) {
    const host = ownManaSpell(st, db)?.description?.match(/Attach to (.+?) \((\d+)\)/);
    const perm = host ? (st.you?.battlefield ?? []).find((p) => p.id === `c${host[2]}`) ?? { name: host[1] } : undefined;
    const base = perm ? produces(perm, db) : new Set<string>();
    if (host && base.size) lines.push(`- The enchanted ${host[1]} already makes ${base.size === 5 ? "any colour" : [...base].map((x) => COLOR_NAME[x]).join("/")} by itself; the colour you name is the extra mana it adds.`);
  }
  if (cyc) {
    const fetch = m.missing.filter((col) => !m.known || m.basics[col]);
    if (fetch.length) lines.push(`- This choice: "Basic landcycling ${cyc.costText}" fetches a ${fetch.map(basicFor).join(" or ")} that you can still play as this turn's land drop: the same number of lands as "Play land", ${cyc.cost === 1 ? "one" : cyc.cost} mana less this turn only, and ${fetch.map((col) => COLOR_NAME[col]).join(" or ")} mana from then on.`);
  }
  return `## Mana colours\nComputed by the harness from your battlefield, your hand and ${m.known ? "your deck list" : "the cards you have shown"}.\n${lines.join("\n")}`;
}
