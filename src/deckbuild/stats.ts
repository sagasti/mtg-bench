/**
 * Derived figures for a proposed deck (MB-049, prompts v3): card and land counts, mana sources, curve, coloured pips
 * against sources of each colour, and cards whose colours have no source. Bookkeeping only, no advice: it's what a
 * deckbuilding client shows a human, so it's free information under the Regular-REL rule.
 */
import { type CardDb, type CardDef, getCard } from "../cards/db.ts";

const COLORS = ["W", "U", "B", "R", "G"] as const;
const BASIC_TYPE: Record<string, string> = { Plains: "W", Island: "U", Swamp: "B", Mountain: "R", Forest: "G" };

export interface DeckStats {
  cards: number;
  fromPool: number;
  basics: number;
  minDeckSize: number;
  lands: number;
  /** Non-land cards with a mana ability, and the colours they make. */
  otherSources: { name: string; colors: string[] }[];
  /** Non-land cards by mana value (X counts as 0); index 7 is 7 or more. */
  curve: number[];
  pips: Record<string, { pips: number; cards: number; sources: number }>;
  hybrid: Record<string, number>;
  /** Non-land cards that need a colour no land or mana producer in the deck makes. */
  unsupported: { name: string; missing: string[] }[];
}

/** Colours a card makes by itself: its basic land types and its Forge `AB$ Mana` abilities ("Any" / "Chosen": every colour). */
function ownColors(c: CardDef): Set<string> {
  const out = new Set<string>();
  if (/\bLand\b/.test(c.types)) for (const [t, col] of Object.entries(BASIC_TYPE)) if (new RegExp(`\\b${t}\\b`).test(c.types)) out.add(col);
  for (const a of c.abilities) {
    if (!a.startsWith("AB$ Mana")) continue;
    const produced = a.match(/Produced\$ ([^|]+)/)?.[1]?.trim() ?? "";
    for (const tok of produced.split(/\s+/)) {
      if (tok === "Any" || tok === "Chosen") COLORS.forEach((x) => out.add(x));
      else if ((COLORS as readonly string[]).includes(tok)) out.add(tok);
    }
  }
  return out;
}

/**
 * Colours a card can make in this deck: its own, plus for a fetch land ("Search your library for a Mountain or Plains
 * card" / "a basic land card") the colours of the deck's lands it can find.
 */
export function manaColors(c: CardDef, deckLands: CardDef[]): string[] {
  const out = ownColors(c);
  const m = /\bLand\b/.test(c.types) ? c.oracle.match(/[Ss]earch your library for an? ([^.]*?) cards?/) : null;
  if (m) {
    const types = Object.keys(BASIC_TYPE).filter((t) => new RegExp(`\\b${t}\\b`).test(m[1]));
    for (const l of deckLands) {
      const fits = /basic land/.test(m[1]) ? /\bBasic\b/.test(l.types) : types.some((t) => new RegExp(`\\b${t}\\b`).test(l.types));
      if (fits) for (const col of ownColors(l)) out.add(col);
    }
  }
  return COLORS.filter((x) => out.has(x));
}

/**
 * Coloured pips of a Forge mana cost ("2 W W", "1 UR UR", "BP", "2R", "GWP"): one-colour symbols by colour (phyrexian
 * and 2-or-colour count), two-colour hybrids apart.
 */
function pipsOf(cost: string): { single: string[]; hybrid: string[][] } {
  const single: string[] = [], hybrid: string[][] = [];
  for (const sym of cost.trim().split(/\s+/).filter(Boolean)) {
    const cols = [...sym].filter((ch) => (COLORS as readonly string[]).includes(ch));
    if (cols.length === 1) single.push(cols[0]);
    else if (cols.length > 1) hybrid.push(cols);
  }
  return { single, hybrid };
}

export function deckStats(poolCards: string[], basics: Record<string, number>, db: CardDb, minDeckSize: number): DeckStats {
  const names = [...poolCards, ...Object.entries(basics).flatMap(([b, n]) => Array.from({ length: Math.max(0, n) }, () => b))];
  const defs = names.map((n) => ({ name: n, def: getCard(db, n) }));
  const isLand = (d?: CardDef) => !!d && /\bLand\b/.test(d.types);
  const sources: Record<string, number> = Object.fromEntries(COLORS.map((c) => [c, 0]));
  const otherSources: DeckStats["otherSources"] = [];
  const curve = new Array(8).fill(0);
  const pips: DeckStats["pips"] = Object.fromEntries(COLORS.map((c) => [c, { pips: 0, cards: 0, sources: 0 }]));
  const hybrid: Record<string, number> = {};
  const needs: { name: string; single: Set<string>; hybrid: string[][] }[] = [];
  let lands = 0;
  const deckLands = defs.map((d) => d.def).filter((d): d is CardDef => isLand(d));
  for (const { def } of defs) {
    if (!def) continue;
    const made = manaColors(def, deckLands);
    for (const c of made) sources[c]++;
    if (isLand(def)) { lands++; continue; }
    if (def.abilities.some((a) => a.startsWith("AB$ Mana"))) otherSources.push({ name: def.name, colors: made });
    curve[Math.min(7, def.cmc)]++;
    const p = pipsOf(def.manaCost);
    for (const c of p.single) pips[c].pips++;
    for (const c of new Set(p.single)) pips[c].cards++;
    for (const h of p.hybrid) hybrid[h.join("/")] = (hybrid[h.join("/")] ?? 0) + 1;
    needs.push({ name: def.name, single: new Set(p.single), hybrid: p.hybrid });
  }
  for (const c of COLORS) pips[c].sources = sources[c];
  const unsupported: DeckStats["unsupported"] = [];
  for (const n of needs) {
    const missing = [...n.single].filter((c) => !sources[c]);
    for (const h of n.hybrid) if (!h.some((c) => sources[c])) missing.push(h.join("/"));
    if (missing.length) unsupported.push({ name: n.name, missing });
  }
  return {
    cards: names.length, fromPool: poolCards.length, basics: names.length - poolCards.length, minDeckSize, lands,
    otherSources, curve, pips, hybrid, unsupported,
  };
}

/** The figures as the agent reads them. */
export function renderDeckStats(s: DeckStats): string {
  const L: string[] = [];
  L.push(`- Total: ${s.cards} cards (${s.fromPool} from your pool + ${s.basics} basic lands); minimum deck size ${s.minDeckSize}.`);
  L.push(`- Lands: ${s.lands} (${s.basics} basic, ${s.lands - s.basics} other). Non-land mana sources: ${s.otherSources.length ? s.otherSources.map((o) => `${o.name} (${o.colors.join("") || "colourless"})`).join(", ") : "none"}.`);
  L.push(`- Curve of the ${s.cards - s.lands} non-land cards by mana value (X counts as 0): ${s.curve.map((n, i) => `${i === 7 ? "7+" : i}: ${n}`).join(" · ")}`);
  L.push("- Coloured mana symbols in the non-land cards' costs, against cards that can make that colour (lands and mana producers):");
  for (const [c, p] of Object.entries(s.pips)) if (p.pips || p.sources) L.push(`  ${c}: ${p.pips} symbol(s) in ${p.cards} card(s) · ${p.sources} source(s)`);
  if (Object.keys(s.hybrid).length) L.push(`  Hybrid symbols: ${Object.entries(s.hybrid).map(([h, n]) => `${h} ${n}`).join(", ")}`);
  L.push(`- Cards needing a colour that nothing in the deck makes: ${s.unsupported.length ? s.unsupported.map((u) => `${u.name} (${u.missing.join(", ")})`).join("; ") : "none"}.`);
  return L.join("\n");
}

/** A proposal's identity: the same pool cards and the same basics (zero counts ignored). */
export function deckKey(choice: string[], basics: Record<string, number> | undefined): string {
  const b = Object.entries(basics ?? {}).filter(([, n]) => n > 0).sort(([x], [y]) => x.localeCompare(y));
  return JSON.stringify([[...choice].sort(), b]);
}
