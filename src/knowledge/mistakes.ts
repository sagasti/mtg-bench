/** Pilot patch: count tactical mistakes of a seat over a recorded run, recomputing the Combat / open-mana sections on
 *  each prompt (so runs recorded without them can be profiled too).
 *  tsx src/knowledge/mistakes.ts <run dir> <plans.yaml> [--seat glm] [--verbose] */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getCard, loadDb } from "../cards/db.ts";
import type { DecisionOption, DecisionRequest } from "../types.ts";
import { combatMath } from "./combat.ts";
import { castingPlan, openMana } from "./interaction.ts";
const args = process.argv.slice(2); const flags: Record<string, string> = {}; const pos: string[] = [];
for (let i = 0; i < args.length; i++) { if (args[i].startsWith("--")) { if (args[i] === "--verbose") { flags.verbose = "1"; continue; } flags[args[i].slice(2)] = args[i + 1]; i++; } else pos.push(args[i]); }
const [run, plans] = pos; const seat = flags.seat ?? "glm";
const db = loadDb();
const jl = (f: string) => fs.readFileSync(path.join(run, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const prompts = new Map<string, string>(jl("rendered-prompts.jsonl").filter((r) => r.seat === seat).map((r) => [r.requestId, r.prompt]));
const counts: Record<string, number> = { decisions: 0, attackers: 0, risky_attack: 0, blockers: 0, no_block_lethal: 0, declined_good_block: 0, declined_trade: 0, aura_targets: 0, aura_on_non_hexproof: 0, casts: 0, pierce_exposed: 0, bait_before_key: 0, cast_into_open_counter: 0, cast_tapped_out: 0, pass_tapped_out_with_castable: 0 };
const notes: string[] = [];
for (const d of jl("decisions.jsonl")) {
  if (d.seat !== seat || d.phase !== "game" || !d.valid || d.forfeit) continue;
  const p = prompts.get(d.requestId); if (!p) continue;
  const s = p.indexOf("## State\n"); const o = p.indexOf("\n## Options\n", s); if (s < 0 || o < 0) continue;
  const m = p.indexOf("\n## ", s + 9); const state = YAML.parse(p.slice(s + 9, m >= 0 && m < o ? m : o).trim());
  const rest = p.slice(o + 12); const optText = rest.slice(0, rest.indexOf("\n\nChoose") < 0 ? undefined : rest.indexOf("\n\nChoose"));
  const options: DecisionOption[] = []; for (const l of optText.split("\n")) { const mm = l.match(/^- \[([^\]]+)\] (.*)$/); if (mm) options.push({ id: mm[1], label: mm[2] }); }
  const head = p.slice(0, s).split("\n").slice(1).join("\n");
  const req: DecisionRequest = { requestId: d.requestId, phase: "game", kind: d.kind, prompt: head, state, options, min: 0, max: 9 };
  const choice: string[] = d.choice ?? []; const chosen = options.filter((x) => choice.includes(x.id));
  counts.decisions++;
  const combat = combatMath(req, db) ?? ""; const open = openMana(req, db, plans) ?? "";
  const tag = `${d.matchId} t${state.turn}`;
  if (d.kind === "attackers") {
    counts.attackers++;
    const flagged = new Set([...combat.matchAll(/^- (.+?) \d+\/\d+.*⚠ dies if/gm)].map((x) => x[1]));
    const lethal = (() => { const mm = combat.match(/If nothing is blocked: (\d+) damage \(their life (\d+)/); return mm ? Number(mm[1]) >= Number(mm[2]) : false; })();
    const risky = chosen.map((x) => x.label.replace(/^Attack with card: your /, "").replace(/ \d+\/\d+.*$/, "")).filter((n) => flagged.has(n));
    if (risky.length && !lethal) { counts.risky_attack++; notes.push(`${tag} risky attack: ${risky.join(", ")}`); }
  }
  if (d.kind === "blockers") {
    counts.blockers++;
    if (/⚠ LETHAL if unblocked/.test(combat) && !chosen.length) { counts.no_block_lethal++; notes.push(`${tag} no block vs lethal`); }
    if (/\(good block\)/.test(combat) && !chosen.length) { counts.declined_good_block++; notes.push(`${tag} declined a block that kills and survives`); }
    else if (/\(trade\)/.test(combat) && !chosen.length) counts.declined_trade++;   // a judgment call (racing, keeping an aura target): counted, not flagged
  }
  if (d.kind === "targets") {
    const mm = head.match(/^You are casting (.+?); choose its targets\./m); const card = mm ? getCard(db, mm[1]) : undefined;
    if (card && /\bAura\b/.test(card.types) && /^Enchant creature/m.test(card.oracle)) {
      counts.aura_targets++;
      const perms = new Map<string, any>((state?.you?.battlefield ?? []).map((q: any) => [q.id, q]));
      const own = options.filter((x) => /^select card as target: your /.test(x.label));
      const hexIds = new Set(own.filter((x) => { const q = perms.get(x.id); return q && !q.token && /\bHexproof\b/i.test(q.text ?? ""); }).map((x) => x.id));
      if (hexIds.size && chosen.some((x) => !hexIds.has(x.id))) { counts.aura_on_non_hexproof++; notes.push(`${tag} ${card.name} on ${chosen.map((x) => x.label.replace(/^select card as target: /, "")).join(", ")}`); }
    }
  }
  if (d.kind === "priority" && state.activePlayer === "you" && /^MAIN/.test(String(state.phase))) {
    const cast = chosen.find((x) => /^cast spell: your /.test(x.label));
    const haveCreature = (state?.you?.battlefield ?? []).some((q: any) => q.pt);
    const castable = options.some((x) => { if (!/^cast spell: your /.test(x.label)) return false; const c = getCard(db, x.label.replace(/^cast spell: your /, "").replace(/ \[Hand\].*$/, "")); return !(c && /\bAura\b/.test(c.types) && !haveCreature); });   // an Aura with no creature to wear it is not a real option
    const tappedOut = /TAPPED OUT/.test(open);
    const pierce = /can pay now: [^\n]*Spell Pierce ×/.test(open); const counter = /can pay now: [^\n]*Counterspell ×/.test(open);
    if (cast) {
      counts.casts++;
      const plan = castingPlan(req, db, plans);
      if (plan?.drop.some((d) => d.id === cast.id)) { counts.bait_before_key++; notes.push(`${tag} ${plan.drop.find((d) => d.id === cast.id)!.name}: ${plan.drop.find((d) => d.id === cast.id)!.reason}`); }
      const name = cast.label.replace(/^cast spell: your /, "").replace(/ \[Hand\].*$/, "").replace(/ \(.*$/, "");
      const c = getCard(db, name);
      if (tappedOut) counts.cast_tapped_out++;
      if (counter) counts.cast_into_open_counter++;
      const left = open.match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(\\d+\\) → (\\d+)`));
      if (pierce && c && !/\bCreature\b/.test(c.types) && left && Number(left[1]) < 2) { counts.pierce_exposed++; notes.push(`${tag} ${name} cast with ${left[1]} mana left vs live Spell Pierce`); }
    } else if (tappedOut && castable && chosen.some((x) => /^Button: OK|^pass/i.test(x.label))) { counts.pass_tapped_out_with_castable++; notes.push(`${tag} passed with castable spells while they were tapped out`); }
  }
}
console.log(JSON.stringify(counts));
if (flags.verbose) for (const n of notes) console.log("  " + n);
