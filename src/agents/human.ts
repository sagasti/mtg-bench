/** Pilot patch (mtg-rival): a seat played by a person in the browser (src/human/server.ts). */
import { ZERO_USAGE } from "../analytics/recorder.ts";
import type { CardDb } from "../cards/db.ts";
import type { SeatConfig } from "../config.ts";
import type { DecisionRequest, DecideContext } from "../types.ts";
import type { AgentResult, DecisionAgent } from "./agent.ts";
import { HumanWebServer } from "../human/server.ts";

let shared: HumanWebServer | undefined;

export class WebHumanAgent implements DecisionAgent {
  readonly kind = "human";
  readonly model = "human";
  private server: HumanWebServer;
  private started: Promise<void>;
  private timeoutMs?: number;
  constructor(sc: SeatConfig, db: CardDb, runDir: string) {
    if (shared) throw new Error("only one human seat per run");
    this.timeoutMs = sc.decisionTimeoutSec ? sc.decisionTimeoutSec * 1000 : undefined;
    shared = this.server = new HumanWebServer({ port: sc.webPort ?? 8787, token: sc.webToken, cacheDir: `${runDir}/../.imgcache`, db, seatId: sc.id, label: sc.label });
    this.started = this.server.start();
  }
  async decide(req: DecisionRequest, ctx: DecideContext): Promise<AgentResult> {
    await this.started;
    const choice = await this.server.ask(req, { matchId: ctx.matchId, game: ctx.game }, this.timeoutMs);
    if (!choice) return { response: null, timedOut: true, error: `no answer within ${this.timeoutMs! / 1000}s`, usage: ZERO_USAGE, modelCalls: 0, toolCalls: {}, invalidAttempts: 0 };
    return { response: { choice }, usage: ZERO_USAGE, modelCalls: 0, toolCalls: {}, invalidAttempts: 0 };
  }
}

export function humanServer() { return shared; }
