/** Pilot patch (mtg-rival): print the exact system prompt and decision tools the harness sends in the game phase, so a
 *  fine-tuning dataset can reproduce the chat format. Usage: tsx src/knowledge/sft-meta.ts <config.yaml> > meta.json */
import { loadConfig } from "../config.ts";
import { systemPrompt } from "../agents/render.ts";
import { toolsForTier } from "./tools.ts";
const cfg = loadConfig(process.argv[2]);
const tools = toolsForTier(cfg.event.knowledge).map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema }));
process.stdout.write(JSON.stringify({ system: systemPrompt(cfg.event, "game"), tools, promptVersion: cfg.event.promptVersion, knowledge: cfg.event.knowledge }, null, 1));
