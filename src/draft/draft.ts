/**
 * 8-seat booster draft: `packs` rounds of `packSize` cards, pass left / right / left.
 * All seats pick simultaneously each pick (like a real table), so wall time ≈ slowest seat.
 */
import type { Seat } from "../agents/agent.ts";
import { type CardDb, getCard, prettyCost } from "../cards/db.ts";
import type { EventConfig } from "../config.ts";
import type { Jsonl } from "../util/log.ts";
import type { Rng } from "../util/rng.ts";
import type { DecisionRequest } from "../types.ts";

export interface CardInstance { iid: string; name: string }
export interface DraftResult { pools: CardInstance[][]; picks: { seat: number; pack: number; pick: number; card: string; packSize: number }[] }

export function makePacks(cube: string[], nSeats: number, packs: number, packSize: number, rng: Rng): CardInstance[][][] {
  const need = nSeats * packs * packSize;
  if (cube.length < need) throw new Error(`cube has ${cube.length} cards; ${need} needed for ${nSeats}x${packs}x${packSize}`);
  const shuffled = rng.shuffle(cube.map((name, i) => ({ iid: `c${i}`, name })));
  const out: CardInstance[][][] = [];
  let k = 0;
  for (let r = 0; r < packs; r++) {
    const round: CardInstance[][] = [];
    for (let s = 0; s < nSeats; s++) round.push(shuffled.slice(k, (k += packSize)));
    out.push(round);
  }
  return out;
}

function optionLabel(db: CardDb, name: string) {
  const c = getCard(db, name);
  if (!c) return name;
  return `${c.name} ${prettyCost(c.manaCost)} — ${c.types}${c.pt ? ` ${c.pt}` : ""}`.replace(/\s+/g, " ").trim();
}

export async function runDraft(opts: {
  seats: Seat[]; cube: string[]; event: EventConfig; db: CardDb; rng: Rng; pod: number; log: Jsonl;
}): Promise<DraftResult> {
  const { seats, event, db, rng, pod, log } = opts;
  const n = seats.length;
  const allPacks = makePacks(opts.cube, n, event.packs, event.packSize, rng);
  const pools: CardInstance[][] = seats.map(() => []);
  const picks: DraftResult["picks"] = [];
  // Cards each seat has already passed in the current pack round: public to that seat, and the ones that may wheel.
  let passed: string[][] = seats.map(() => []);

  for (let r = 0; r < event.packs; r++) {
    let packs = allPacks[r]; // packs[s] is the pack currently in front of seat s
    const dir = r % 2 === 0 ? 1 : -1; // +1 = pass left (to seat s+1)
    passed = seats.map(() => []);
    for (let p = 0; packs.some((x) => x.length > 0); p++) {
      const chosen = await Promise.all(seats.map(async (seat, s) => {
        const pack = packs[s];
        const req: DecisionRequest = {
          requestId: `p${pod}-draft-${seat.id}-${r + 1}-${p + 1}`,
          phase: "draft",
          kind: "draft_pick",
          prompt: `Pack ${r + 1}, pick ${p + 1}. Take one card; the rest are passed to your ${dir === 1 ? "left" : "right"}.`,
          state: {
            pack: r + 1, pick: p + 1, packsTotal: event.packs, cardsInPack: pack.length,
            passing: dir === 1 ? "left" : "right",
            picks: pools[s].map((c) => c.name),
            passedThisPack: passed[s],
          },
          options: pack.map((c) => ({ id: c.iid, label: optionLabel(db, c.name), card: c.name })),
          min: 1, max: 1,
        };
        const res = await seat.decide(req, { pod });
        const iid = res.choice[0];
        return pack.find((c) => c.iid === iid) ?? pack[0];
      }));
      packs = packs.map((pack, s) => {
        const card = chosen[s];
        pools[s].push(card);
        passed[s].push(...pack.filter((c) => c.iid !== card.iid).map((c) => c.name));
        picks.push({ seat: s, pack: r + 1, pick: p + 1, card: card.name, packSize: pack.length });
        log.write({ type: "pick", pod, seat: seats[s].id, pack: r + 1, pick: p + 1, card: card.name, pack_contents: pack.map((c) => c.name) });
        return pack.filter((c) => c.iid !== card.iid);
      });
      // pass
      const next: CardInstance[][] = new Array(n);
      for (let s = 0; s < n; s++) next[(s + dir + n) % n] = packs[s];
      packs = next;
    }
  }
  return { pools, picks };
}
