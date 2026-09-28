/**
 * Cube lists. Accepts either the name of a cube bundled with Forge
 * (res/cube/<name>.dck) or a path to a .dck / plain text list ("1 Card Name"
 * or "Card Name" per line, "|SET" suffix ignored).
 */
import fs from "node:fs";
import path from "node:path";
import { type CardDb, getCard } from "./db.ts";

export interface Cube {
  name: string;
  cards: string[]; // one entry per physical card (singleton cubes: unique names)
  missing: string[]; // names not found in the card DB (dropped)
}

export function parseCardList(text: string): { name?: string; cards: string[] } {
  let name: string | undefined;
  let inMain = !/^\[main\]/m.test(text); // plain lists have no sections
  const cards: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    if (line.startsWith("[")) { inMain = /^\[main\]$/i.test(line); continue; }
    if (line.startsWith("Name=")) { name = line.slice(5); continue; }
    if (!inMain || line.includes("=")) continue;
    const m = line.match(/^(\d+)\s+(.+)$/);
    const count = m ? Number(m[1]) : 1;
    const cardName = (m ? m[2] : line).split("|")[0].trim();
    for (let i = 0; i < count; i++) cards.push(cardName);
  }
  return { name, cards };
}

export function loadCube(db: CardDb, spec: string, forgeRes?: string): Cube {
  let file = spec;
  if (!fs.existsSync(file) && forgeRes) file = path.join(forgeRes, "cube", `${spec}.dck`);
  if (!fs.existsSync(file)) file = path.resolve("data/cubes", `${spec}.dck`);
  if (!fs.existsSync(file)) throw new Error(`Cube "${spec}" not found (tried path, <forge-res>/cube, data/cubes)`);
  const parsed = parseCardList(fs.readFileSync(file, "utf8"));
  const cards: string[] = [];
  const missing: string[] = [];
  for (const n of parsed.cards) {
    const c = getCard(db, n);
    if (c) cards.push(c.name); else missing.push(n);
  }
  return { name: parsed.name ?? path.basename(file, path.extname(file)), cards, missing };
}

/** CubeCobra-derived ranking shipped with Forge: lower rank = stronger pick. */
export function loadRankings(forgeRes?: string): Map<string, number> {
  const candidates = [
    forgeRes && path.join(forgeRes, "draft", "rankings_cubecobra.txt"),
    path.resolve("data/rankings_cubecobra.txt"),
  ].filter(Boolean) as string[];
  const m = new Map<string, number>();
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const mm = line.match(/^#(\d+)\|([^|]+)\|/);
      if (mm) m.set(mm[2].toLowerCase(), Number(mm[1]));
    }
    break;
  }
  return m;
}
