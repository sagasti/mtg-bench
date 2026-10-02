/**
 * Bradley-Terry ratings fitted over all results at once (order-independent,
 * unlike sequential Elo), reported on the Elo scale with bootstrap CIs.
 * Bootstrap resamples whole matches (games in a match are correlated); with several pods it resamples pods first,
 * then matches within each drawn pod, since a seat keeps one deck for every game of a pod.
 */
import { Rng } from "../util/rng.ts";

// scoreA: 1 win, 0 loss, 0.5 draw. cluster: the match; pod: the pod it was played in (run + pod index).
export interface Outcome { a: string; b: string; scoreA: number; weight?: number; cluster: string; pod?: string }

export interface RatingRow { id: string; rating: number; lo: number; hi: number; games: number; score: number }

export function fitBT(outcomes: Outcome[], players: string[], iters = 500, prior = 1): Map<string, number> {
  // MM algorithm (Hunter 2004) with a weak prior: each player gets `prior` virtual
  // draws against a virtual average opponent, which keeps undefeated players finite.
  const idx = new Map(players.map((p, i) => [p, i]));
  const n = players.length;
  let g = new Array(n).fill(1);
  const wins = new Array(n).fill(0);
  const pairs: { i: number; j: number; w: number }[] = [];
  for (const o of outcomes) {
    const i = idx.get(o.a)!, j = idx.get(o.b)!;
    const w = o.weight ?? 1;
    wins[i] += o.scoreA * w; wins[j] += (1 - o.scoreA) * w;
    pairs.push({ i, j, w });
  }
  for (let it = 0; it < iters; it++) {
    const denom = new Array(n).fill(0);
    for (const { i, j, w } of pairs) { const s = w / (g[i] + g[j]); denom[i] += s; denom[j] += s; }
    const next = g.map((gi, i) => (wins[i] + prior * 0.5) / (denom[i] + prior / (gi + 1)));
    // normalise geometric mean to 1
    const gm = Math.exp(next.reduce((s, x) => s + Math.log(x), 0) / n);
    const upd = next.map((x) => x / gm);
    const delta = Math.max(...upd.map((x, i) => Math.abs(Math.log(x / g[i]))));
    g = upd;
    if (delta < 1e-9) break;
  }
  return new Map(players.map((p, i) => [p, 1500 + (400 * Math.log10(g[i]))]));
}

export function rate(outcomes: Outcome[], opts: { bootstrap?: number; seed?: number; anchor?: { id: string; rating: number } } = {}): RatingRow[] {
  const players = [...new Set(outcomes.flatMap((o) => [o.a, o.b]))].sort();
  if (!players.length) return [];
  const shift = (m: Map<string, number>) => {
    if (opts.anchor && m.has(opts.anchor.id)) {
      const d = opts.anchor.rating - m.get(opts.anchor.id)!;
      for (const [k, v] of m) m.set(k, v + d);
    }
    return m;
  };
  const point = shift(fitBT(outcomes, players));
  const B = opts.bootstrap ?? 500;
  const clusters = new Map<string, Outcome[]>();
  for (const o of outcomes) clusters.set(o.cluster, [...(clusters.get(o.cluster) ?? []), o]);
  const byPod = new Map<string, string[]>();
  for (const [key, os] of clusters) byPod.set(os[0].pod ?? "", [...(byPod.get(os[0].pod ?? "") ?? []), key]);
  const pods = [...byPod.values()];
  const rng = new Rng(opts.seed ?? 1);
  const samples = new Map(players.map((p) => [p, [] as number[]]));
  // One pod: resample its matches. Several: draw pods with replacement, then matches within each drawn pod.
  const drawMatches = (keys: string[], res: Outcome[]) => { for (let k = 0; k < keys.length; k++) res.push(...clusters.get(keys[rng.int(keys.length)])!); };
  for (let b = 0; b < B; b++) {
    const res: Outcome[] = [];
    if (pods.length > 1) for (let p = 0; p < pods.length; p++) drawMatches(pods[rng.int(pods.length)], res);
    else drawMatches(pods[0], res);
    const present = players.filter((p) => res.some((o) => o.a === p || o.b === p));
    const m = shift(fitBT(res, present, 200));
    for (const p of present) samples.get(p)!.push(m.get(p)!);
  }
  const q = (a: number[], x: number) => { if (!a.length) return NaN; const s = [...a].sort((u, v) => u - v); return s[Math.min(s.length - 1, Math.max(0, Math.floor(x * s.length)))]; };
  return players.map((p) => {
    const games = outcomes.filter((o) => o.a === p || o.b === p);
    const score = games.reduce((s, o) => s + (o.a === p ? o.scoreA : 1 - o.scoreA), 0);
    return { id: p, rating: point.get(p)!, lo: q(samples.get(p)!, 0.025), hi: q(samples.get(p)!, 0.975), games: games.length, score };
  }).sort((x, y) => y.rating - x.rating);
}

/**
 * Each pod fitted on its own, and each seat's SD across pods: how far a rating moves between pods by chance (for
 * identical bots, the benchmark's noise floor). Pods in first-seen order; a seat missing from a pod has no rating there.
 */
export function podRatings(outcomes: Outcome[]): { pods: string[]; ratings: Map<string, (number | undefined)[]>; sd: Map<string, number> } {
  const pods = [...new Set(outcomes.map((o) => o.pod ?? ""))];
  const ratings = new Map<string, (number | undefined)[]>();
  pods.forEach((pod, i) => {
    const os = outcomes.filter((o) => (o.pod ?? "") === pod);
    for (const [p, r] of fitBT(os, [...new Set(os.flatMap((o) => [o.a, o.b]))].sort())) {
      if (!ratings.has(p)) ratings.set(p, new Array(pods.length).fill(undefined));
      ratings.get(p)![i] = r;
    }
  });
  const sd = new Map<string, number>();
  for (const [p, rs] of ratings) {
    const xs = rs.filter((r): r is number => r !== undefined);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    if (xs.length > 1) sd.set(p, Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1)));
  }
  return { pods, ratings, sd };
}
