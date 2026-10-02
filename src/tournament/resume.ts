/**
 * Re-running an event from a saved run dir. A source run supplies, per pod, the seating (events.jsonl `pod_start`)
 * and either the finished decks (`--decks-from`: pod<N>/decks/<seat>.json) or the drafted pools rebuilt from the
 * draft log (`--pools-from`: draft.jsonl `pick` rows). LLM seats also get back their study brief (prep/<seat>.md)
 * and pod-scope notes: the post-draft notes (pod<N>/notes/<seat>.draft.md) when deckbuild is re-run, the
 * post-deckbuild notes (pod<N>/notes/<seat>.md) when only the matches are. The source run is only ever read.
 */
import fs from "node:fs";
import path from "node:path";
import type { Seat } from "../agents/agent.ts";
import type { CardDb } from "../cards/db.ts";
import type { BenchConfig } from "../config.ts";
import { type Deck, deckProblems } from "../deckbuild/deckbuild.ts";
import type { CardInstance } from "../draft/draft.ts";
import { info, readJsonl } from "../util/log.ts";

/** `allowChanges` accepts a source played under different seats' models, cube or draft settings (--allow-seat-changes). */
export interface RunSource { runDir: string; mode: "decks" | "pools"; allowChanges?: boolean }

export const podScope = (pod: number) => `pod:${pod}`;
type NotesStage = "draft" | "deckbuild";
const notesFile = (runDir: string, pod: number, seatId: string, stage: NotesStage) =>
  path.join(runDir, `pod${pod}`, "notes", stage === "draft" ? `${seatId}.draft.md` : `${seatId}.md`);
const briefFile = (runDir: string, seatId: string) => path.join(runDir, "prep", `${seatId}.md`);

/** Write each LLM seat's pod-scope scratchpad (bots keep none), once after the draft and once after deckbuild. */
export function saveNotes(runDir: string, pod: number, seats: Seat[], stage: NotesStage) {
  for (const s of seats) {
    const notes = s.getNotes(podScope(pod));
    if (!s.isLlm || notes === undefined) continue;
    fs.mkdirSync(path.dirname(notesFile(runDir, pod, s.id, stage)), { recursive: true });
    fs.writeFileSync(notesFile(runDir, pod, s.id, stage), notes);
  }
}

export class SourceRun {
  readonly seating: string[][] = []; // by pod
  readonly draftSeeds: number[] = []; // by pod: the seed whose packs the source played
  /** The source's seats as it played them, recorded in the derived run's run_start. */
  readonly seats: { id: string; provider: string; model?: string }[];
  private picks: { pod: number; seat: string; pack: number; pick: number; card: string }[];

  constructor(readonly src: RunSource, cfg: BenchConfig) {
    const { runDir } = src;
    if (!fs.existsSync(path.join(runDir, "events.jsonl"))) throw new Error(`${runDir}: not a run dir (no events.jsonl)`);
    if (!fs.existsSync(path.join(runDir, "config.json"))) throw new Error(`${runDir}: no config.json`);
    const corrupt = (why: string) => new Error(`${runDir}: ${why}; the run dir is corrupt (a re-used --run-id?) and can't be a source`);
    const events = readJsonl(path.join(runDir, "events.jsonl"));
    const starts = events.filter((e) => e.type === "run_start").length;
    if (starts !== 1) throw corrupt(`${starts} run_start events`);
    for (const e of events) if (e.type === "pod_start") {
      if (this.seating[e.pod]) throw corrupt(`pod ${e.pod} started twice`);
      this.seating[e.pod] = e.seating;
    }
    const want = cfg.seats.map((s) => s.id).sort().join(", ");
    for (const [pod, seating] of this.seating.entries()) {
      const have = [...seating].sort().join(", ");
      if (have !== want) throw new Error(`seat ids differ from the source run (pod ${pod}):\n  config: ${want}\n  source: ${have}`);
    }
    if (cfg.event.pods > this.seating.length) throw new Error(`config asks for ${cfg.event.pods} pod(s) but ${runDir} played ${this.seating.length}`);

    // The draft, decks, briefs and notes were made by the source's seats under its event settings: they must match.
    const srcCfg: BenchConfig = JSON.parse(fs.readFileSync(path.join(runDir, "config.json"), "utf8"));
    this.seats = srcCfg.seats.map((s) => ({ id: s.id, provider: s.provider, model: s.model }));
    for (const e of events) if (e.type === "pod_start") this.draftSeeds[e.pod] = e.draftSeed ?? srcCfg.event.seed;
    const changes: string[] = [];
    for (const k of ["cube", "packs", "packSize", "cubeStudy"] as const) {
      if (srcCfg.event[k] !== cfg.event[k]) changes.push(`event.${k}: source ${JSON.stringify(srcCfg.event[k])}, config ${JSON.stringify(cfg.event[k])}`);
    }
    const who = (s?: { provider: string; model?: string }) => (s ? `${s.provider}${s.model ? `:${s.model}` : ""}` : "none");
    for (const s of cfg.seats) {
      const was = srcCfg.seats.find((x) => x.id === s.id);
      if (who(was) !== who(s)) changes.push(`seat ${s.id}: source ${who(was)}, config ${who(s)}`);
    }
    if (changes.length && !src.allowChanges) {
      throw new Error(`the config differs from the source run's:\n  ${changes.join("\n  ")}\npass --allow-seat-changes to re-run it anyway`);
    }
    for (const c of changes) info(`source differs (allowed): ${c}`);

    this.picks = readJsonl(path.join(runDir, "draft.jsonl")).filter((r) => r.type === "pick");
    if (src.mode === "pools") {
      // Every seat must have a full, unique set of picks: a draft that crashed leaves short pools.
      const full = srcCfg.event.packs * srcCfg.event.packSize;
      for (let pod = 0; pod < cfg.event.pods; pod++) for (const seat of this.seating[pod]) {
        const rows = this.picks.filter((r) => r.pod === pod && r.seat === seat);
        if (!rows.length) throw new Error(`no draft picks for ${seat} in pod ${pod} in ${path.join(runDir, "draft.jsonl")} (a derived run doesn't draft)`);
        if (new Set(rows.map((r) => `${r.pack}-${r.pick}`)).size !== rows.length) throw corrupt(`duplicate draft picks for ${seat} in pod ${pod}`);
        if (rows.length !== full) {
          throw new Error(`${path.join(runDir, "draft.jsonl")}: ${seat} has ${rows.length} picks in pod ${pod}, not ${full} (${srcCfg.event.packs} × ${srcCfg.event.packSize}); the source's draft didn't finish`);
        }
      }
    }
  }

  /** The seat's saved deck, checked against the deck rules, the card DB and (when the source drafted) its pool. */
  deck(pod: number, seatId: string, db: CardDb, minDeckSize: number): Deck {
    const f = path.join(this.src.runDir, `pod${pod}`, "decks", `${seatId}.json`);
    if (!fs.existsSync(f)) throw new Error(`no saved deck for ${seatId} in pod ${pod}: ${f}`);
    const deck: Deck = JSON.parse(fs.readFileSync(f, "utf8"));
    const pool = this.picks.filter((r) => r.pod === pod && r.seat === seatId).map((r) => r.card);
    const problems = deckProblems(deck, db, minDeckSize, pool.length ? pool : undefined);
    if (deck.seatId !== seatId) problems.push(`it belongs to seat ${deck.seatId}`);
    if (problems.length) throw new Error(`saved deck ${f} is unusable:\n  ${problems.join("\n  ")}`);
    return deck;
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

  /**
   * Give LLM seats their study brief and (per pod) the notes they had at the point the re-run starts from: after the
   * draft in pools mode (deckbuild is re-run), after deckbuild in decks mode. Both are copied into the new run dir.
   */
  restoreContext(seats: Seat[], runDir: string, pod: number) {
    const stage: NotesStage = this.src.mode === "pools" ? "draft" : "deckbuild";
    for (const s of seats) {
      if (!s.isLlm) continue;
      const brief = briefFile(this.src.runDir, s.id);
      if (fs.existsSync(brief)) {
        s.brief = fs.readFileSync(brief, "utf8");
        fs.mkdirSync(path.dirname(briefFile(runDir, s.id)), { recursive: true });
        fs.copyFileSync(brief, briefFile(runDir, s.id));
      }
      const notes = notesFile(this.src.runDir, pod, s.id, stage);
      if (fs.existsSync(notes)) s.setNotes(podScope(pod), fs.readFileSync(notes, "utf8"));
      else if (stage === "draft" && fs.existsSync(notesFile(this.src.runDir, pod, s.id, "deckbuild"))) {
        info(`${s.id}: the source predates post-draft notes; deckbuild starts without notes rather than with the source's post-deckbuild ones`);
      }
    }
    saveNotes(runDir, pod, seats, stage);
  }
}
