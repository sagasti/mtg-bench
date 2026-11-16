/** Pilot patch: recorded decisions through the live model, with the sections and policies of the current tree. Does the
 *  model follow a new section? Seconds per decision, against the fifty minutes of a paired run (which may never reach
 *  the same spot again once an earlier decision changes). A decision answered by a policy shows 0 model calls.
 *  tsx src/knowledge/llm-replay.ts <config.yaml> <rendered-prompts.jsonl> --ids <requestId,...> [--seat glm] [--as <seat of the config>] [--n 3] [--prompt 1] */
import fs from "node:fs";
import path from "node:path";
import { LlmAgent } from "../agents/llm.ts";
import { OpenAIProvider } from "../agents/providers/openai.ts";
import { renderRequest } from "../agents/render.ts";
import { loadDb } from "../cards/db.ts";
import { loadConfig } from "../config.ts";
import { recordedRequest } from "./recorded.ts";
import { KnowledgeBase } from "./tools.ts";
const args = process.argv.slice(2); const flags: Record<string, string> = {}; const pos: string[] = [];
for (let i = 0; i < args.length; i++) { if (args[i].startsWith("--")) { flags[args[i].slice(2)] = args[i + 1]; i++; } else pos.push(args[i]); }
const [configFile, file] = pos; const seatId = flags.seat ?? "glm"; const n = Number(flags.n ?? 1);
const ids = new Set((flags.ids ?? "").split(",").filter(Boolean));
if (!configFile || !file || !ids.size) { console.error("usage: llm-replay.ts <config.yaml> <rendered-prompts.jsonl> --ids <requestId,...> [--seat glm] [--as seat] [--n 3] [--prompt 1]"); process.exit(2); }
const cfg = loadConfig(configFile);
const sc = cfg.seats.find((x) => x.id === (flags.as ?? seatId));
if (!sc || !["openai", "openrouter", "gemini"].includes(sc.provider)) throw new Error(`seat ${flags.as ?? seatId}: not an OpenAI-compatible seat of ${configFile}`);
const db = loadDb();
const agent = new LlmAgent(sc, new OpenAIProvider(sc, {}), cfg.event, cfg.event.cube, db, new KnowledgeBase(db, []));
const event = sc.eventOverrides ? { ...cfg.event, ...sc.eventOverrides } : cfg.event;
const chosen = new Map<string, string>();
const decisions = path.join(path.dirname(file), "decisions.jsonl");
if (fs.existsSync(decisions)) for (const line of fs.readFileSync(decisions, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const d = JSON.parse(line);
  chosen.set(`${d.seat}|${d.requestId}`, (d.choiceLabels ?? d.choice ?? []).join(", "));
}
/** Without the reminder text Forge appends to an ability label. */
const brief = (label: string) => label.replace(/ \([^()]{40,}\)$/, "");
const tally: Record<string, number> = {};
for (const line of fs.readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const rec = JSON.parse(line);
  if (rec.seat !== seatId || !ids.has(rec.requestId)) continue;
  const parsed = recordedRequest(rec);
  if (!parsed) { console.log(`${rec.requestId}: not a game decision`); continue; }
  const { req, notes, matchNotes } = parsed;
  const was = chosen.get(`${rec.seat}|${rec.requestId}`) ?? "?";
  console.log(`\n=== ${rec.requestId} t${(req.state as { turn?: number }).turn} [${req.kind}] ${req.prompt.split("\n")[0]}\n    recorded: ${was}`);
  if (flags.prompt) console.log(renderRequest(req, event, db, notes, matchNotes).replace(/\n## Card reference[\s\S]*$/, ""));
  for (let i = 0; i < n; i++) {
    const r = await agent.decide(req, { pod: 0, matchId: rec.matchId, game: rec.game, notes, matchNotes }, () => {});
    const labels = (r.response?.choice ?? []).map((id) => req.options.find((o) => o.id === id)?.label ?? id).join(", ") || "(nothing)";
    const short = brief(labels);
    tally[`${rec.requestId}: ${short}`] = (tally[`${rec.requestId}: ${short}`] ?? 0) + 1;
    console.log(`    now ${i + 1}/${n}: ${short}${short === brief(was) ? "" : "   ← CHANGED"}  (${r.modelCalls} model call${r.modelCalls === 1 ? "" : "s"})\n      ${(r.response?.rationale ?? "").replace(/\s+/g, " ").slice(0, 420)}`);
  }
}
console.log(`\ntally: ${JSON.stringify(tally, null, 1)}`);
process.exit(0);
