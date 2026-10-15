/** Pilot patch: replay the mulligan and game-plan sections over recorded prompts. tsx src/knowledge/sections-replay.ts <rendered-prompts.jsonl> <plans.yaml> [requestId substring] [--max N] [--lands 16] */
import fs from "node:fs";
import YAML from "yaml";
import { loadDb } from "../cards/db.ts";
import type { DecisionOption, DecisionRequest } from "../types.ts";
import { mulliganMath } from "./mulligan.ts";
import { gamePlan } from "./plans.ts";
const args = process.argv.slice(2); const flags: Record<string, string> = {}; const pos: string[] = [];
for (let i = 0; i < args.length; i++) { if (args[i].startsWith("--")) { flags[args[i].slice(2)] = args[i + 1]; i++; } else pos.push(args[i]); }
const [file, plans, filter] = pos; const max = flags.max ? Number(flags.max) : 5; const lands = Number(flags.lands ?? 16);
const db = loadDb(); let shown = 0;
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const rec = JSON.parse(line) as { requestId: string; kind: string; prompt: string };
  if (filter && !rec.requestId.includes(filter)) continue;
  const p = rec.prompt; const s = p.indexOf("## State\n"); const o = p.indexOf("\n## Options\n", s); if (s < 0 || o < 0) continue;
  const m = p.indexOf("\n## ", s + 9); const stateText = p.slice(s + 9, m >= 0 && m < o ? m : o).trim();
  const rest = p.slice(o + 12); const optText = rest.slice(0, rest.indexOf("\n\nChoose") < 0 ? undefined : rest.indexOf("\n\nChoose"));
  const options: DecisionOption[] = []; for (const l of optText.split("\n")) { const mm = l.match(/^- \[([^\]]+)\] (.*)$/); if (mm) options.push({ id: mm[1], label: mm[2] }); }
  const head = p.slice(0, s).split("\n").slice(1).join("\n");
  const req: DecisionRequest = { requestId: rec.requestId, phase: "game", kind: rec.kind as any, prompt: head, state: YAML.parse(stateText), options, min: 1, max: 1,
    hints: { deckSize: 60, deckLands: lands, youAreOnThePlay: /going first/i.test(head) ? true : /going 2nd/i.test(head) ? false : undefined } };
  const a = mulliganMath(req, db), b = gamePlan(req, plans, db);
  if (!a && !b) continue;
  console.log(`=== ${rec.requestId} [${rec.kind}]`); if (b) console.log(b.split("\n")[0]); if (a) console.log(a);
  if (++shown >= max) break;
}
