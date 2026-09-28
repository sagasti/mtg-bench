/** Turns a DecisionRequest into the text an LLM sees, applying the event's knowledge tier. */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { type CardDb, cardText, getCard, isBasicLand } from "../cards/db.ts";
import type { EventConfig } from "../config.ts";
import type { DecisionRequest, Phase } from "../types.ts";

const CARD_KEYS = new Set(["name", "card", "cards", "picks", "pool", "pack", "seen", "hand", "deck"]);

/** Collect every card name mentioned in state/options so we can attach oracle text. */
export function collectCardNames(req: DecisionRequest, db: CardDb): string[] {
  const names = new Set<string>();
  const visit = (v: unknown, key?: string) => {
    if (typeof v === "string") { if (key && CARD_KEYS.has(key) && getCard(db, v)) names.add(getCard(db, v)!.name); return; }
    if (Array.isArray(v)) { for (const x of v) visit(x, key); return; }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  visit(req.state);
  for (const o of req.options) if (o.card && getCard(db, o.card)) names.add(getCard(db, o.card)!.name);
  return [...names].sort();
}

export function renderRequest(req: DecisionRequest, event: EventConfig, db: CardDb, notes?: string): string {
  const parts: string[] = [];
  parts.push(`# Decision: ${req.kind}\n${req.prompt}`);
  if (notes && event.carryNotes) parts.push(`## Your notes\n${notes}`);
  parts.push(`## State\n${YAML.stringify(req.state, { lineWidth: 0 }).trim()}`);
  const optLines = req.options.map((o) => `- [${o.id}] ${o.label}`);
  parts.push(`## Options\n${optLines.join("\n")}`);
  const how = req.min === req.max
    ? `Choose exactly ${req.min} option${req.min === 1 ? "" : "s"}.`
    : `Choose between ${req.min} and ${req.max} options.`;
  let extra = "";
  if (req.kind === "deckbuild") extra = ` Also set \`basics\`. Minimum deck size: ${req.constraints?.minDeckSize ?? 40} cards including basics.`;
  parts.push(`${how}${extra} Answer with the submit_decision tool.`);
  if (event.knowledge !== "names") {
    const names = collectCardNames(req, db).filter((n) => !isBasicLand(n));
    if (names.length) {
      const refs = names.map((n) => cardText(getCard(db, n)!, { includeOracle: true }));
      parts.push(`## Card reference\n${refs.join("\n")}`);
    }
  }
  return parts.join("\n\n");
}

const promptCache = new Map<string, string>();
function readPrompt(version: string, name: string): string {
  const key = `${version}/${name}`;
  if (!promptCache.has(key)) {
    const file = path.resolve("prompts", version, name);
    promptCache.set(key, fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "");
  }
  return promptCache.get(key)!;
}

function fill(t: string, vars: Record<string, string | number>) {
  return t.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : `{{${k}}}`));
}

/** System prompt = base + knowledge tier + notes + phase section. Stable per phase so providers can cache it. */
/**
 * NOTE: the cube's name and the event name are deliberately NOT template variables.
 * Agents only ever see card lists, never a label that could key into memorised
 * archetype guides. LlmAgent also refuses to send any prompt containing either name.
 */
export function systemPrompt(event: EventConfig, phase: Phase | "study", brief?: string): string {
  const vars = {
    games_per_match: event.gamesPerMatch, brief_max_words: event.briefMaxWords,
    format_description: event.format === "round-robin" ? "round robin: you play every other seat once" : `${event.rounds} Swiss rounds`,
    pack_size: event.packSize, min_deck_size: event.minDeckSize, max_tool_calls: event.maxToolCallsPerDecision,
  };
  const knowledge = fill(readPrompt(event.promptVersion, `knowledge-${event.knowledge}.md`), vars);
  const notes = event.carryNotes && phase !== "study" ? fill(readPrompt(event.promptVersion, "notes.md"), vars) : "";
  const base = fill(readPrompt(event.promptVersion, "system.md"), { ...vars, knowledge_blurb: knowledge, notes_blurb: notes });
  const sections = [base];
  if (event.knowledge === "oracle+tools+primer") sections.push(readPrompt(event.promptVersion, "primer.md"));
  const phaseFile = phase === "game" ? "game.md" : `${phase}.md`;
  sections.push(fill(readPrompt(event.promptVersion, phaseFile), vars));
  const showBrief = brief && phase !== "study" && (event.briefScope === "all" || phase === "draft");
  if (showBrief) sections.push(`${readPrompt(event.promptVersion, "study-brief-header.md")}\n${brief}`);
  return sections.join("\n\n").replace(/\n{3,}/g, "\n\n");
}
