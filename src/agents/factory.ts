import type { Recorder } from "../analytics/recorder.ts";
import type { CardDb } from "../cards/db.ts";
import type { BenchConfig, SeatConfig } from "../config.ts";
import type { KnowledgeBase } from "../knowledge/tools.ts";
import type { Rng } from "../util/rng.ts";
import path from "node:path";
import { Jsonl } from "../util/log.ts";
import { Seat } from "./agent.ts";
import { BotAgent, RandomBot, RankBot } from "./bots.ts";
import { WebHumanAgent } from "./human.ts";
import { LlmAgent } from "./llm.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { EchoProvider } from "./providers/echo.ts";
import { OpenAIProvider } from "./providers/openai.ts";
import { limitConcurrency, type Provider } from "./providers/types.ts";

export interface SeatDeps {
  cfg: BenchConfig; db: CardDb; kb: KnowledgeBase; rankings: Map<string, number>; recorder: Recorder; rng: Rng; cubeName: string;
}

let promptLog: Jsonl | undefined;

export function makeSeat(sc: SeatConfig, d: SeatDeps): Seat {
  const log = d.cfg.event.recordPrompts
    ? (promptLog ??= new Jsonl(path.join(d.recorder.runDir, "rendered-prompts.jsonl")))
    : undefined;
  const rng = d.rng.fork(sc.id);
  const fallback = new RankBot(d.db, d.rankings, rng.fork("fallback"));
  const limit = (p: Provider) => (sc.concurrency ? limitConcurrency(p, sc.concurrency) : p);
  const w = d.cfg.event.providerRetryWindowSec;
  const retry = w === undefined ? {} : { windowMs: w * 1000 };
  let agent;
  switch (sc.provider) {
    case "random": agent = new BotAgent("random", new RandomBot(rng, d.db)); break;
    case "rank-bot": agent = new BotAgent("rank-bot", new RankBot(d.db, d.rankings, rng)); break;
    case "forge-ai": agent = new BotAgent("forge-ai", new RankBot(d.db, d.rankings, rng)); break;
    case "anthropic": agent = new LlmAgent(sc, limit(new AnthropicProvider(sc, retry)), d.cfg.event, d.cubeName, d.db, d.kb, log); break;
    case "openai": case "openrouter": case "gemini":
      agent = new LlmAgent(sc, limit(new OpenAIProvider(sc, retry)), d.cfg.event, d.cubeName, d.db, d.kb, log); break;
    case "echo": agent = new LlmAgent(sc, limit(new EchoProvider(sc)), d.cfg.event, d.cubeName, d.db, d.kb, log); break;
    case "human": agent = new WebHumanAgent(sc, d.db, d.recorder.runDir); break;
    default: throw new Error(`unknown provider ${(sc as any).provider}`);
  }
  return new Seat(sc, agent, fallback, d.recorder, d.cfg.event, d.cfg.pricing);
}
