/**
 * Card database built from Forge's own card scripts (res/cardsfolder), so card
 * names and oracle text match the engine exactly. Build once with
 * `bench cards index --forge-res <dir>`; cached to data/cards.json.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface CardFace {
  name: string;
  manaCost: string;        // Forge notation, e.g. "1 G", "W U", "X R R", "" for no cost
  types: string;           // e.g. "Legendary Creature Elf Druid"
  pt?: string;             // "2/2"
  loyalty?: string;
  oracle: string;
}

export interface CardDef extends CardFace {
  cmc: number;
  colors: string[];        // subset of W U B R G
  layout: string;          // Normal | DoubleFaced | Split | Modal | Adventure | Flip | ...
  faces: CardFace[];       // faces[0] is the front (same as top-level fields)
  keywords: string[];      // K: lines of the front face
  abilities: string[];     // A: lines of the front face (used by the mock engine)
}

export type CardDb = Map<string, CardDef>;

const COLOR_SYMBOLS = ["W", "U", "B", "R", "G"];

export function parseManaCost(cost: string): { cmc: number; colors: string[] } {
  if (!cost || cost === "no cost") return { cmc: 0, colors: [] };
  let cmc = 0;
  const colors = new Set<string>();
  for (const sym of cost.trim().split(/\s+/)) {
    if (/^\d+$/.test(sym)) { cmc += Number(sym); continue; }
    if (sym === "X" || sym === "Y" || sym === "Z") continue;
    // hybrid "W/U", phyrexian "W/P", two-brid "2/W", colorless "C", snow "S"
    const parts = sym.split("/");
    if (parts[0] === "2") cmc += 2; else cmc += 1;
    for (const p of parts) if (COLOR_SYMBOLS.includes(p)) colors.add(p);
  }
  return { cmc, colors: COLOR_SYMBOLS.filter((c) => colors.has(c)) };
}

/** Convert Forge "1 G G" to the familiar "{1}{G}{G}". */
export function prettyCost(cost: string): string {
  if (!cost || cost === "no cost") return "";
  return cost.trim().split(/\s+/).map((s) => `{${s}}`).join("");
}

function parseScript(text: string): CardDef | null {
  const faceTexts = text.split(/^\s*ALTERNATE\s*$/m);
  const faces: (CardFace & { keywords: string[]; abilities: string[]; layout?: string; colorsLine?: string })[] = [];
  for (const ft of faceTexts) {
    const f: any = { name: "", manaCost: "", types: "", oracle: "", keywords: [], abilities: [] };
    for (const raw of ft.split(/\r?\n/)) {
      const line = raw.trimEnd();
      const i = line.indexOf(":");
      if (i < 0) continue;
      const key = line.slice(0, i);
      const val = line.slice(i + 1);
      switch (key) {
        case "Name": f.name = val.trim(); break;
        case "ManaCost": f.manaCost = val.trim() === "no cost" ? "" : val.trim(); break;
        case "Types": f.types = val.trim(); break;
        case "PT": f.pt = val.trim(); break;
        case "Loyalty": f.loyalty = val.trim(); break;
        case "Oracle": f.oracle = val.replace(/\\n/g, "\n").trim(); break;
        case "K": f.keywords.push(val.trim()); break;
        case "A": f.abilities.push(val.trim()); break;
        case "AlternateMode": f.layout = val.trim(); break;
        case "Colors": f.colorsLine = val.trim(); break;
      }
    }
    if (f.name) faces.push(f);
  }
  if (faces.length === 0) return null;
  const front = faces[0];
  const { cmc, colors } = parseManaCost(front.manaCost);
  let cardColors = colors;
  if (front.colorsLine) {
    const map: Record<string, string> = { white: "W", blue: "U", black: "B", red: "R", green: "G" };
    cardColors = front.colorsLine.split(",").map((c) => map[c.trim()]).filter(Boolean);
  }
  const strip = (f: any): CardFace => {
    const o: CardFace = { name: f.name, manaCost: f.manaCost, types: f.types, oracle: f.oracle };
    if (f.pt) o.pt = f.pt;
    if (f.loyalty) o.loyalty = f.loyalty;
    return o;
  };
  return {
    ...strip(front),
    cmc,
    colors: cardColors,
    layout: front.layout ?? "Normal",
    faces: faces.map(strip),
    keywords: front.keywords,
    abilities: front.abilities,
  };
}

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".txt")) yield p;
  }
}

/** Build the index from a Forge res/ directory. Handles unpacked or zipped cardsfolder. */
export function buildIndex(forgeRes: string): CardDef[] {
  const dir = path.join(forgeRes, "cardsfolder");
  const zip = path.join(dir, "cardsfolder.zip");
  let scripts: string[] = [];
  const hasTxt = fs.existsSync(dir) && fs.readdirSync(dir).some((n) => n.length === 1 || n.endsWith(".txt"));
  if (hasTxt) {
    for (const f of walk(dir)) scripts.push(fs.readFileSync(f, "utf8"));
  } else if (fs.existsSync(zip)) {
    // Release builds ship card scripts zipped; unpack to a temp dir with the system unzip.
    const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "forge-cards-"));
    execFileSync("unzip", ["-q", zip, "-d", tmp]);
    for (const f of walk(tmp)) scripts.push(fs.readFileSync(f, "utf8"));
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    throw new Error(`No card scripts found under ${dir}`);
  }
  const out: CardDef[] = [];
  for (const s of scripts) {
    const c = parseScript(s);
    if (c) out.push(c);
  }
  return out;
}

export const DEFAULT_DB_PATH = path.resolve("data/cards.json");

export function saveIndex(cards: CardDef[], file = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cards));
}

let cached: CardDb | null = null;
export function loadDb(file = DEFAULT_DB_PATH): CardDb {
  if (cached) return cached;
  if (!fs.existsSync(file)) {
    throw new Error(`Card index ${file} not found. Run: npm run bench -- cards index --forge-res <forge>/res`);
  }
  const arr: CardDef[] = JSON.parse(fs.readFileSync(file, "utf8"));
  cached = new Map();
  for (const c of arr) {
    cached.set(c.name.toLowerCase(), c);
    // also index back faces / split halves so "Fire // Ice" style lookups work
    if (c.faces.length > 1) {
      const joined = c.faces.map((f) => f.name).join(" // ");
      if (!cached.has(joined.toLowerCase())) cached.set(joined.toLowerCase(), c);
    }
  }
  return cached;
}

export function getCard(db: CardDb, name: string): CardDef | undefined {
  return db.get(name.toLowerCase()) ?? db.get(name.split(" // ")[0].toLowerCase());
}

/** Compact, model-facing text for a card. */
export function cardText(c: CardDef, opts: { includeOracle?: boolean } = {}): string {
  const include = opts.includeOracle ?? true;
  const faceText = (f: CardFace) => {
    const head = [f.name, prettyCost(f.manaCost), "—", f.types, f.pt ? `(${f.pt})` : "", f.loyalty ? `[Loyalty ${f.loyalty}]` : ""]
      .filter(Boolean).join(" ");
    return include && f.oracle ? `${head}\n  ${f.oracle.replace(/\n/g, "\n  ")}` : head;
  };
  return c.faces.map(faceText).join("\n  // ");
}

export function isBasicLand(name: string) {
  return ["Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes"].includes(name);
}
