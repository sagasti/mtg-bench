/**
 * Queryable knowledge exposed to LLM agents as tools (knowledge tier "oracle+tools").
 * Every seat in an event gets exactly the same tools and the same per-decision budget.
 */
import { type CardDb, type CardDef, cardText, getCard, prettyCost } from "../cards/db.ts";
import type { KnowledgeTier } from "../config.ts";
import { loadRules } from "./rules.ts";

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>; // JSON Schema
}

export const SUBMIT_BRIEF_TOOL: ToolDef = {
  name: "submit_brief",
  description: "Submit your cube strategy brief (markdown). It will be shown to you at every draft pick.",
  input_schema: { type: "object", properties: { brief: { type: "string" } }, required: ["brief"] },
};

export const SUBMIT_NOTES_TOOL: ToolDef = {
  name: "submit_notes",
  description: "Submit your match notes. They replace your previous match notes and are shown to you during the rest of this match.",
  input_schema: { type: "object", properties: { notes: { type: "string" } }, required: ["notes"] },
};

export function studyTools(tier: KnowledgeTier): ToolDef[] {
  return tier.startsWith("oracle+tools") ? [...KNOWLEDGE_TOOLS, SUBMIT_BRIEF_TOOL] : [SUBMIT_BRIEF_TOOL];
}

export const SUBMIT_TOOL: ToolDef = {
  name: "submit_decision",
  description:
    "Submit your final answer for the current decision. `choice` is a list of option ids (the text inside [brackets]) taken exactly from the Options list. " +
    "For deckbuilding also give `basics` (basic land name -> count). You may add a short `rationale` and, if enabled, `notes` for your future self.",
  input_schema: {
    type: "object",
    properties: {
      choice: { type: "array", items: { type: "string" }, description: "Option ids, e.g. [\"cast:k01\"], or [] to choose nothing when allowed." },
      basics: { type: "object", additionalProperties: { type: "integer" }, description: "Deckbuilding only, e.g. {\"Forest\": 9, \"Mountain\": 8}" },
      rationale: { type: "string", description: "One or two sentences on why. Logged for analysis only." },
      notes: { type: "string", description: "Optional scratchpad carried to your next decision (replaces the previous notes). Keep it short." },
    },
    required: ["choice"],
  },
};

const KNOWLEDGE_TOOLS: ToolDef[] = [
  {
    name: "lookup_card",
    description: "Get the full oracle text, mana cost, type line and P/T of a card by exact name (all faces for double-faced/split cards).",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "search_cube",
    description:
      "Search the card list of the cube being drafted in this event. Filter by text in name/oracle, colors (e.g. \"UB\"; \"C\" for colorless), " +
      "type substring (e.g. \"Creature\", \"Instant\"), and max mana value. Returns up to 30 one-line results.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string" }, colors: { type: "string" }, type: { type: "string" }, max_cmc: { type: "integer" },
      },
    },
  },
  {
    name: "search_rules",
    description: "Search the Magic Comprehensive Rules. Pass a rule number (\"702.19\", \"510.1c\") or keywords (\"trample assign lethal damage\").",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];

export function toolsForTier(tier: KnowledgeTier): ToolDef[] {
  return tier.startsWith("oracle+tools") ? [...KNOWLEDGE_TOOLS, SUBMIT_TOOL] : [SUBMIT_TOOL];
}

export class KnowledgeBase {
  private cubeCards: CardDef[];
  constructor(private db: CardDb, cubeNames: string[]) {
    const seen = new Set<string>();
    this.cubeCards = [];
    for (const n of cubeNames) {
      if (seen.has(n)) continue;
      seen.add(n);
      const c = getCard(db, n);
      if (c) this.cubeCards.push(c);
    }
  }

  run(name: string, input: any): string {
    switch (name) {
      case "lookup_card": {
        const c = getCard(this.db, String(input?.name ?? ""));
        if (!c) return `No card named "${input?.name}". Names must match exactly (case-insensitive).`;
        return cardText(c, { includeOracle: true });
      }
      case "search_cube": {
        const text = String(input?.text ?? "").toLowerCase();
        const type = String(input?.type ?? "").toLowerCase();
        const colors = String(input?.colors ?? "").toUpperCase().split("").filter(Boolean);
        const maxCmc = input?.max_cmc;
        const res = this.cubeCards.filter((c) => {
          if (text && !c.name.toLowerCase().includes(text) && !c.oracle.toLowerCase().includes(text)) return false;
          if (type && !c.types.toLowerCase().includes(type)) return false;
          if (typeof maxCmc === "number" && c.cmc > maxCmc) return false;
          if (colors.length) {
            if (colors.includes("C")) { if (c.colors.length) return false; }
            else if (!c.colors.some((x) => colors.includes(x))) return false;
          }
          return true;
        });
        const lines = res.slice(0, 30).map((c) => `${c.name} ${prettyCost(c.manaCost)} — ${c.types}${c.pt ? ` ${c.pt}` : ""}`);
        return `${res.length} match(es)${res.length > 30 ? " (showing 30)" : ""}:\n` + lines.join("\n");
      }
      case "search_rules": {
        const rules = loadRules();
        if (!rules) return "The Comprehensive Rules are not available in this environment.";
        return rules.search(String(input?.query ?? ""));
      }
      default:
        return `Unknown tool "${name}".`;
    }
  }
}
