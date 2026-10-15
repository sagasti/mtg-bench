/** Turns a DecisionRequest into the text an LLM sees, applying the event's knowledge tier. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { type CardDb, cardText, getCard, isBasicLand } from "../cards/db.ts";
import type { EventConfig } from "../config.ts";
import type { DecisionRequest, Phase } from "../types.ts";
import { damageMath } from "../knowledge/damage.ts";
import { mulliganMath } from "../knowledge/mulligan.ts";
import { gamePlan } from "../knowledge/plans.ts";

const CARD_KEYS = new Set(["name", "card", "cards", "picks", "pool", "pack", "seen", "hand", "deck", "graveyard", "exile", "source"]);

/**
 * Collect every card name mentioned in state/options so we can attach oracle text. Objects that carry their own
 * `text` (permanents and tokens: Forge's current card-detail text) are already fully described, so they're skipped.
 */
export function collectCardNames(req: DecisionRequest, db: CardDb): string[] {
  const names = new Set<string>();
  const described = new Set<string>();
  const visit = (v: unknown, key?: string) => {
    if (typeof v === "string") { if (key && CARD_KEYS.has(key) && getCard(db, v)) names.add(getCard(db, v)!.name); return; }
    if (Array.isArray(v)) { for (const x of v) visit(x, key); return; }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.text === "string" && typeof o.name === "string") { described.add(o.name); return; }
      for (const [k, x] of Object.entries(o)) visit(x, k);
    }
  };
  visit(req.state);
  for (const o of req.options) if (o.card && getCard(db, o.card)) names.add(getCard(db, o.card)!.name);
  return [...names].filter((n) => !described.has(n)).sort();
}

export function renderRequest(req: DecisionRequest, event: EventConfig, db: CardDb, notes?: string, matchNotes?: string): string {
  const parts: string[] = [];
  parts.push(`# Decision: ${req.kind}\n${req.prompt}`);
  if (matchNotes) parts.push(`## Your match notes (written after earlier games of this match)\n${matchNotes}`);
  if (notes && event.carryNotes) parts.push(`## Your notes\n${notes}`);
  if (event.plansFile && req.phase === "game") {
    // Pilot patch: matchup plan for the seat's deck, the opponent's archetype inferred from what is visible.
    const plan = gamePlan(req, event.plansFile, db);
    if (plan) parts.push(plan);
  }
  parts.push(`## State\n${YAML.stringify(req.state, { lineWidth: 0 }).trim()}`);
  if (event.damageMath) {
    // Pilot patch: deterministic damage / lethal arithmetic, the same for every seat.
    const math = damageMath(req, db);
    if (math) parts.push(math);
  }
  if (event.mulliganMath) {
    // Pilot patch: keep/mulligan arithmetic (lands, sources, land-drop odds) and a heuristic verdict.
    const mull = mulliganMath(req, db);
    if (mull) parts.push(mull);
  }
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

/** prompts/ of this package, independent of the working directory. */
const PROMPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../prompts");
export const promptFile = (version: string, name: string) => path.join(PROMPTS_DIR, version, name);

/** Whether a prompt version has a given template (newer behaviour is keyed off the prompt version, so old runs reproduce). */
export function hasPrompt(version: string, name: string): boolean {
  return fs.existsSync(promptFile(version, name));
}

/** Fill a template from prompts/<version>/<name>. */
export function renderTemplate(version: string, name: string, vars: Record<string, string | number>): string {
  return fill(readPrompt(version, name), vars);
}

const promptCache = new Map<string, string>();
function readPrompt(version: string, name: string): string {
  const key = `${version}/${name}`;
  if (!promptCache.has(key)) {
    const file = promptFile(version, name);
    if (!fs.existsSync(file)) throw new Error(`prompt template missing: ${file}`);
    promptCache.set(key, fs.readFileSync(file, "utf8").trim());
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
