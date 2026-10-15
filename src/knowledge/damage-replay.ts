/**
 * Pilot patch (mtg-rival): replay the damage-math section over the prompts a run recorded, to check the arithmetic on
 * real game states without playing. Usage:
 *   tsx src/knowledge/damage-replay.ts runs/<run>/rendered-prompts.jsonl [requestId substring] [--kinds priority,attackers] [--max N]
 */
import fs from "node:fs";
import YAML from "yaml";
import { loadDb } from "../cards/db.ts";
import type { DecisionOption, DecisionRequest } from "../types.ts";
import { damageMath } from "./damage.ts";

const args = process.argv.slice(2);
const flags: Record<string, string> = {};
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) { flags[args[i].slice(2)] = args[i + 1]; i++; } else positional.push(args[i]);
}
const file = positional.find((a) => a.endsWith(".jsonl"));
if (!file) { console.error("usage: damage-replay <rendered-prompts.jsonl> [requestId substring] [--kinds a,b] [--max N]"); process.exit(2); }
const filter = positional.find((a) => a !== file);
const kindsArg = flags.kinds ? flags.kinds.split(",") : null;
const max = flags.max ? Number(flags.max) : Infinity;

const db = loadDb();
let shown = 0;
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const rec = JSON.parse(line) as { requestId: string; kind: string; seat: string; prompt: string };
  if (filter && !rec.requestId.includes(filter)) continue;
  if (kindsArg && !kindsArg.includes(rec.kind)) continue;
  const req = parsePrompt(rec);
  if (!req) continue;
  const t0 = Date.now();
  const math = damageMath(req, db);
  const ms = Date.now() - t0;
  if (!math) continue;
  const st = req.state as any;
  console.log(`=== ${rec.requestId} [${rec.kind}] turn ${st.turn} ${st.phase} active=${st.activePlayer} (${ms} ms)`);
  console.log(`    hand: ${(st.you?.hand ?? []).map((h: any) => h.name).join(", ") || "-"} | untapped: ${(st.you?.battlefield ?? []).filter((p: any) => !p.tapped).map((p: any) => p.name).join(", ") || "-"}`);
  console.log(math.split("\n").slice(2).join("\n"));
  if (++shown >= max) break;
}

function parsePrompt(rec: { requestId: string; kind: string; prompt: string }): DecisionRequest | null {
  const p = rec.prompt;
  const s = p.indexOf("## State\n");
  const o = p.indexOf("\n## Options\n", s);
  if (s < 0 || o < 0) return null;
  const m = p.indexOf("\n## Damage math\n", s);
  const stateText = p.slice(s + "## State\n".length, m >= 0 && m < o ? m : o).trim();
  const rest = p.slice(o + "\n## Options\n".length);
  const optEnd = rest.indexOf("\n\nChoose");
  const optText = optEnd < 0 ? rest : rest.slice(0, optEnd);
  const options: DecisionOption[] = [];
  for (const l of optText.split("\n")) {
    const m = l.match(/^- \[([^\]]+)\] (.*)$/);
    if (m) options.push({ id: m[1], label: m[2] });
  }
  let state: unknown;
  try { state = YAML.parse(stateText); } catch { return null; }
  return { requestId: rec.requestId, phase: "game", kind: rec.kind as any, prompt: "", state, options, min: 0, max: options.length };
}
