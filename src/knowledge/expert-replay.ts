/** Pilot patch: replay the Combat and Their-open-mana sections over recorded prompts.
 *  tsx src/knowledge/expert-replay.ts <rendered-prompts.jsonl> <plans.yaml> [--seat glm] [--kind attackers] [--id substring] [--turn N] [--max N] */
import fs from "node:fs";
import YAML from "yaml";
import { loadDb } from "../cards/db.ts";
import type { DecisionOption, DecisionRequest } from "../types.ts";
import { combatMath } from "./combat.ts";
import { openMana } from "./interaction.ts";
const args = process.argv.slice(2); const flags: Record<string, string> = {}; const pos: string[] = [];
for (let i = 0; i < args.length; i++) { if (args[i].startsWith("--")) { flags[args[i].slice(2)] = args[i + 1]; i++; } else pos.push(args[i]); }
const [file, plans] = pos; const max = flags.max ? Number(flags.max) : 5;
const db = loadDb(); let shown = 0;
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const rec = JSON.parse(line) as { seat: string; requestId: string; kind: string; prompt: string };
  if (flags.seat && rec.seat !== flags.seat) continue;
  if (flags.kind && rec.kind !== flags.kind) continue;
  if (flags.id && !rec.requestId.includes(flags.id)) continue;
  const p = rec.prompt; const s = p.indexOf("## State\n"); const o = p.indexOf("\n## Options\n", s); if (s < 0 || o < 0) continue;
  const m = p.indexOf("\n## ", s + 9); const stateText = p.slice(s + 9, m >= 0 && m < o ? m : o).trim();
  const rest = p.slice(o + 12); const optText = rest.slice(0, rest.indexOf("\n\nChoose") < 0 ? undefined : rest.indexOf("\n\nChoose"));
  const options: DecisionOption[] = []; for (const l of optText.split("\n")) { const mm = l.match(/^- \[([^\]]+)\] (.*)$/); if (mm) options.push({ id: mm[1], label: mm[2] }); }
  const head = p.slice(0, s).split("\n").slice(1).join("\n");
  const req: DecisionRequest = { requestId: rec.requestId, phase: "game", kind: rec.kind as any, prompt: head, state: YAML.parse(stateText), options, min: 1, max: 1 };
  if (flags.turn && String((req.state as any)?.turn) !== flags.turn) continue;
  const a = combatMath(req, db), b = openMana(req, db, plans);
  if (!a && !b) continue;
  const st = req.state as any;
  console.log(`=== ${rec.seat} ${rec.requestId} [${rec.kind}] turn ${st.turn} ${st.phase} active=${st.activePlayer}`);
  if (a) console.log(a); if (b) console.log(b);
  if (++shown >= max) break;
}
