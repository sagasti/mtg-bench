/**
 * Forge engine adapter. For each match:
 *   1. open a TCP server on 127.0.0.1 (random port, random token)
 *   2. spawn `java -cp forge.jar:bridge.jar forge.bridge.AgentBridge ...` with cwd = Forge install dir
 *   3. the bridge connects back and streams JSON lines: decision requests, game results
 *   4. each decision is routed to the right Seat; the answer is written back
 * See docs/PROTOCOL.md for the wire format and bridge/ for the Java side.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { InfraError } from "../../agents/agent.ts";
import type { EngineConfig } from "../../config.ts";
import type { DecisionKind, DecisionRequest } from "../../types.ts";
import { debug } from "../../util/log.ts";
import { scanEngineErrors } from "./log.ts";
import type { AutoAction, Delegation, EngineError, GameEngine, GameResult, MatchResult, MatchSpec } from "../types.ts";

export function findForgeJar(forgeDir: string): string | undefined {
  const cands: string[] = [];
  const scan = (d: string, depth: number) => {
    if (!fs.existsSync(d) || depth < 0) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && ["target", "lib"].includes(e.name)) scan(p, depth - 1);
      else if (/^forge-gui-desktop-.*jar-with-dependencies\.jar$/.test(e.name)) cands.push(p);
    }
  };
  scan(forgeDir, 2);
  scan(path.join(forgeDir, "forge-gui-desktop", "target"), 0);
  return cands.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

export function resolveForge(cfg: EngineConfig) {
  const forgeDir = cfg.forgeDir!;
  const forgeJar = cfg.forgeJar ?? findForgeJar(forgeDir);
  const bridgeJar = cfg.bridgeJar ?? path.resolve("bridge/build/mtg-bench-bridge.jar");
  // Forge resolves res/ relative to the working directory. A release install has res/ at the top;
  // a source checkout keeps it in forge-gui/.
  const cwd = fs.existsSync(path.join(forgeDir, "res")) ? forgeDir : path.join(forgeDir, "forge-gui");
  return { forgeDir, forgeJar, bridgeJar, cwd };
}

/** Wall-clock cap per match: engine.matchTimeoutSec, else gamesPerMatch × engine.gameTimeoutSec (default 60 min a game). */
export function matchTimeoutSec(cfg: EngineConfig, gamesPerMatch: number): number {
  return cfg.matchTimeoutSec ?? gamesPerMatch * (cfg.gameTimeoutSec ?? 3600);
}

/**
 * Records one match may send before it is ended as a bridge error. A bridge re-asking the same question forever would
 * otherwise grow these arrays until the whole event runs out of heap (MB-045).
 */
const MAX_RECORDS = 100_000;

export class ForgeEngine implements GameEngine {
  readonly name = "forge";
  constructor(private cfg: EngineConfig) {}

  playMatch(spec: MatchSpec): Promise<MatchResult> {
    const { forgeJar, bridgeJar, cwd } = resolveForge(this.cfg);
    if (!forgeJar || !fs.existsSync(forgeJar)) throw new Error(`Forge jar not found (engine.forgeJar / ${this.cfg.forgeDir})`);
    if (!fs.existsSync(bridgeJar)) throw new Error(`bridge jar not found at ${bridgeJar}; run bridge/build.sh`);
    const token = crypto.randomBytes(16).toString("hex");
    const games: GameResult[] = [];
    const delegations: Delegation[] = [];
    const forfeits: Delegation[] = [];
    const auto: AutoAction[] = [];
    const decisions: [number, number] = [0, 0];
    let current: { game: number; onThePlay: 0 | 1; t0: number } | null = null;
    const logDir = path.join(spec.runDir, "forge-logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${spec.matchId}.log`);
    const logFile = fs.openSync(logPath, "a");
    /** Log size at each game's end, so an exception's offset in the log attributes it to a game. */
    const gameEnds: number[] = [];

    return new Promise<MatchResult>((resolve) => {
      let settled = false;
      const server = net.createServer();
      let child: ReturnType<typeof spawn> | null = null;
      const finish = (error?: string, errorKind?: MatchResult["errorKind"]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        server.close();
        if (child && child.exitCode === null) child.kill("SIGKILL");
        try { fs.closeSync(logFile); } catch { /* ignore */ }
        const engineErrors = scanEngineErrors(logPath, gameEnds);
        const w0 = games.filter((g) => g.winner === 0).length, w1 = games.filter((g) => g.winner === 1).length;
        // An abandoned match has no winner, whatever the score when it stopped (its games stay in `games` for the record).
        resolve({ matchId: spec.matchId, pod: spec.pod, round: spec.round, seats: [spec.seats[0].id, spec.seats[1].id], games,
          winner: error ? null : w0 > w1 ? 0 : w1 > w0 ? 1 : null, delegations, forfeits, auto, engineErrors, error, ...(error ? { errorKind } : {}) });
      };
      // Provider failures are infrastructure; anything else thrown while answering is a bug in the harness.
      const abandon = (e: any) => finish(`${e instanceof InfraError ? "infrastructure error" : "harness error"}: ${e?.message ?? e}`, e instanceof InfraError ? "infra" : "harness");
      const timeoutSec = matchTimeoutSec(this.cfg, spec.gamesPerMatch);
      const timer = setTimeout(() => finish(`match timeout after ${timeoutSec}s`, "timeout"), timeoutSec * 1000);

      server.on("connection", (sock) => {
        const rl = readline.createInterface({ input: sock });
        let authed = false;
        const send = (o: unknown) => sock.write(JSON.stringify(o) + "\n");
        rl.on("line", async (line) => {
          let msg: any;
          try { msg = JSON.parse(line); } catch { return; }
          if (!authed) {
            if (msg.type === "hello" && msg.token === token) { authed = true; return; }
            sock.destroy(); return;
          }
          switch (msg.type) {
            case "game_start":
              current = { game: msg.game, onThePlay: msg.onThePlay, t0: Date.now() };
              decisions[0] = decisions[1] = 0;
              break;
            case "decision": {
              const seatIdx = msg.seat as 0 | 1;
              decisions[seatIdx]++;
              const req: DecisionRequest = {
                requestId: `${spec.matchId}-g${msg.game ?? current?.game ?? 0}-${msg.rid}`,
                phase: "game", kind: msg.kind as DecisionKind, prompt: msg.prompt, state: msg.state,
                options: msg.options, min: msg.min, max: msg.max, hints: msg.hints, attempt: msg.attempt,
              };
              try {
                const res = await spec.seats[seatIdx].decide(req, { pod: spec.pod, matchId: spec.matchId, game: msg.game ?? current?.game });
                send({ type: "answer", rid: msg.rid, choice: res.choice, ...(res.forfeit ? { forfeit: true } : {}) });
              } catch (e: any) {
                // Provider outage or harness bug: abandon the match rather than play it on the agent's behalf.
                abandon(e);
              }
              break;
            }
            case "game_end":
              if (Array.isArray(msg.auto)) {
                for (const i of [0, 1] as const) for (const a of msg.auto[i] ?? []) auto.push({ seat: i, game: msg.game, ...a });
              }
              if (Array.isArray(msg.log)) {
                const dir = path.join(spec.runDir, "games");
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, `${spec.matchId}-g${msg.game}.log`),
                  `# ${spec.matchId} game ${msg.game}: P1 = ${spec.seats[0].id}, P2 = ${spec.seats[1].id}\n` + msg.log.join("\n") + "\n");
              }
              try { gameEnds.push(fs.fstatSync(logFile).size); } catch { /* ignore */ }
              games.push({
                game: msg.game, winner: msg.winner ?? null, onThePlay: msg.onThePlay ?? current?.onThePlay ?? 0, turns: msg.turns ?? 0,
                reason: msg.reason ?? "unknown", decisions: [...decisions] as [number, number], durationMs: current ? Date.now() - current.t0 : 0,
              });
              break;
            case "between_games": {
              // Each LLM seat rewrites its match notes from the public log; the next game waits for both.
              try {
                await Promise.all([0, 1].map((i) => spec.seats[i].betweenGames(spec.pod, spec.matchId, {
                  game: msg.game, yourWins: msg.wins?.[i] ?? 0, opponentWins: msg.wins?.[1 - i] ?? 0,
                  yourName: msg.names?.[i] ?? "?", opponentName: msg.names?.[1 - i] ?? "?", log: msg.log ?? [],
                })));
                send({ type: "answer", rid: msg.rid });
              } catch (e: any) {
                abandon(e);
              }
              break;
            }
            case "delegated":
              delegations.push({ seat: msg.seat, game: msg.game, what: msg.what, reason: msg.reason });
              if (delegations.length > MAX_RECORDS) finish(`bridge sent over ${MAX_RECORDS} delegations (stuck in a loop?)`, "bridge");
              break;
            case "forfeit":
              forfeits.push({ seat: msg.seat, game: msg.game, what: msg.what, reason: msg.reason });
              if (forfeits.length > MAX_RECORDS) finish(`bridge sent over ${MAX_RECORDS} forfeits (stuck in a loop?)`, "bridge");
              break;
            case "match_end": finish(); break;
            case "error": fs.writeSync(logFile, `[bridge error] ${msg.msg}\n`); break;
            case "log": debug(`[forge ${spec.matchId}] ${msg.msg}`); break;
          }
        });
        sock.on("error", () => { /* surfaced via child exit */ });
      });

      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as net.AddressInfo).port;
        const sep = process.platform === "win32" ? ";" : ":";
        const args = [
          ...(this.cfg.javaOpts ?? ["-Xmx4g"]),
          "-Djava.awt.headless=true",
          "-cp", `${forgeJar}${sep}${bridgeJar}`,
          "forge.bridge.AgentBridge",
          "--port", String(port), "--token", token,
          "--deck0", path.resolve(spec.deckFiles[0]), "--deck1", path.resolve(spec.deckFiles[1]),
          "--external0", String(!spec.seats[0].usesForgeAi), "--external1", String(!spec.seats[1].usesForgeAi),
          "--games", String(spec.gamesPerMatch), "--seed", String(spec.seed), "--max-turns", String(spec.maxGameTurns),
          "--stops", spec.priorityStops, "--mana", spec.manaPayment, "--max-retries", String(spec.maxRetries),
          "--human", String(this.cfg.controller !== "ai"),
        ];
        fs.writeSync(logFile, `$ ${this.cfg.java ?? "java"} ${args.join(" ")}\n(cwd ${cwd})\n`);
        child = spawn(this.cfg.java ?? "java", args, { cwd, stdio: ["ignore", logFile, logFile] });
        child.on("exit", (code) => { if (!settled) setTimeout(() => finish(code === 0 ? undefined : `bridge exited with code ${code} (see forge-logs/${spec.matchId}.log)`, "bridge"), 200); });
        child.on("error", (e) => finish(`failed to start java: ${e.message}`, "bridge"));
      });
    });
  }
}

