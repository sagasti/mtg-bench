/**
 * Comprehensive Rules search. Drop the plain-text CR from
 * https://magic.wizards.com/en/rules into data/MagicCompRules.txt (see data/README.md).
 * Supports lookup by rule number ("702.19", "506.4a") and keyword search.
 */
import fs from "node:fs";
import path from "node:path";

interface RuleEntry { id: string; text: string; tokens: Map<string, number> }

const STOP = new Set("a an the of to in is it and or for on with as be by that this if its are at from can any".split(" "));
function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9.\s]/g, " ").split(/\s+/).filter((t) => t && !STOP.has(t));
}

export class RulesIndex {
  private entries: RuleEntry[] = [];
  private byId = new Map<string, RuleEntry>();
  private df = new Map<string, number>();
  constructor(text: string) {
    // Normalise line endings and split into numbered rules + glossary paragraphs.
    const lines = text.replace(/\r/g, "").split("\n");
    // Layout of the official file: intro, table of contents (ends with "Credits"),
    // numbered rules, "Glossary", glossary entries, "Credits". Skip everything up to the end of the contents.
    let stage: "preamble" | "rules" | "glossary" = lines.some((l) => /^Credits\s*$/.test(l.trim())) ? "preamble" : "rules";
    let cur: { id: string; text: string } | null = null;
    const push = () => { if (cur && cur.text.trim()) this.add(cur.id, cur.text.trim()); cur = null; };
    for (const line of lines) {
      const t = line.trim();
      if (stage === "preamble") { if (/^Credits$/.test(t)) stage = "rules"; continue; }
      if (stage === "rules") {
        if (/^Glossary$/.test(t)) { push(); stage = "glossary"; continue; }
        const m = line.match(/^(\d{3}(?:\.\d+[a-z]?)?)\.?\s+(.*)$/);
        if (m) { push(); cur = { id: m[1], text: `${m[1]} ${m[2]}` }; continue; }
        if (cur && t) (cur as { text: string }).text += "\n" + t;
      } else {
        if (/^Credits$/.test(t)) { push(); break; }
        if (!t) { push(); continue; }
        if (!cur) cur = { id: `glossary:${t.toLowerCase()}`, text: `Glossary — ${t}` };
        else (cur as { text: string }).text += "\n" + t;
      }
    }
    push();
  }
  private add(id: string, text: string) {
    const tokens = new Map<string, number>();
    for (const t of tokenize(text)) tokens.set(t, (tokens.get(t) ?? 0) + 1);
    const e = { id, text, tokens };
    this.entries.push(e);
    if (!this.byId.has(id)) this.byId.set(id, e);
    for (const t of tokens.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
  }
  get size() { return this.entries.length; }

  search(query: string, limit = 5, maxChars = 3000): string {
    const q = query.trim();
    const num = q.match(/^(?:rule\s*)?(\d{3}(?:\.\d+[a-z]?)?)$/i);
    let hits: RuleEntry[];
    if (num) {
      const id = num[1];
      hits = this.entries.filter((e) => e.id === id || e.id.startsWith(id + (id.includes(".") ? "" : ".")) || (id.includes(".") && /^[a-z]$/.test(e.id.slice(id.length)) && e.id.startsWith(id)));
      hits = hits.slice(0, 12);
    } else {
      const qt = tokenize(q);
      const N = this.entries.length;
      const scored = this.entries.map((e) => {
        let s = 0;
        for (const t of qt) {
          const tf = e.tokens.get(t);
          if (tf) s += (1 + Math.log(tf)) * Math.log(1 + N / (this.df.get(t) ?? 1));
        }
        if (e.id.startsWith("glossary:") && qt.some((t) => e.id.includes(t))) s *= 1.5;
        return { e, s: s / Math.sqrt(1 + e.text.length / 400) };
      }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
      hits = scored.slice(0, limit).map((x) => x.e);
    }
    if (!hits.length) return `No rules matched "${query}".`;
    let out = "";
    for (const h of hits) {
      if (out.length + h.text.length > maxChars) { out += `\n… (${hits.length} matches; refine the query for more)`; break; }
      out += (out ? "\n\n" : "") + h.text;
    }
    return out;
  }
}

let cached: RulesIndex | null | undefined;
export function loadRules(file = path.resolve("data/MagicCompRules.txt")): RulesIndex | null {
  if (cached !== undefined) return cached;
  cached = fs.existsSync(file) ? new RulesIndex(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) : null;
  return cached;
}
