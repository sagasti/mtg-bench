/** Pilot patch: replay the binding policies over recorded prompts: suicidal attackers, lethal blocks, casting-order drops,
 *  trample damage splits, mana colour / basic land / land-or-cycle choices. When a decisions.jsonl sits next to the prompts file, the
 *  answer of a policy is compared with what the seat chose in the recorded game (SAME / FLIP).
 *  tsx src/knowledge/policy-replay.ts <rendered-prompts.jsonl> <plans.yaml> [--seat glm] [--kind attackers|blockers|priority|assign_damage|choose_entity|choose_cards|choose_ability] [--max N] [--verbose 1] [--section 1] */
import fs from "node:fs";
import path from "node:path";
import { loadDb } from "../cards/db.ts";
import { lethalBlocks, suicidalAttackers, trampleAssignment } from "./combat.ts";
import { castingPlan } from "./interaction.ts";
import { manaChoice, manaColours } from "./mana.ts";
import { londonBottomPolicy } from "./mulligan.ts";
import { recordedRequest } from "./recorded.ts";
const args = process.argv.slice(2); const flags: Record<string, string> = {}; const pos: string[] = [];
for (let i = 0; i < args.length; i++) { if (args[i].startsWith("--")) { flags[args[i].slice(2)] = args[i + 1]; i++; } else pos.push(args[i]); }
const [file, plans] = pos; const max = Number(flags.max ?? 20);
const db = loadDb(); let shown = 0; const totals: Record<string, number> = {}; const tally: Record<string, number> = {};
const bump = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
const chosen = new Map<string, { choice: string[]; labels: string[] }>();
const decisions = path.join(path.dirname(file), "decisions.jsonl");
if (fs.existsSync(decisions)) for (const line of fs.readFileSync(decisions, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const d = JSON.parse(line);
  chosen.set(`${d.seat}|${d.requestId}`, { choice: d.choice ?? [], labels: d.choiceLabels ?? [] });
}
const CHOICES = new Set(["assign_damage", "choose_entity", "choose_color", "choose_cards", "choose_ability"]);
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const rec = JSON.parse(line);
  if (flags.seat && rec.seat !== flags.seat) continue;
  if (flags.kind && rec.kind !== flags.kind) continue;
  if (!["attackers", "blockers", "priority", "london_bottom"].includes(rec.kind) && !CHOICES.has(rec.kind)) continue;
  const parsed = recordedRequest(rec); if (!parsed) continue;
  const req = parsed.req; const state = req.state as { turn?: number };
  totals[rec.kind] = (totals[rec.kind] ?? 0) + 1;
  const was = chosen.get(`${rec.seat}|${rec.requestId}`);
  const versus = (id: string) => !was ? "" : was.choice[0] === id ? "SAME" : `FLIP (the seat chose: ${was.labels.join(", ") || was.choice.join(", ")})`;
  let out = "";
  if (rec.kind === "attackers") { const d = suicidalAttackers(req, db); if (d.length) out = `suicidal: ${d.map((x) => `${x.name} (${x.auras} auras) dies to ${x.blocker}`).join("; ")}`; }
  if (rec.kind === "blockers") { const lb = lethalBlocks(req, db); if (lb) out = `lethal blocks → ${lb.why}`; }
  if (rec.kind === "priority") {
    const c = castingPlan(req, db, plans); if (c?.drop.length) out = `sequence drops: ${c.drop.map((d) => `${d.name} (${d.reason})`).join("; ")}\n      ${c.text.join("\n      ")}`; else if (c && flags.verbose) out = `plan: ${c.text.join(" | ")}`;
    const sec = manaColours(req, db, plans);
    if (sec) { bump("priority: mana section"); if (flags.section) out += `${out ? "\n" : ""}${sec.replace(/\n/g, "\n      ")}`; }
  }
  if (rec.kind === "assign_damage") {
    const a = trampleAssignment(req);
    if (!a) bump("assign_damage: model decides");
    else { const v = versus(a.id); bump(`assign_damage: ${v.split(" ")[0] || "policy"}`); if (flags.verbose || v.startsWith("FLIP")) out = `assign → ${a.label}  ${v}`; }
  }
  if (CHOICES.has(rec.kind) && rec.kind !== "assign_damage") {
    const mc = manaChoice(req, db, plans);
    const sec = manaColours(req, db, plans);
    if (mc?.choice) { const v = versus(mc.choice.id); bump(`${rec.kind}: mana ${v.split(" ")[0] || "policy"}`); out = `mana → ${mc.choice.label} (${mc.choice.why})  ${v}`; }
    else if (mc?.keep) { const kept = was && mc.keep.includes(was.choice[0]); bump(`${rec.kind}: mana narrowed, ${was ? (kept ? "seat's pick still offered" : "seat's pick DROPPED") : "no record"}`); out = `mana narrowed: not offering ${mc.dropped?.join(", ")}; the seat chose ${was?.labels.join(", ") ?? "?"}`; }
    else if (sec) { bump(`${rec.kind}: mana section only`); out = `mana section only; the seat chose ${was?.labels.join(", ") ?? "?"}`; }
    if (out && sec && flags.section) out += `\n      ${sec.replace(/\n/g, "\n      ")}`;
  }
  if (rec.kind === "london_bottom") {
    const bp = londonBottomPolicy(req, db);
    if (!bp) bump("london_bottom: model decides");
    else {
      const hit = (was?.choice ?? []).filter((id) => bp.drop.includes(id));
      bump(`london_bottom: narrowed, ${!was ? "no record" : hit.length ? "seat's pick DROPPED" : "seat's pick still offered"}`);
      const name = (id: string) => req.options.find((o) => o.id === id)?.label.replace(/^select card: your /, "").replace(/ \[Hand\]$/, "") ?? id;
      if (flags.verbose || hit.length) out = `bottom not offered: ${bp.drop.map(name).join(", ")} (${bp.why}); the seat chose ${(was?.choice ?? []).map(name).join(", ") || "?"}`;
    }
  }
  if (out) { console.log(`${rec.seat} ${rec.requestId} t${state.turn} [${rec.kind}]: ${out}`); if (++shown >= max) break; }
}
console.log(`prompts: ${JSON.stringify(totals)}, shown ${shown}`);
if (Object.keys(tally).length) console.log(`tally: ${JSON.stringify(tally, null, 1)}`);
