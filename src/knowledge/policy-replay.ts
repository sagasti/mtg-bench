/** Pilot patch: replay the binding policies over recorded prompts: suicidal attackers, lethal blocks, casting-order drops.
 *  tsx src/knowledge/policy-replay.ts <rendered-prompts.jsonl> <plans.yaml> [--seat glm] [--kind attackers|blockers|priority] [--max N] */
import fs from "node:fs";
import YAML from "yaml";
import { loadDb } from "../cards/db.ts";
import type { DecisionOption, DecisionRequest } from "../types.ts";
import { lethalBlocks, suicidalAttackers } from "./combat.ts";
import { castingPlan } from "./interaction.ts";
const args = process.argv.slice(2); const flags: Record<string, string> = {}; const pos: string[] = [];
for (let i = 0; i < args.length; i++) { if (args[i].startsWith("--")) { flags[args[i].slice(2)] = args[i + 1]; i++; } else pos.push(args[i]); }
const [file, plans] = pos; const max = Number(flags.max ?? 20);
const db = loadDb(); let shown = 0; const totals: Record<string, number> = {};
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const rec = JSON.parse(line);
  if (flags.seat && rec.seat !== flags.seat) continue;
  if (flags.kind && rec.kind !== flags.kind) continue;
  if (!["attackers", "blockers", "priority"].includes(rec.kind)) continue;
  const p = rec.prompt; const s = p.indexOf("## State\n"); const o = p.indexOf("\n## Options\n", s); if (s < 0 || o < 0) continue;
  const m = p.indexOf("\n## ", s + 9); const state = YAML.parse(p.slice(s + 9, m >= 0 && m < o ? m : o).trim());
  const rest = p.slice(o + 12); const optText = rest.slice(0, rest.indexOf("\n\nChoose") < 0 ? undefined : rest.indexOf("\n\nChoose"));
  const options: DecisionOption[] = []; for (const l of optText.split("\n")) { const mm = l.match(/^- \[([^\]]+)\] (.*)$/); if (mm) options.push({ id: mm[1], label: mm[2] }); }
  const req: DecisionRequest = { requestId: rec.requestId, phase: "game", kind: rec.kind, prompt: "", state, options, min: 0, max: 9 };
  totals[rec.kind] = (totals[rec.kind] ?? 0) + 1;
  let out = "";
  if (rec.kind === "attackers") { const d = suicidalAttackers(req, db); if (d.length) out = `suicidal: ${d.map((x) => `${x.name} (${x.auras} auras) dies to ${x.blocker}`).join("; ")}`; }
  if (rec.kind === "blockers") { const lb = lethalBlocks(req, db); if (lb) out = `lethal blocks → ${lb.why}`; }
  if (rec.kind === "priority") { const c = castingPlan(req, db, plans); if (c?.drop.length) out = `sequence drops: ${c.drop.map((d) => `${d.name} (${d.reason})`).join("; ")}\n      ${c.text.join("\n      ")}`; else if (c && flags.verbose) out = `plan: ${c.text.join(" | ")}`; }
  if (out) { console.log(`${rec.seat} ${rec.requestId} t${state.turn} [${rec.kind}]: ${out}`); if (++shown >= max) break; }
}
console.log(`prompts: ${JSON.stringify(totals)}, shown ${shown}`);
