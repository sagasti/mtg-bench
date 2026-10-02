/**
 * Runs an event: cube study → (per pod) draft → deckbuild → matches → ratings + analytics.
 * With a source run (see resume.ts) the early stages are replaced by what that run saved.
 */
import fs from "node:fs";
import path from "node:path";
import { anchorVersions } from "../agents/bots.ts";
import { makeSeat } from "../agents/factory.ts";
import { promptFile } from "../agents/render.ts";
import type { Seat } from "../agents/agent.ts";
import { Recorder } from "../analytics/recorder.ts";
import { writeReport } from "../analytics/report.ts";
import { loadDb } from "../cards/db.ts";
import { loadCube, loadRankings } from "../cards/cube.ts";
import type { BenchConfig } from "../config.ts";
import { buildDeck, type Deck, saveDeck } from "../deckbuild/deckbuild.ts";
import { type CardInstance, runDraft } from "../draft/draft.ts";
import { type GameEngine, type MatchResult, replayable } from "../engine/types.ts";
import { KnowledgeBase } from "../knowledge/tools.ts";
import { rate } from "../rating/bt.ts";
import { outcomesFromMatches } from "../rating/outcomes.ts";
import { info, Jsonl } from "../util/log.ts";
import { collectProvenance } from "../util/provenance.ts";
import { Rng } from "../util/rng.ts";
import { type RunSource, saveNotes, SourceRun } from "./resume.ts";
import { roundRobin, swissRound } from "./schedule.ts";

export async function pool<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * Create a run dir. Its logs are append-only, so an existing dir is refused rather than mixed into; `force` wipes it first.
 */
export function freshRunDir(outputDir: string, runId: string, force = false): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(runId) || /^\.+$/.test(runId)) throw new Error(`invalid run id "${runId}": use letters, digits, _ . -`);
  const runDir = path.join(outputDir, runId);
  if (fs.existsSync(runDir)) {
    if (!force) throw new Error(`${runDir} already exists; choose another --run-id, or pass --force to delete it and start over`);
    info(`--force: deleting ${runDir}`);
    fs.rmSync(runDir, { recursive: true, force: true });
  }
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

export async function runEvent(cfg: BenchConfig, engine: GameEngine, opts: { runId?: string; source?: RunSource; force?: boolean } = {}) {
  const ev = cfg.event;
  const runId = opts.runId ?? `${new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19)}_${ev.name.replace(/[^A-Za-z0-9_-]+/g, "_")}`;
  const source = opts.source ? new SourceRun(opts.source, cfg) : null;
  if (source && path.resolve(source.src.runDir) === path.resolve(cfg.outputDir, runId)) throw new Error("the new run must not be its own source");
  const db = loadDb();
  // Check every saved deck before anything is written.
  if (source?.src.mode === "decks") for (let pod = 0; pod < ev.pods; pod++) for (const id of source.seating[pod]) source.deck(pod, id, db, ev.minDeckSize);
  const runDir = freshRunDir(cfg.outputDir, runId, opts.force);
  // Snapshot config (keys live in env vars, so this is safe to keep) + prompts used; a derived run also records its source.
  const provenance = collectProvenance(cfg, engine.name);
  fs.writeFileSync(path.join(runDir, "config.json"), JSON.stringify({ ...cfg, source: opts.source, provenance }, null, 2));
  fs.cpSync(promptFile(ev.promptVersion, ""), path.join(runDir, "prompts"), { recursive: true });

  const cube = loadCube(db, ev.cube, cfg.forgeRes);
  if (cube.missing.length) info(`cube: ${cube.missing.length} card(s) not in DB and dropped: ${cube.missing.slice(0, 5).join(", ")}${cube.missing.length > 5 ? "…" : ""}`);
  const rankings = loadRankings(cfg.forgeRes);
  const kb = new KnowledgeBase(db, cube.cards);
  const recorder = new Recorder(runDir, runId);
  const rng = new Rng(ev.seed);
  const seats = cfg.seats.map((sc) => makeSeat(sc, { cfg, db, kb, rankings, recorder, rng, cubeName: cube.name }));
  const draftLog = new Jsonl(path.join(runDir, "draft.jsonl"));
  const matchLog = new Jsonl(path.join(runDir, "matches.jsonl"));
  const allMatches: MatchResult[] = [];
  info(`run ${runId}: ${seats.length} seats, ${ev.pods} pod(s), ${ev.format}, bo${ev.gamesPerMatch}, engine=${engine.name}, knowledge=${ev.knowledge}`);
  if (source) info(`${source.src.mode} from ${source.src.runDir}: study${source.src.mode === "decks" ? ", draft and deckbuild" : " and draft"} skipped`);
  recorder.event("run_start", { cube: cube.name, cubeSize: cube.cards.length, seed: ev.seed, provenance,
    anchors: anchorVersions(cfg.seats, engine.name, cfg.engine.controller),
    seats: cfg.seats.map((s) => ({ id: s.id, provider: s.provider, model: s.model, temperature: s.temperature })), source: opts.source, sourceSeats: source?.seats });

  if (ev.cubeStudy && !source) {
    info("cube study…");
    fs.mkdirSync(path.join(runDir, "prep"), { recursive: true });
    await Promise.all(seats.map(async (s) => {
      const brief = await s.study(cube.cards, 0);
      if (brief) fs.writeFileSync(path.join(runDir, "prep", `${s.id}.md`), brief);
    }));
  }

  for (let pod = 0; pod < ev.pods; pod++) {
    const prng = rng.fork(`pod${pod}`);
    // Seating has its own stream so that drawing it leaves every other pod stream (draft, pairings, match seeds) as it was:
    // a re-run with the source's seating then gets the same match seeds as the source.
    const order: Seat[] = source ? source.seating[pod].map((id) => seats.find((s) => s.id === id)!) : ev.rotateSeats ? prng.fork("seating").shuffle([...seats]) : [...seats];
    info(`pod ${pod + 1}/${ev.pods}: seating ${order.map((s) => s.id).join(" → ")}`);
    // draftSeed: the seed whose packs this pod plays (the source's in a derived run); same cube + draftSeed + pod = same packs.
    recorder.event("pod_start", { pod, seating: order.map((s) => s.id), seed: ev.seed, draftSeed: source ? source.draftSeeds[pod] : ev.seed });

    const deckDir = path.join(runDir, `pod${pod}`, "decks");
    let decks: Deck[];
    if (source?.src.mode === "decks") {
      source.restoreContext(order, runDir, pod);
      decks = order.map((s) => source.deck(pod, s.id, db, ev.minDeckSize));
      info(`pod ${pod + 1}: decks loaded (${decks.map((d) => d.main.length).join(", ")} cards)`);
    } else {
      let pools: CardInstance[][];
      if (source) {
        source.restoreContext(order, runDir, pod);
        pools = order.map((s) => source.pool(pod, s.id));
        info(`pod ${pod + 1}: pools loaded (${pools.map((p) => p.length).join(", ")} cards)`);
      } else {
        pools = (await runDraft({ seats: order, cube: cube.cards, event: ev, db, rng: prng.fork("draft"), pod, log: draftLog })).pools;
        saveNotes(runDir, pod, order, "draft");
        info(`pod ${pod + 1}: draft done`);
      }
      decks = await Promise.all(order.map((s, i) => buildDeck(s, pools[i], ev, db, pod)));
      saveNotes(runDir, pod, order, "deckbuild");
      info(`pod ${pod + 1}: decks built (${decks.map((d) => d.main.length).join(", ")} cards)`);
    }
    const deckFiles = decks.map((d) => saveDeck(deckDir, d));

    const n = order.length;
    const points = new Array(n).fill(0);
    const censored = new Array(n).fill(0); // errored matches: no points for either seat
    const played = new Set<string>();
    const nRounds = ev.format === "round-robin" ? n - 1 : ev.rounds;
    const rr = ev.format === "round-robin" ? roundRobin(n) : null;
    for (let round = 0; round < nRounds; round++) {
      const pairs = rr ? rr[round] : swissRound(n, points, played, round, prng.fork(`swiss${round}`));
      const rematches = pairs.filter(([a, b]) => played.has(a < b ? `${a}-${b}` : `${b}-${a}`)).length;
      if (rematches) info(`round ${round + 1}: no pairing without rematches; ${rematches} rematch(es)`);
      const playOne = async (a: number, b: number, matchId: string, seed: number, replayOf?: string) => {
        let res: MatchResult;
        try {
          res = await engine.playMatch({
            matchId, pod, round: round + 1, seats: [order[a], order[b]], decks: [decks[a], decks[b]],
            deckFiles: [deckFiles[a], deckFiles[b]], gamesPerMatch: ev.gamesPerMatch, seed,
            maxGameTurns: ev.maxGameTurns, runDir, priorityStops: ev.priorityStops, manaPayment: ev.manaPayment, maxRetries: ev.maxRetries,
          });
        } catch (e: any) {
          res = { matchId, pod, round: round + 1, seats: [order[a].id, order[b].id], games: [], winner: null, error: String(e?.message ?? e), errorKind: "harness" };
        }
        if (replayOf) res.replayOf = replayOf;
        matchLog.write(res);
        allMatches.push(res);
        const score = res.games.map((g) => (g.winner === 0 ? "W" : g.winner === 1 ? "L" : "D")).join("");
        const outcome = res.error ? (replayOf || !replayable(res) ? "censored" : "errored, replaying at the end of the round") : res.winner === 0 ? order[a].id : res.winner === 1 ? order[b].id : "draw";
        info(`  r${round + 1} ${order[a].id} vs ${order[b].id}${replayOf ? " (replay)" : ""}: ${outcome} (${score})${res.error ? ` ERROR ${res.error}` : ""}`);
        return { res, a, b, seed };
      };
      const first = await pool(pairs, ev.parallelMatches, ([a, b]) => {
        const matchId = `p${pod}-r${round + 1}-${order[a].id}-vs-${order[b].id}`;
        return playOne(a, b, matchId, prng.fork(matchId).int(2 ** 31));
      });
      // A match that errored for a reason other than a harness bug is played once more from scratch, same decks and
      // seed, once the round's other matches are done; only if the replay errors too is the pairing censored.
      const replays = await pool(first.filter((r) => replayable(r.res)), ev.parallelMatches,
        (r) => playOne(r.a, r.b, `${r.res.matchId}-replay`, r.seed, r.res.matchId));
      const results = first.map((r) => replays.find((x) => x.res.replayOf === r.res.matchId) ?? r);
      for (const { res, a, b } of results) {
        played.add(a < b ? `${a}-${b}` : `${b}-${a}`);
        if (res.error) { censored[a]++; censored[b]++; }
        else if (res.winner === 0) points[a] += 3; else if (res.winner === 1) points[b] += 3; else { points[a] += 1; points[b] += 1; }
      }
    }
    recorder.event("pod_end", { pod, standings: order.map((s, i) => ({ seat: s.id, points: points[i], ...(censored[i] ? { censored: censored[i] } : {}) })).sort((x, y) => y.points - x.points) });
  }

  const ratings = rate(outcomesFromMatches(allMatches), { bootstrap: 500, seed: ev.seed });
  fs.writeFileSync(path.join(runDir, "ratings.json"), JSON.stringify(ratings, null, 2));
  recorder.event("run_end", { matches: allMatches.length });
  draftLog.close(); matchLog.close(); recorder.close();
  await engine.close?.();
  writeReport(runDir, cfg);
  return { runId, runDir, ratings };
}
