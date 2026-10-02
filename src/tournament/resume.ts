/**
 * Re-running an event from a saved run dir. A source run supplies, per pod, the seating (events.jsonl `pod_start`)
 * and either the finished decks (`--decks-from`: pod<N>/decks/<seat>.json) or the drafted pools rebuilt from the
 * draft log (`--pools-from`: draft.jsonl `pick` rows). LLM seats also get back their study brief (prep/<seat>.md)
 * and pod-scope notes (pod<N>/notes/<seat>.md). The source run is only ever read.
 */
import fs from "node:fs";
import path from "node:path";
import type { Seat } from "../agents/agent.ts";
import type { BenchConfig } from "../config.ts";
import type { Deck } from "../deckbuild/deckbuild.ts";
import type { CardInstance } from "../draft/draft.ts";
import { readJsonl } from "../util/log.ts";

export interface RunSource { runDir: string; mode: "decks" | "pools" }

export const podScope = (pod: number) => `pod:${pod}`;
const notesFile = (runDir: string, pod: number, seatId: string) => path.join(runDir, `pod${pod}`, "notes", `${seatId}.md`);
const briefFile = (runDir: string, seatId: string) => path.join(runDir, "prep", `${seatId}.md`);

/** Write each LLM seat's pod-scope scratchpad (bots keep none). Called after the draft and again after deckbuild. */
export function saveNotes(runDir: string, pod: number, seats: Seat[]) {
  for (const s of seats) {
    const notes = s.getNotes(podScope(pod));
    if (!s.isLlm || notes === undefined) continue;
    fs.mkdirSync(path.dirname(notesFile(runDir, pod, s.id)), { recursive: true });
    fs.writeFileSync(notesFile(runDir, pod, s.id), notes);
  }
}

export class SourceRun {
  readonly seating: string[][] = []; // by pod
  private picks: { pod: number; seat: string; pack: number; pick: number; card: string }[];

  constructor(readonly src: RunSource, cfg: BenchConfig) {
    const { runDir } = src;
    if (!fs.existsSync(path.join(runDir, "events.jsonl"))) throw new Error(`${runDir}: not a run dir (no events.jsonl)`);
    for (const e of readJsonl(path.join(runDir, "events.jsonl"))) if (e.type === "pod_start") this.seating[e.pod] = e.seating;
    const want = cfg.seats.map((s) => s.id).sort().join(", ");
    for (const [pod, seating] of this.seating.entries()) {
      const have = [...seating].sort().join(", ");
      if (have !== want) throw new Error(`seat ids differ from the source run (pod ${pod}):\n  config: ${want}\n  source: ${have}`);
    }
    if (cfg.event.pods > this.seating.length) throw new Error(`config asks for ${cfg.event.pods} pod(s) but ${runDir} played ${this.seating.length}`);
    this.picks = src.mode === "pools" ? readJsonl(path.join(runDir, "draft.jsonl")).filter((r) => r.type === "pick") : [];
  }

  deck(pod: number, seatId: string): Deck {
    const f = path.join(this.src.runDir, `pod${pod}`, "decks", `${seatId}.json`);
    if (!fs.existsSync(f)) throw new Error(`no saved deck for ${seatId} in pod ${pod}: ${f}`);
    return JSON.parse(fs.readFileSync(f, "utf8"));
  }

  /**
   * The seat's picks in draft order. The draft log keeps card names, not instance ids, so ids are the pick index
   * (`c0`…); they only need to be unique within the pool, which is all deckbuilding uses them for.
   */
  pool(pod: number, seatId: string): CardInstance[] {
    const rows = this.picks.filter((r) => r.pod === pod && r.seat === seatId).sort((a, b) => a.pack - b.pack || a.pick - b.pick);
    if (!rows.length) throw new Error(`no draft picks for ${seatId} in pod ${pod} in ${path.join(this.src.runDir, "draft.jsonl")}`);
    return rows.map((r, i) => ({ iid: `c${i}`, name: r.card }));
  }

  /** Give LLM seats their study brief and (per pod) their notes back, and copy both into the new run dir. */
  restoreContext(seats: Seat[], runDir: string, pod: number) {
    for (const s of seats) {
      if (!s.isLlm) continue;
      const brief = briefFile(this.src.runDir, s.id);
      if (fs.existsSync(brief)) {
        s.brief = fs.readFileSync(brief, "utf8");
        fs.mkdirSync(path.dirname(briefFile(runDir, s.id)), { recursive: true });
        fs.copyFileSync(brief, briefFile(runDir, s.id));
      }
      const notes = notesFile(this.src.runDir, pod, s.id);
      if (fs.existsSync(notes)) s.setNotes(podScope(pod), fs.readFileSync(notes, "utf8"));
    }
    saveNotes(runDir, pod, seats);
  }
}
