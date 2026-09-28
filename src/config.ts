/**
 * Benchmark configuration (YAML). See docs/AGENTS.md for the full reference
 * and config/event.example.yaml for a filled-in example.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export type ProviderName =
  | "anthropic"          // Anthropic Messages API
  | "openai"             // OpenAI Chat Completions (also any OpenAI-compatible server via baseUrl)
  | "openrouter"         // OpenAI-compatible, baseUrl defaults to https://openrouter.ai/api/v1
  | "gemini"             // Google's OpenAI-compatible endpoint
  | "random"             // uniform random legal choice (floor anchor)
  | "rank-bot"           // drafts by CubeCobra rank, builds 2-colour 23/17, plays greedily
  | "forge-ai"           // Forge's built-in AI plays the games (drafts/builds like rank-bot)
  | "echo";              // offline stand-in for an LLM: exercises the full prompt/tool path, picks randomly

export type KnowledgeTier = "names" | "oracle" | "oracle+tools" | "oracle+tools+primer";

export interface SeatConfig {
  id: string;                    // unique, stable across runs; used in ratings
  provider: ProviderName;
  model?: string;
  label?: string;                // display name
  apiKeyEnv?: string;            // env var holding the key (never put keys in the YAML)
  baseUrl?: string;              // override endpoint (OpenAI-compatible servers, proxies)
  maxTokens?: number;            // max output tokens per model call (default 2048)
  temperature?: number;
  /** Anthropic extended thinking budget (tokens). Omit to disable. */
  thinkingBudget?: number;
  /** OpenAI-style reasoning effort ("low" | "medium" | "high"). */
  reasoningEffort?: string;
  /** Extra JSON merged into every request body (provider-specific knobs). */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Max concurrent in-flight requests for this seat (rate-limit guard). */
  concurrency?: number;
  /** Per-seat overrides of event.maxToolCallsPerDecision etc. are deliberately NOT allowed: same rules for everyone. */
}

export interface EventConfig {
  name: string;
  cube: string;                  // Forge cube name (res/cube/<name>.dck) or a path
  pods: number;                  // how many independent pods to run
  seed: number;
  packs: number;
  packSize: number;
  format: "round-robin" | "swiss"; // round-robin: every pair plays once (7 rounds for 8 seats)
  rounds: number;                // Swiss rounds per pod (ignored for round-robin)
  gamesPerMatch: number;         // best-of-N
  minDeckSize: number;
  knowledge: KnowledgeTier;
  promptVersion: string;         // folder under prompts/ (e.g. "v1")
  maxToolCallsPerDecision: number;
  maxRetries: number;            // re-asks after an invalid answer before falling back
  decisionTimeoutSec: number;
  carryNotes: boolean;           // let agents keep a scratchpad across decisions
  maxGameTurns: number;          // turn cap -> draw
  rotateSeats: boolean;          // re-shuffle seating each pod
  /** Pre-draft cube study: each LLM seat writes a strategy brief from the full card list, reused at every pick. */
  cubeStudy: boolean;
  briefMaxWords: number;
  /** Where the brief is shown: draft only, or draft + deckbuild + game. */
  briefScope: "draft" | "all";
  /** Matches run concurrently within a round (each match is independent). */
  parallelMatches: number;
  /** Forge: smart = ask at meaningful priority stops only; all = every priority pass. */
  priorityStops: "smart" | "all";
  /** Forge: smart = ask which lands to tap only when the choice can matter; always = every payment. */
  manaPayment: "smart" | "always";
}

export interface EngineConfig {
  type: "mock" | "forge";
  /** Forge install dir (contains res/ and the forge-gui-desktop jar). */
  forgeDir?: string;
  forgeJar?: string;             // defaults to newest forge-gui-desktop-*-jar-with-dependencies.jar in forgeDir
  bridgeJar?: string;            // defaults to bridge/build/mtg-bench-bridge.jar
  java?: string;                 // java binary (default "java")
  javaOpts?: string[];
  matchTimeoutSec?: number;      // hard wall-clock cap per match
  /** Seats whose in-game decisions go to Forge AI even if they're LLMs (debug). */
}

export interface Pricing { input: number; output: number; cacheRead?: number; cacheWrite?: number } // USD per 1M tokens

export interface BenchConfig {
  event: EventConfig;
  engine: EngineConfig;
  forgeRes?: string;
  outputDir: string;
  pricing: Record<string, Pricing>; // keyed by model id
  seats: SeatConfig[];
}

const EVENT_DEFAULTS: Omit<EventConfig, "name" | "cube"> = {
  pods: 1, seed: 1, packs: 3, packSize: 15, format: "round-robin", rounds: 3, gamesPerMatch: 3, minDeckSize: 40,
  knowledge: "oracle+tools", promptVersion: "v1", maxToolCallsPerDecision: 6, maxRetries: 2,
  decisionTimeoutSec: 180, carryNotes: true, maxGameTurns: 40, rotateSeats: true,
  cubeStudy: true, briefMaxWords: 1000, briefScope: "all", parallelMatches: 4, priorityStops: "smart", manaPayment: "smart",
};

export function loadConfig(file: string): BenchConfig {
  const raw = YAML.parse(fs.readFileSync(file, "utf8")) ?? {};
  const event: EventConfig = { ...EVENT_DEFAULTS, ...(raw.event ?? {}) };
  if (!event.name) throw new Error("event.name is required");
  if (!event.cube) throw new Error("event.cube is required");
  const engine: EngineConfig = { type: "mock", ...(raw.engine ?? {}) };
  const expand = (p?: string) => (p ? path.resolve(p.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")) : p);
  engine.forgeDir = expand(engine.forgeDir);
  engine.forgeJar = expand(engine.forgeJar);
  engine.bridgeJar = expand(engine.bridgeJar);
  let forgeRes = expand(raw.forgeRes);
  if (!forgeRes && engine.forgeDir) forgeRes = path.join(engine.forgeDir, "res");
  const seats: SeatConfig[] = raw.seats ?? [];
  const cfg: BenchConfig = {
    event, engine, forgeRes,
    outputDir: expand(raw.outputDir ?? "runs")!,
    pricing: raw.pricing ?? {},
    seats,
  };
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: BenchConfig) {
  const errs: string[] = [];
  const podSize = 8;
  if (cfg.seats.length !== podSize) errs.push(`exactly ${podSize} seats are required (got ${cfg.seats.length})`);
  const ids = new Set<string>();
  for (const [i, s] of cfg.seats.entries()) {
    const where = `seats[${i}]${s.id ? ` (${s.id})` : ""}`;
    if (!s.id) errs.push(`${where}: id is required`);
    else if (!/^[A-Za-z0-9_.-]+$/.test(s.id)) errs.push(`${where}: id may only contain letters, digits, _ . -`);
    else if (ids.has(s.id)) errs.push(`${where}: duplicate id`);
    ids.add(s.id);
    const llm = ["anthropic", "openai", "openrouter", "gemini"].includes(s.provider);
    if (!["anthropic", "openai", "openrouter", "gemini", "random", "rank-bot", "forge-ai", "echo"].includes(s.provider))
      errs.push(`${where}: unknown provider "${s.provider}"`);
    if (llm && !s.model) errs.push(`${where}: model is required for provider ${s.provider}`);
    if (llm && !s.apiKeyEnv && !s.baseUrl) errs.push(`${where}: apiKeyEnv is required for provider ${s.provider}`);
    if ((s as any).apiKey) errs.push(`${where}: put the key in an env var and reference it with apiKeyEnv, not apiKey`);
  }
  if (cfg.event.packs * cfg.event.packSize * podSize > 100000) errs.push("pod is unreasonably large");
  if (!["names", "oracle", "oracle+tools", "oracle+tools+primer"].includes(cfg.event.knowledge)) errs.push(`event.knowledge must be names | oracle | oracle+tools | oracle+tools+primer`);
  if (!["round-robin", "swiss"].includes(cfg.event.format)) errs.push("event.format must be round-robin or swiss");
  if (cfg.engine.type === "forge" && !cfg.engine.forgeDir) errs.push("engine.forgeDir is required when engine.type is forge");
  if (errs.length) throw new Error("Invalid config:\n  - " + errs.join("\n  - "));
}

/** Checks that every LLM seat's key env var is actually set. Returned as warnings so `check` can list them all. */
export function missingKeys(cfg: BenchConfig): string[] {
  const out: string[] = [];
  for (const s of cfg.seats) {
    if (s.apiKeyEnv && !process.env[s.apiKeyEnv]) out.push(`${s.id}: env var ${s.apiKeyEnv} is not set`);
  }
  return out;
}
