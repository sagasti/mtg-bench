/** Pilot patch: replay suicidalAttackers over recorded attackers prompts. tsx src/knowledge/policy-replay.ts <rendered-prompts.jsonl> [--seat glm] [--max N] */
import fs from "node:fs";
import YAML from "yaml";
import { loadDb } from "../cards/db.ts";
import type { DecisionOption, DecisionRequest } from "../types.ts";
import { suicidalAttackers } from "./combat.ts";
const args = process.argv.slice(2); const flags: Record<string, string> = {}; const pos: string[] = [];
for (let i = 0; i < args.length; i++) { if (args[i].startsWith("--")) { flags[args[i].slice(2)] = args[i + 1]; i++; } else pos.push(args[i]); }
const db = loadDb(); let shown = 0, total = 0;
for (const line of fs.readFileSync(pos[0], "utf8").split("\n")) {
  if (!line.trim()) continue;
  const rec = JSON.parse(line); if (rec.kind !== "attackers" || (flags.seat && rec.seat !== flags.seat)) continue;
  const p = rec.prompt; const s = p.indexOf("## State\n"); const o = p.indexOf("\n## Options\n", s); if (s < 0 || o < 0) continue;
  const m = p.indexOf("\n## ", s + 9); const state = YAML.parse(p.slice(s + 9, m >= 0 && m < o ? m : o).trim());
  const rest = p.slice(o + 12); const optText = rest.slice(0, rest.indexOf("\n\nChoose") < 0 ? undefined : rest.indexOf("\n\nChoose"));
  const options: DecisionOption[] = []; for (const l of optText.split("\n")) { const mm = l.match(/^- \[([^\]]+)\] (.*)$/); if (mm) options.push({ id: mm[1], label: mm[2] }); }
  const req: DecisionRequest = { requestId: rec.requestId, phase: "game", kind: "attackers", prompt: "", state, options, min: 0, max: 9 };
  total++;
  const d = suicidalAttackers(req, db);
  if (d.length) { console.log(`${rec.requestId} t${state.turn}: ${d.map((x) => `${x.name} (${x.auras} auras) dies to ${x.blocker}`).join("; ")}`); if (++shown >= Number(flags.max ?? 20)) break; }
}
console.log(`attackers prompts: ${total}, with a suicidal option: ${shown}`);
