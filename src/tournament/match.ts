/** Head-to-head: two seats play N matches with fixed decks. No study, draft or deckbuilding, so gameplay can be iterated on alone. */
import fs from "node:fs";
import path from "node:path";
import { anchorVersions } from "../agents/bots.ts";
import { makeSeat } from "../agents/factory.ts";
import { promptFile } from "../agents/render.ts";
import type { Seat } from "../agents/agent.ts";
import { Recorder } from "../analytics/recorder.ts";
import { writeReport } from "../analytics/report.ts";
import { loadDb } from "../cards/db.ts";
import { loadCube, loadRankings, parseCardList } from "../cards/cube.ts";
import type { BenchConfig } from "../config.ts";
import { type Deck, deckProblems, saveDeck } from "../deckbuild/deckbuild.ts";
import { type GameEngine, type MatchResult, replayable } from "../engine/types.ts";
import { KnowledgeBase } from "../knowledge/tools.ts";
import { Jsonl, info } from "../util/log.ts";
import { collectProvenance } from "../util/provenance.ts";
import { Rng } from "../util/rng.ts";
import { freshRunDir, pool } from "./run.ts";

/** A saved deck: the harness's .json (from runs/<id>/pod0/decks) or any Forge .dck / plain card list. */
export function loadDeckFile(file: string, seatId: string): Deck {
  const text = fs.readFileSync(file, "utf8");
  if (file.endsWith(".json")) return { ...(JSON.parse(text) as Deck), seatId };
  return { seatId, main: parseCardList(text).cards, sideboard: [], basics: {} };
}

export interface HeadToHeadOpts {
  seats: [string, string];
  deckFiles: [string, string];
  matches: number;
  /** Matches played at once (each best-of-N stays sequential). Defaults to event.parallelMatches. */
  parallel?: number;
  runId?: string;
  /** Replace an existing run dir of the same id. */
  force?: boolean;
}

export async function runHeadToHead(cfg: BenchConfig, engine: GameEngine, opts: HeadToHeadOpts) {
  const ev = cfg.event;
  const runId = opts.runId ?? `${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}_match_${opts.seats.join("-vs-")}`;
  const db = loadDb();
  // Check both decks before anything is written: Forge would silently drop cards it doesn't know.
  const decks = opts.deckFiles.map((f, i) => loadDeckFile(f, opts.seats[i])) as [Deck, Deck];
  for (const [i, d] of decks.entries()) {
    const problems = deckProblems(d, db, ev.minDeckSize);
    if (problems.length) throw new Error(`deck ${opts.deckFiles[i]} is unusable:\n  ${problems.join("\n  ")}`);
  }
  const runDir = freshRunDir(cfg.outputDir, runId, opts.force);
  const provenance = collectProvenance(cfg, engine.name);
  fs.writeFileSync(path.join(runDir, "config.json"), JSON.stringify({ ...cfg, headToHead: opts, provenance }, null, 2));
  fs.cpSync(promptFile(ev.promptVersion, ""), path.join(runDir, "prompts"), { recursive: true });

  const cube = loadCube(db, ev.cube, cfg.forgeRes);
  const kb = new KnowledgeBase(db, cube.cards);
  const recorder = new Recorder(runDir, runId);
  const rng = new Rng(ev.seed);
  const rankings = loadRankings(cfg.forgeRes);
  const seats = opts.seats.map((id) => {
    const sc = cfg.seats.find((s) => s.id === id);
    if (!sc) throw new Error(`no seat "${id}" in the config (seats: ${cfg.seats.map((s) => s.id).join(", ")})`);
    return makeSeat(sc, { cfg, db, kb, rankings, recorder, rng, cubeName: cube.name });
  }) as [Seat, Seat];
  if (seats[0].id === seats[1].id) throw new Error("the two seats must be different seat ids (copy a seat under a new id for a mirror)");

  const deckDir = path.join(runDir, "decks");
  const dckFiles = decks.map((d) => saveDeck(deckDir, d)) as [string, string];
  const matchLog = new Jsonl(path.join(runDir, "matches.jsonl"));
  info(`match ${runId}: ${seats[0].id} (${path.basename(opts.deckFiles[0])}) vs ${seats[1].id} (${path.basename(opts.deckFiles[1])}), ${opts.matches} × bo${ev.gamesPerMatch} (${Math.max(1, opts.parallel ?? ev.parallelMatches)} at a time), engine=${engine.name}`);
  recorder.event("run_start", { headToHead: true, seats: opts.seats, decks: opts.deckFiles, provenance, cube: cube.name,
    anchors: anchorVersions(seats.map((s) => s.config), engine.name, cfg.engine.controller) });

  const parallel = Math.max(1, opts.parallel ?? ev.parallelMatches);
  const seeds = Array.from({ length: opts.matches }, (_, m) => rng.fork(`h2h-${m + 1}`).int(2 ** 31));
  const playOne = async (m: number, matchId: string, replayOf?: string) => {
    let res: MatchResult;
    try {
      res = await engine.playMatch({
        matchId, pod: 0, round: m + 1, seats, decks, deckFiles: dckFiles, gamesPerMatch: ev.gamesPerMatch,
        seed: seeds[m], maxGameTurns: ev.maxGameTurns, runDir,
        priorityStops: ev.priorityStops, manaPayment: ev.manaPayment, maxRetries: ev.maxRetries,
      });
    } catch (e: any) {
      res = { matchId, pod: 0, round: m + 1, seats: [seats[0].id, seats[1].id], games: [], winner: null, error: String(e?.message ?? e), errorKind: "harness" };
    }
    if (replayOf) res.replayOf = replayOf;
    matchLog.write(res);
    const score = res.games.map((g) => (g.winner === 0 ? "W" : g.winner === 1 ? "L" : "D")).join("");
    const outcome = res.error ? (replayOf || !replayable(res) ? "censored" : "errored, replaying at the end") : res.winner === 0 ? seats[0].id : res.winner === 1 ? seats[1].id : "draw";
    info(`  match ${m + 1}${replayOf ? " (replay)" : ""}: ${outcome} (${score})${res.error ? ` ERROR ${res.error}` : ""}`);
    return res;
  };
  const first = await pool(Array.from({ length: opts.matches }, (_, m) => m), parallel, (m) => playOne(m, `h2h-${m + 1}-${seats[0].id}-vs-${seats[1].id}`));
  // As in an event (tournament/run.ts): a match that errored for a reason other than a harness bug is replayed once.
  const replays = await pool(first.filter(replayable), parallel, (r) => playOne(r.round - 1, `${r.matchId}-replay`, r.matchId));
  const results = first.map((r) => replays.find((x) => x.replayOf === r.matchId) ?? r);
  recorder.event("run_end", { matches: results.length });
  matchLog.close(); recorder.close();
  await engine.close?.();
  writeReport(runDir, cfg);
  return { runId, runDir, results };
}
