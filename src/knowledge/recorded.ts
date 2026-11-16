/** Pilot patch: a recorded prompt (rendered-prompts.jsonl) back into the DecisionRequest it was rendered from. */
import YAML from "yaml";
import type { DecisionOption, DecisionRequest } from "../types.ts";

export interface Recorded { seat: string; matchId?: string; game?: number; kind: string; requestId: string; prompt: string }

export interface Replayable { req: DecisionRequest; notes?: string; matchNotes?: string }

/** Game decisions only (the ones with a State section). Sections computed by the harness are not parsed: they are recomputed. */
export function recordedRequest(rec: Recorded): Replayable | undefined {
  const p = rec.prompt; const s = p.indexOf("## State\n"); const o = p.indexOf("\n## Options\n", s); if (s < 0 || o < 0) return undefined;
  const m = p.indexOf("\n## ", s + 9); const state = YAML.parse(p.slice(s + 9, m >= 0 && m < o ? m : o).trim());
  const rest = p.slice(o + 12); const end = rest.indexOf("\n\nChoose");
  const options: DecisionOption[] = [];
  for (const l of rest.slice(0, end < 0 ? undefined : end).split("\n")) { const mm = l.match(/^- \[([^\]]+)\] (.*)$/); if (mm) options.push({ id: mm[1], label: mm[2] }); }
  const how = end < 0 ? "" : rest.slice(end + 2);
  const exact = how.match(/^Choose exactly (\d+) option/); const range = how.match(/^Choose between (\d+) and (\d+) options/);
  const min = exact ? Number(exact[1]) : range ? Number(range[1]) : 0; const max = exact ? Number(exact[1]) : range ? Number(range[2]) : options.length;
  const section = (title: string) => {
    const i = p.indexOf(`\n## ${title}`); if (i < 0 || i > s) return undefined;
    const b = p.indexOf("\n", i + 1); return p.slice(b + 1, p.indexOf("\n## ", b)).trim();
  };
  const head = p.slice(p.indexOf("\n") + 1, p.indexOf("\n## ")).trim();
  return { req: { requestId: rec.requestId, phase: "game", kind: rec.kind as DecisionRequest["kind"], prompt: head, state, options, min, max }, notes: section("Your notes"), matchNotes: section("Your match notes") };
}
