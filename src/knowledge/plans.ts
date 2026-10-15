/**
 * Pilot patch (mtg-rival): matchup plans. A YAML file (event.plansFile) lists archetypes with signature cards and a
 * plan per pair "ours|theirs" (plus "ours|*" when the opponent is not identified yet). The seat's own archetype is
 * inferred from its hand, battlefield, graveyard and exile; the opponent's from their battlefield, graveyard, exile,
 * the stack and the recent log. Rendered as a "Game plan" section before the state, the same for every seat.
 *
 *   archetypes:
 *     blue-terror: { name: "Mono Blue Terror", signature: [Tolarian Terror, Cryptic Serpent, Delver of Secrets] }
 *   plans:
 *     "blue-terror|bogles": "..."
 *     "blue-terror|*": "..."
 */
import fs from "node:fs";
import YAML from "yaml";
import type { CardDb } from "../cards/db.ts";
import type { DecisionRequest } from "../types.ts";

interface Archetype { name: string; signature: string[] }
interface Plans { archetypes: Record<string, Archetype>; plans: Record<string, string> }

const cache = new Map<string, { mtime: number; plans: Plans }>();
function load(file: string): Plans {
  const mtime = fs.statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.plans;
  const raw = YAML.parse(fs.readFileSync(file, "utf8")) as Plans;
  const plans: Plans = { archetypes: raw.archetypes ?? {}, plans: raw.plans ?? {} };
  cache.set(file, { mtime, plans });
  return plans;
}

function identify(names: Set<string>, archetypes: Record<string, Archetype>): { slug: string; hits: string[] } | null {
  let best: { slug: string; hits: string[] } | null = null;
  for (const [slug, a] of Object.entries(archetypes)) {
    const hits = a.signature.filter((s) => names.has(s));
    if (hits.length && (!best || hits.length > best.hits.length)) best = { slug, hits };
  }
  return best;
}

export function gamePlan(req: DecisionRequest, file: string, _db: CardDb): string | undefined {
  let plans: Plans;
  try { plans = load(file); } catch { return undefined; }
  const st = req.state as any;
  if (!st?.you) return undefined;
  const nameOf = (x: any) => (typeof x === "string" ? x : x?.name) as string | undefined;
  const mine = new Set<string>();
  for (const z of ["hand", "battlefield", "graveyard", "exile"]) for (const c of st.you?.[z] ?? []) { const n = nameOf(c); if (n) mine.add(n); }
  const theirs = new Set<string>();
  for (const z of ["battlefield", "graveyard", "exile"]) for (const c of st.opponent?.[z] ?? []) { const n = nameOf(c); if (n) theirs.add(n); }
  for (const s of st.stack ?? []) if (s?.controller === "opponent" && s.source) theirs.add(s.source);
  const me = String(st.youAre ?? "");
  for (const line of st.recentLog ?? []) {
    const m = String(line).match(/^(P\d) (?:cast|played|activated) (.+?)(?: targeting .*)?\.?$/);
    if (m && m[1] !== me) theirs.add(m[2].replace(/ \(\d+\)$/, ""));
  }
  const ours = identify(mine, plans.archetypes);
  if (!ours) return undefined;
  const opp = identify(theirs, plans.archetypes);
  const key = opp ? `${ours.slug}|${opp.slug}` : `${ours.slug}|*`;
  const text = plans.plans[key] ?? plans.plans[`${ours.slug}|*`];
  if (!text) return undefined;
  const head = `## Game plan: ${plans.archetypes[ours.slug].name} vs ${opp ? `${plans.archetypes[opp.slug].name} (seen: ${opp.hits.slice(0, 4).join(", ")})` : "unknown deck (nothing distinctive seen yet)"}`;
  return `${head}\n${text.trim()}`;
}
