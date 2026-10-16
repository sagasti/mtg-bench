/**
 * Pilot patch (mtg-rival): "Keep or mulligan" section rendered into mulligan and london_bottom prompts when
 * event.mulliganMath is on. Deterministic and the same for every seat: counts lands and other mana sources in the
 * hand, cheap plays and cantrips, computes land-drop odds (hypergeometric over the seat's own deck) and states a
 * heuristic verdict that a careful Pauper player would reach. The model may still override it.
 *
 * Diagnosis behind it (15/10): the pilot kept one-land hands 57 of 76 times; those won 67 % against 83-92 % for
 * two- and three-land hands, and 17 of its 30 losses were mana screws.
 */
import { type CardDb, getCard, isBasicLand, prettyCost } from "../cards/db.ts";
import type { DecisionRequest } from "../types.ts";

interface HandCard { id?: string; name: string; pt?: string; text?: string }

/** The verdict behind the section. `binding` marks the clear-cut cases (no land, a one-lander without a second
 *  source, five or more lands on seven) that event.mulliganPolicy "strict" answers without asking the model. */
export interface MulliganVerdict { verdict: string; why: string; action: "keep" | "mulligan"; binding: boolean }
const verdicts = new Map<string, MulliganVerdict>();
export function mulliganVerdict(req: DecisionRequest, db: CardDb): MulliganVerdict | undefined {
  if (req.kind !== "mulligan") return undefined;
  mulliganMath(req, db);
  return verdicts.get(req.requestId);
}

export function mulliganMath(req: DecisionRequest, db: CardDb): string | undefined {
  if (req.kind !== "mulligan" && req.kind !== "london_bottom") return undefined;
  const st = req.state as any;
  const hand: HandCard[] = st?.you?.hand ?? [];
  if (!hand.length) return undefined;
  const deckSize = Number(req.hints?.deckSize ?? 60);
  const deckLands = Number(req.hints?.deckLands ?? Math.round(deckSize * 0.4));
  // Forge's prompt says "P1, you are going first!" or "P2 is going first. P1, you are going 2nd."
  const onPlay = /you are going first/i.test(req.prompt) ? true : /you are going (2nd|second)/i.test(req.prompt) ? false : undefined;

  const lands = hand.filter((c) => isLand(c, db));
  const spells = hand.filter((c) => !isLand(c, db));
  const info = (c: HandCard) => getCard(db, c.name);
  const cmc = (c: HandCard) => info(c)?.cmc ?? 0;
  const oracle = (c: HandCard) => (info(c) ? [...info(c)!.keywords, info(c)!.oracle].join("\n") : c.text ?? "");
  const dorks = spells.filter((c) => c.pt && /\{T\}: Add \{/.test(oracle(c)) && cmc(c) <= 2);
  const landcyclers = spells.filter((c) => /landcycling|Islandcycling|Forestcycling|Plainscycling|Swampcycling|Mountaincycling/i.test(oracle(c)));
  const fetchers = spells.filter((c) => /Search your library for a (?:basic )?(?:land|Forest|Island|Mountain|Plains|Swamp) card/i.test(oracle(c)) && cmc(c) <= 1 && !landcyclers.includes(c));
  const cantrips = spells.filter((c) => !c.pt && cmc(c) <= 1 && /Draw (a|two|three) cards?|Scry \d|Look at the top|Surveil \d/i.test(oracle(c)));
  const oneDrops = spells.filter((c) => cmc(c) <= 1 && !fetchers.includes(c) && !landcyclers.includes(c));
  const cheap = spells.filter((c) => cmc(c) <= 2);
  const expensive = spells.filter((c) => cmc(c) >= 4);
  const minCmc = spells.length ? Math.min(...spells.map(cmc)) : 0;

  const fmt = (cs: HandCard[]) => cs.map((c) => `${c.name}${info(c)?.manaCost ? " " + prettyCost(info(c)!.manaCost) : ""}`).join(", ") || "none";
  const lines: string[] = [];

  if (req.kind === "london_bottom") {
    const n = req.min;
    lines.push(`## Keep or mulligan`);
    lines.push(`Computed by the harness. You drew ${hand.length} and keep ${hand.length - n}: put ${n} on the bottom. Lands: ${lands.length} (${fmt(lands)}); spells by cost: ${spells.sort((a, b) => cmc(a) - cmc(b)).map((c) => `${c.name} ${cmc(c)}`).join(", ") || "none"}.`);
    const keepLands = Math.min(lands.length, hand.length - n <= 5 ? 3 : 4);
    const sugg: string[] = [];
    let surplusLands = lands.length - keepLands;
    const byCost = [...spells].sort((a, b) => cmc(b) - cmc(a));
    let need = n;
    while (need > 0 && surplusLands > 0) { sugg.push(lands[lands.length - surplusLands].name); surplusLands--; need--; }
    for (const c of byCost) { if (need <= 0) break; sugg.push(`${c.name} (${cmc(c)})`); need--; }
    lines.push(`Rule of thumb: keep ${keepLands >= lands.length ? "all your lands" : `${keepLands} lands`} and your cheapest plays; bottom extra lands first, then the most expensive spells. Suggested bottom: ${sugg.join(", ") || "any"}.`);
    return lines.join("\n");
  }

  // mulligan decision
  // Forge's prompt does not say how many mulligans were taken; the engine counts the mulligan decisions asked so far.
  const mullsSoFar = Number(req.hints?.mulligansSoFar ?? 0);
  const keepSize = 7 - mullsSoFar;
  const library = Math.max(1, Number(st?.you?.librarySize ?? deckSize - hand.length));
  const landsLeft = Math.max(0, deckLands - lands.length);
  const drawsBy = (turn: number) => onPlay === false ? turn : turn - 1; // on the play you skip the first draw
  const pAtLeast = (k: number, draws: number) => { let p = 0; for (let i = 0; i < k; i++) p += hyper(i, draws, landsLeft, library); return Math.max(0, 1 - p); };
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  lines.push(`## Keep or mulligan`);
  lines.push(`Computed by the harness. Hand of ${hand.length}${mullsSoFar ? ` after ${mullsSoFar} mulligan${mullsSoFar > 1 ? "s" : ""} (keep ${keepSize}, or mulligan again to ${keepSize - 1})` : ""}, ${onPlay === undefined ? "" : onPlay ? "on the play. " : "on the draw. "}Deck: ${deckLands} lands in ${deckSize}.`);
  lines.push(`- Lands in hand: ${lands.length} (${fmt(lands)}). Other mana sources: ${[...dorks, ...fetchers, ...landcyclers].length ? fmt([...dorks, ...fetchers, ...landcyclers]) : "none"}.`);
  lines.push(`- Plays: one-mana spells ${oneDrops.length} (${fmt(oneDrops)}), cantrips ${cantrips.length}, spells costing 2 or less ${cheap.length}, costing 4 or more ${expensive.length}${spells.length ? `; cheapest spell costs ${minCmc}` : ""}.`);
  if (onPlay !== undefined) {
    const need2 = Math.max(0, 2 - lands.length), need3 = Math.max(0, 3 - lands.length), need4 = Math.max(0, 4 - lands.length);
    lines.push(`- Land-drop odds (${landsLeft} lands left in ${library} cards): 2nd land by turn 2: ${pct(pAtLeast(need2, drawsBy(2)))}, 3rd land by turn 3: ${pct(pAtLeast(need3, drawsBy(3)))}, 4th land by turn 4: ${pct(pAtLeast(need4, drawsBy(4)))}.`);
  }
  const sources = lands.length + fetchers.length + landcyclers.length;
  let verdict: string, why: string, binding = false;
  if (keepSize <= 5) {
    if (lands.length === 0 && sources === 0) { verdict = "MULLIGAN"; binding = true; why = "no land at all; even at 5 a hand that cannot cast anything loses"; }
    else if (lands.length >= 5) { verdict = "MULLIGAN"; why = "five or more lands: not enough spells to win"; }
    else { verdict = "KEEP"; why = `at ${keepSize} cards you keep anything with at least one land and a plan; going lower rarely helps`; }
  } else if (lands.length === 0) {
    verdict = "MULLIGAN"; binding = true; why = sources ? "no land in hand; a land fetcher does not replace a land you can play on turn 1" : "no land: you cannot cast anything";
  } else if (lands.length === 1) {
    // A second source (fetcher / landcycler) or a dork with one-drops is a plan; two cantrips only on the draw and with nothing expensive.
    const extraPlan = sources >= 2 || (dorks.length >= 1 && oneDrops.length >= 2) || (cantrips.length >= 2 && oneDrops.length >= 2 && expensive.length === 0 && onPlay === false);
    if (extraPlan && minCmc <= 1) { verdict = "KEEP (borderline)"; why = `one land but ${sources >= 2 ? "a second mana source" : dorks.length ? "a mana creature and cheap plays" : "two cantrips on the draw"} to dig; a 7-card one-lander is usually a mulligan, this one has a plan`; }
    else { verdict = "MULLIGAN"; binding = keepSize === 7; why = `one land with ${deckLands} lands in the deck: a ${pct(pAtLeast(1, drawsBy(2)))} chance of the 2nd land on time and ${expensive.length ? `${expensive.length} expensive spell${expensive.length > 1 ? "s" : ""}` : "too few cheap plays"}; a 6-card hand with two lands beats this`; }
  } else if (lands.length >= 5) {
    verdict = keepSize === 7 ? "MULLIGAN" : "KEEP (borderline)"; binding = keepSize === 7; why = `${lands.length} lands and ${spells.length} spells: flood; ${keepSize === 7 ? "six cards with real plays beat this" : "at six, keep and bottom a land"}`;
  } else if (lands.length === 2 && minCmc >= 3) {
    verdict = "KEEP (borderline)"; why = `two lands but nothing to cast before turn 3; fine on the draw${onPlay === false ? "" : ", risky on the play"}; a one-mana play would make it a clear keep`;
  } else {
    verdict = "KEEP"; why = `${lands.length} lands and ${cheap.length} cheap play${cheap.length === 1 ? "" : "s"}: a normal hand`;
  }
  lines.push(`- Heuristic verdict: **${verdict}** — ${why}.${binding ? " Clear case: with mulliganPolicy strict the harness answers it." : ""}`);
  verdicts.set(req.requestId, { verdict, why, action: verdict.startsWith("MULLIGAN") ? "mulligan" : "keep", binding });
  lines.push(`Rule of thumb in Pauper: on 7 keep 2-4 lands with something to cast by turn 2; on 6 keep 2-4 lands; on 5 keep almost anything with a land. One-land hands need a second source or two one-mana cantrips, and are kept more readily on the draw.`);
  return lines.join("\n");
}

/** P(exactly k successes in n draws) from a population of N with K successes. */
function hyper(k: number, n: number, K: number, N: number): number {
  if (k > n || k > K || n - k > N - K) return 0;
  return Math.exp(lnC(K, k) + lnC(N - K, n - k) - lnC(N, n));
}
function lnC(n: number, k: number): number { if (k < 0 || k > n) return -Infinity; return lnFact(n) - lnFact(k) - lnFact(n - k); }
const lnFactCache: number[] = [0];
function lnFact(n: number): number { for (let i = lnFactCache.length; i <= n; i++) lnFactCache[i] = lnFactCache[i - 1] + Math.log(i); return lnFactCache[n]; }

function isLand(c: HandCard, db: CardDb): boolean {
  if (c.pt) return false;
  if (isBasicLand(c.name)) return true;
  const d = getCard(db, c.name);
  if (d) return /\bLand\b/.test(d.types ?? "");
  return /\{T\}: Add/.test(c.text ?? "");
}
