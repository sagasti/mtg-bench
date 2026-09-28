import type { Rng } from "../util/rng.ts";

/** Circle-method round robin: n-1 rounds for even n, every pair meets exactly once. */
export function roundRobin(n: number): [number, number][][] {
  if (n % 2) throw new Error("round robin needs an even number of seats");
  const idx = Array.from({ length: n }, (_, i) => i);
  const rounds: [number, number][][] = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs: [number, number][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = idx[i], b = idx[n - 1 - i];
      // alternate who is listed first so neither seat is always "player 0"
      pairs.push(r % 2 ? [b, a] : [a, b]);
    }
    rounds.push(pairs);
    idx.splice(1, 0, idx.pop()!); // rotate all but the first
  }
  return rounds;
}

/**
 * Swiss pairing for one round: sort by match points, pair top-down avoiding
 * rematches (backtracking). Round 1 pairs across the table like a real draft.
 */
export function swissRound(n: number, points: number[], played: Set<string>, round: number, rng: Rng): [number, number][] {
  if (round === 0) return Array.from({ length: n / 2 }, (_, i) => [i, i + n / 2] as [number, number]);
  const order = rng.shuffle(Array.from({ length: n }, (_, i) => i)).sort((a, b) => points[b] - points[a]);
  const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const out: [number, number][] = [];
  const used = new Set<number>();
  const solve = (): boolean => {
    const a = order.find((x) => !used.has(x));
    if (a === undefined) return true;
    used.add(a);
    for (const b of order) {
      if (used.has(b) || played.has(key(a, b))) continue;
      used.add(b); out.push([a, b]);
      if (solve()) return true;
      out.pop(); used.delete(b);
    }
    used.delete(a);
    return false;
  };
  if (!solve()) throw new Error("no Swiss pairing without rematches");
  return out;
}
