/** Deckbuilding: each seat picks main-deck cards from its pool and adds basics. */
import fs from "node:fs";
import path from "node:path";
import type { Seat } from "../agents/agent.ts";
import { type CardDb, getCard, isBasicLand, prettyCost } from "../cards/db.ts";
import type { EventConfig } from "../config.ts";
import type { CardInstance } from "../draft/draft.ts";

export interface Deck {
  seatId: string;
  main: string[];       // card names, including basics
  sideboard: string[];
  basics: Record<string, number>;
}

export async function buildDeck(seat: Seat, pool: CardInstance[], event: EventConfig, db: CardDb, pod: number): Promise<Deck> {
  const colorCount: Record<string, number> = {};
  for (const c of pool) for (const col of getCard(db, c.name)?.colors ?? []) colorCount[col] = (colorCount[col] ?? 0) + 1;
  const res = await seat.decide({
    requestId: `p${pod}-build-${seat.id}`,
    phase: "deckbuild",
    kind: "deckbuild",
    prompt: `Build a deck of at least ${event.minDeckSize} cards from your ${pool.length}-card pool plus basic lands (Plains, Island, Swamp, Mountain, Forest, Wastes) in any number.`,
    state: { poolSize: pool.length, colorCounts: colorCount }, // pool itself is the options list
    options: pool.map((c) => {
      const d = getCard(db, c.name);
      return { id: c.iid, label: d ? `${d.name} ${prettyCost(d.manaCost)} — ${d.types}${d.pt ? ` ${d.pt}` : ""}` : c.name, card: c.name };
    }),
    min: 0, max: pool.length,
    constraints: { minDeckSize: event.minDeckSize },
  }, { pod });
  const chosen = new Set(res.choice);
  const main = pool.filter((c) => chosen.has(c.iid)).map((c) => c.name);
  const basics = res.basics ?? {};
  for (const [b, k] of Object.entries(basics)) for (let i = 0; i < k; i++) main.push(b);
  return { seatId: seat.id, main, sideboard: pool.filter((c) => !chosen.has(c.iid)).map((c) => c.name), basics };
}

/**
 * Why a deck loaded from disk can't be played as-is: too small, cards the card DB doesn't know (Forge drops those
 * silently), `basics` that aren't basic lands, or (given the seat's drafted pool) cards it never drafted.
 */
export function deckProblems(deck: Deck, db: CardDb, minDeckSize: number, pool?: string[]): string[] {
  const out: string[] = [];
  if (deck.main.length < minDeckSize) out.push(`${deck.main.length} main-deck cards, fewer than minDeckSize ${minDeckSize}`);
  const unknown = [...new Set([...deck.main, ...deck.sideboard].filter((n) => !getCard(db, n)))];
  if (unknown.length) out.push(`not in the card DB: ${unknown.join(", ")}`);
  const notBasic = Object.keys(deck.basics ?? {}).filter((b) => !isBasicLand(b));
  if (notBasic.length) out.push(`listed as basics but not basic lands: ${notBasic.join(", ")}`);
  if (pool) {
    const left = new Map<string, number>();
    for (const n of pool) left.set(n, (left.get(n) ?? 0) + 1);
    const extra: string[] = [];
    for (const n of [...deck.main, ...deck.sideboard]) {
      if (isBasicLand(n)) continue;
      if (left.get(n)) left.set(n, left.get(n)! - 1); else extra.push(n);
    }
    if (extra.length) out.push(`not in the seat's drafted pool: ${extra.join(", ")}`);
  }
  return out;
}

/** Forge .dck format. Deck names are neutral ("Deck") so nothing identifying reaches the engine or agents. */
export function toDck(deck: Deck, name = "Deck"): string {
  const count = (arr: string[]) => {
    const m = new Map<string, number>();
    for (const n of arr) m.set(n, (m.get(n) ?? 0) + 1);
    return [...m.entries()].map(([n, k]) => `${k} ${n}`).join("\n");
  };
  return `[metadata]\nName=${name}\n[main]\n${count(deck.main)}\n[sideboard]\n${count(deck.sideboard)}\n`;
}

export function saveDeck(dir: string, deck: Deck): string {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${deck.seatId}.dck`);
  fs.writeFileSync(f, toDck(deck));
  fs.writeFileSync(path.join(dir, `${deck.seatId}.json`), JSON.stringify(deck, null, 2));
  return f;
}
