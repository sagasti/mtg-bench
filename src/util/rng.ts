/** Small seeded PRNG so drafts, pairings and mock games are reproducible. */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = (seed >>> 0) || 0x9e3779b9; }
  next(): number { // mulberry32
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number { return Math.floor(this.next() * n); }
  pick<T>(a: readonly T[]): T { return a[this.int(a.length)]; }
  shuffle<T>(a: T[]): T[] {
    for (let i = a.length - 1; i > 0; i--) { const j = this.int(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  /** Derive an independent child stream (e.g. per pod / per game). */
  fork(label: string | number): Rng {
    let h = this.s ^ 0x85ebca6b;
    for (const ch of String(label)) h = Math.imul(h ^ ch.charCodeAt(0), 0x27d4eb2d);
    return new Rng(h >>> 0);
  }
}
