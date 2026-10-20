/**
 * Benchmark configuration (YAML). See docs/AGENTS.md for the full reference
 * and config/event.example.yaml for a filled-in example.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export type ProviderName =
  | "anthropic"          // Anthropic Messages API
  | "openai"             // OpenAI Chat Completions (also any OpenAI-compatible server via baseUrl)
  | "openrouter"         // OpenAI-compatible, baseUrl defaults to https://openrouter.ai/api/v1
  | "human"              // pilot patch: a person playing in the browser (src/human/server.ts)
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
  maxTokens?: number;            // max output tokens per model call, reasoning included (default: see maxTokensFor)
  temperature?: number;
  /** Anthropic extended thinking budget (tokens). Omit to disable. */
  thinkingBudget?: number;
  /** OpenAI-style reasoning effort ("low" | "medium" | "high"). */
  reasoningEffort?: string;
  /** Pilot patch: reasoning effort per decision kind (e.g. { attackers: high, blockers: high }); the others use reasoningEffort. */
  reasoningEffortByKind?: Record<string, string>;
  /**
   * Pilot patch: when a decision's time budget runs out, instead of forfeiting the agent is asked once more with this
   * reasoning effort (e.g. "none") under a fresh budget of fallbackTimeoutSec (default 60). The decision is recorded
   * with `timeoutFallback: true`.
   */
  fallbackReasoningEffort?: string;
  fallbackTimeoutSec?: number;
  /** Pilot patch, provider "human": port of the web table (default 8787) and the link token (random per run when unset). */
  webPort?: number;
  webToken?: string;
  /** Pilot patch, provider "human": seconds an external bot/person gets per decision; unanswered = forfeit (null action). Unset = wait forever. */
  decisionTimeoutSec?: number;
  /** Extra JSON merged into every request body (provider-specific knobs). */
  extraBody?: Record<string, unknown>;
  /** Pilot patch: per-seat overrides of the knowledge/policy event flags (to pit an expert seat against a frozen one in the same run). */
  eventOverrides?: Partial<Pick<EventConfig, "damageMath" | "mulliganMath" | "mulliganPolicy" | "plansFile" | "combatMath" | "openMana" | "auraPolicy" | "combatPolicy">>;
  headers?: Record<string, string>;
  /** Max concurrent in-flight model calls for this seat (rate-limit guard); unset = no limit. Queue time isn't charged to the agent. */
  concurrency?: number;
  /**
   * OpenRouter only: backup host slugs serving the same model and quantisation, tried in order only after the primary
   * host (extraBody.provider.order) fails twice in a row within one call; each is pinned alone without fallbacks.
   * `servedBy` records who answered and the report flags seats served by more than one host. Unset = primary only.
   */
  backupProviders?: string[];
  /**
   * Budgets. Once the seat's computed cost (tokens × `pricing`) reaches maxSpendUsd, or the p95 of its decision latency
   * exceeds maxP95LatencySec (over at least 20 decisions), its remaining matches aren't played (recorded as not played,
   * no result for either seat) and any later draft picks and deckbuilds are rank-bot fallbacks. Checked before each
   * match and decision outside games, so a match in progress finishes. Unset = no limit.
   */
  maxSpendUsd?: number;
  maxP95LatencySec?: number;
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
  rounds: number;                // Swiss rounds per pod, 1 to seats-1 (ignored for round-robin)
  gamesPerMatch: number;         // best-of-N
  minDeckSize: number;
  knowledge: KnowledgeTier;
  promptVersion: string;         // folder under prompts/ (e.g. "v1")
  maxToolCallsPerDecision: number;
  maxRetries: number;            // re-asks after a failed answer before the decision is forfeited (null action)
  decisionTimeoutSec: number;
  carryNotes: boolean;           // let agents keep a scratchpad across decisions
  maxGameTurns: number;          // turn cap -> draw
  recordPrompts: boolean;        // write every rendered LLM prompt to runs/<id>/rendered-prompts.jsonl (for review)
  rotateSeats: boolean;          // re-shuffle seating each pod
  /** Pre-draft cube study: each LLM seat writes a strategy brief from the full card list, reused at every pick. */
  cubeStudy: boolean;
  briefMaxWords: number;
  /** Where the brief is shown: draft only, or draft + deckbuild + game. */
  briefScope: "draft" | "all";
  /** Matches played at once (each match is independent): slots of the round-robin pool, or per Swiss round. */
  parallelMatches: number;
  /**
   * Round robin only: "pool" (default) plays all matches through one pool of parallelMatches slots; "rounds" waits for
   * each round's slowest match before starting the next (the schedule before MB-053). Swiss always plays by rounds.
   * Optional, with no entry in the defaults, so configs that don't set it keep their config hash.
   */
  schedule?: "pool" | "rounds";
  /** Forge: smart = ask at meaningful priority stops only; all = every priority pass. */
  priorityStops: "smart" | "all";
  /** Forge: smart = ask which lands to tap only when the choice can matter; always = every payment. */
  manaPayment: "smart" | "always";
  /** Report: a seat whose forfeits + fallbacks + provider-failure decisions exceed this share of its decisions is listed apart from the leaderboard. */
  maxFailureRate: number;
  /**
   * How long a model call waits out transient provider errors (429, 408, 5xx, 529, network errors, host unavailable)
   * with capped backoff before the decision is an infrastructure error (default 1200 = 20 min). Backoff isn't charged to
   * the agent's clock. Optional, with no entry in the defaults, so configs that don't set it keep their config hash.
   */
  providerRetryWindowSec?: number;
  /**
   * Pilot patch (mtg-rival): render a "Damage math" section (face damage available this turn, lethal check, incoming
   * combat) computed by the harness into every in-game prompt. Optional, no entry in the defaults, so configs that
   * don't set it keep their config hash.
   */
  damageMath?: boolean;
  /** Pilot patch: render a "Keep or mulligan" section (lands, mana sources, land-drop odds, heuristic verdict) into mulligan / london_bottom prompts. */
  mulliganMath?: boolean;
  /** Pilot patch: "strict" = the clear-cut mulligan verdicts (no land, one-lander without a plan, 5+ lands on 7) are answered by the harness, not the model. Default "advise". */
  mulliganPolicy?: "advise" | "strict";
  /** Pilot patch: "Combat" section (legal single blocks and their outcome, the race). */
  combatMath?: boolean;
  /** Pilot patch: "Their open mana" section (open mana, instant-speed answers left in their known list, our mana after each cast). */
  openMana?: boolean;
  /** Pilot patch: strict = an Aura this seat casts never targets a token or non-hexproof creature when one of its hexproof creatures is a legal target. */
  auraPolicy?: "advise" | "strict";
  /** Pilot patch: strict = an aura-wearing attacker without first strike is not offered when an untapped deathtouch creature can block it and the attack is not lethal (needs combatMath). */
  combatPolicy?: "advise" | "strict";
  /** Pilot patch: YAML with archetype signatures and matchup plans; a "Game plan" section is rendered when the seat's deck is recognised. */
  plansFile?: string;
  /** Pilot patch: decide play/draw by policy so that odd matches put seat 0 on the play and even matches seat 1 (balanced bars). */
  playDrawAlternate?: boolean;
}

export interface EngineConfig {
  type: "mock" | "forge";
  /** Forge install dir (contains res/ and the forge-gui-desktop jar). */
  forgeDir?: string;
  forgeJar?: string;             // defaults to newest forge-gui-desktop-*-jar-with-dependencies.jar in forgeDir
  bridgeJar?: string;            // defaults to bridge/build/mtg-bench-bridge.jar
  java?: string;                 // java binary (default "java")
  /** Which Forge controller agent seats use: "human" (default: Forge's human controller + headless screen) or "ai" (PlayerControllerExternal, kept for comparison). */
  controller?: "ai" | "human";
  javaOpts?: string[];
  /** Wall-clock budget per game, used to size the match cap: gamesPerMatch × this (default 3600, i.e. 60 min a game). */
  gameTimeoutSec?: number;
  matchTimeoutSec?: number;      // hard wall-clock cap per match; overrides gamesPerMatch × gameTimeoutSec
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
  knowledge: "oracle+tools", promptVersion: "v2", maxToolCallsPerDecision: 6, maxRetries: 3,
  decisionTimeoutSec: 180, carryNotes: true, maxGameTurns: 40, recordPrompts: false, rotateSeats: true,
  cubeStudy: true, briefMaxWords: 1000, briefScope: "all", parallelMatches: 4, priorityStops: "smart", manaPayment: "smart", maxFailureRate: 0.05,
};

/** Pilot patch: `${VAR}` inside any string of the config is replaced with the environment variable (endpoints and
 *  other deployment details stay out of the repo). An unset variable is an error, not an empty string. */
function expandEnv(v: unknown, where: string): unknown {
  if (typeof v === "string") return v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    const val = process.env[name];
    if (val === undefined || val === "") throw new Error(`${where}: environment variable ${name} is not set (referenced as \${${name}})`);
    return val;
  });
  if (Array.isArray(v)) return v.map((x, i) => expandEnv(x, `${where}[${i}]`));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, expandEnv(x, `${where}.${k}`)]));
  return v;
}

export function loadConfig(file: string): BenchConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = expandEnv(YAML.parse(fs.readFileSync(file, "utf8")) ?? {}, file) as any;
  const event: EventConfig = { ...EVENT_DEFAULTS, ...(raw.event ?? {}) };
  if (!event.name) throw new Error("event.name is required");
  if (!event.cube) throw new Error("event.cube is required");
  const engine: EngineConfig = { type: "mock", ...(raw.engine ?? {}) };
  const expand = (p?: string) => (p ? path.resolve(p.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")) : p);
  engine.forgeDir = expand(engine.forgeDir);
  engine.forgeJar = expand(engine.forgeJar);
  engine.bridgeJar = expand(engine.bridgeJar);
  let forgeRes = expand(raw.forgeRes);
  if (!forgeRes && engine.forgeDir) {
    // release install: <dir>/res ; source checkout: <dir>/forge-gui/res
    const src = path.join(engine.forgeDir, "forge-gui", "res");
    forgeRes = !fs.existsSync(path.join(engine.forgeDir, "res")) && fs.existsSync(src) ? src : path.join(engine.forgeDir, "res");
  }
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
    if (!["anthropic", "openai", "openrouter", "gemini", "random", "rank-bot", "forge-ai", "echo", "human"].includes(s.provider))
      errs.push(`${where}: unknown provider "${s.provider}"`);
    if (llm && !s.model) errs.push(`${where}: model is required for provider ${s.provider}`);
    if (llm && !s.apiKeyEnv && !s.baseUrl) errs.push(`${where}: apiKeyEnv is required for provider ${s.provider}`);
    if (s.concurrency !== undefined && !(Number.isInteger(s.concurrency) && s.concurrency > 0)) errs.push(`${where}: concurrency must be a positive integer`);
    for (const k of ["maxSpendUsd", "maxP95LatencySec"] as const) if (s[k] !== undefined && !(typeof s[k] === "number" && s[k]! > 0)) errs.push(`${where}: ${k} must be a positive number`);
    if (s.maxSpendUsd !== undefined && !cfg.pricing[s.model ?? s.provider]) errs.push(`${where}: maxSpendUsd needs a pricing entry for model ${s.model ?? s.provider}`);
    if ((s as any).apiKey) errs.push(`${where}: put the key in an env var and reference it with apiKeyEnv, not apiKey`);
    if (s.backupProviders !== undefined) {
      const primary = ((s.extraBody?.provider as { order?: string[] } | undefined)?.order ?? []).map((h) => h.toLowerCase());
      if (s.provider !== "openrouter") errs.push(`${where}: backupProviders needs provider openrouter (it pins OpenRouter hosts)`);
      else if (!Array.isArray(s.backupProviders) || !s.backupProviders.length || !s.backupProviders.every((h) => typeof h === "string" && h)) errs.push(`${where}: backupProviders must be a non-empty list of host slugs`);
      else if (new Set(s.backupProviders.map((h) => h.toLowerCase())).size !== s.backupProviders.length || s.backupProviders.some((h) => primary.includes(h.toLowerCase()))) errs.push(`${where}: backupProviders must not repeat a host or the primary`);
    }
  }
  if (cfg.event.packs * cfg.event.packSize * podSize > 100000) errs.push("pod is unreasonably large");
  if (!["names", "oracle", "oracle+tools", "oracle+tools+primer"].includes(cfg.event.knowledge)) errs.push(`event.knowledge must be names | oracle | oracle+tools | oracle+tools+primer`);
  if (!["round-robin", "swiss"].includes(cfg.event.format)) errs.push("event.format must be round-robin or swiss");
  if (cfg.event.format === "swiss" && !(Number.isInteger(cfg.event.rounds) && cfg.event.rounds >= 1 && cfg.event.rounds <= podSize - 1)) errs.push(`event.rounds must be 1–${podSize - 1} for Swiss (${podSize} seats)`);
  if (cfg.engine.type === "forge" && !cfg.engine.forgeDir) errs.push("engine.forgeDir is required when engine.type is forge");
  if (cfg.event.schedule !== undefined && !["pool", "rounds"].includes(cfg.event.schedule)) errs.push("event.schedule must be pool or rounds");
  if (cfg.event.damageMath !== undefined && typeof cfg.event.damageMath !== "boolean") errs.push("event.damageMath must be true or false");
  if (cfg.event.mulliganMath !== undefined && typeof cfg.event.mulliganMath !== "boolean") errs.push("event.mulliganMath must be true or false");
  if (cfg.event.mulliganPolicy !== undefined && !["advise", "strict"].includes(cfg.event.mulliganPolicy)) errs.push("event.mulliganPolicy must be advise or strict");
  if (cfg.event.mulliganPolicy === "strict" && !cfg.event.mulliganMath) errs.push("event.mulliganPolicy strict needs event.mulliganMath: true");
  if (cfg.event.combatMath !== undefined && typeof cfg.event.combatMath !== "boolean") errs.push("event.combatMath must be true or false");
  if (cfg.event.openMana !== undefined && typeof cfg.event.openMana !== "boolean") errs.push("event.openMana must be true or false");
  if (cfg.event.auraPolicy !== undefined && !["advise", "strict"].includes(cfg.event.auraPolicy)) errs.push("event.auraPolicy must be advise or strict");
  if (cfg.event.combatPolicy !== undefined && !["advise", "strict"].includes(cfg.event.combatPolicy)) errs.push("event.combatPolicy must be advise or strict");
  if (cfg.event.combatPolicy === "strict" && !cfg.event.combatMath) errs.push("event.combatPolicy strict needs event.combatMath: true");
  if (cfg.event.playDrawAlternate !== undefined && typeof cfg.event.playDrawAlternate !== "boolean") errs.push("event.playDrawAlternate must be true or false");
  if (cfg.event.plansFile !== undefined && (typeof cfg.event.plansFile !== "string" || !fs.existsSync(cfg.event.plansFile))) errs.push("event.plansFile must point to an existing YAML file");
  const w = cfg.event.providerRetryWindowSec;
  if (w !== undefined && !(typeof w === "number" && w >= 0)) errs.push("event.providerRetryWindowSec must be a number of seconds >= 0");
  if (errs.length) throw new Error("Invalid config:\n  - " + errs.join("\n  - "));
}

/**
 * Pre-registration hash: SHA-256 of the effective config with keys sorted, covering everything that shapes the
 * experiment (event, seats, pricing, engine settings) but not where it runs: outputDir, forgeRes and the engine's
 * forgeDir / forgeJar / bridgeJar / java / javaOpts are left out (the run id isn't in the config).
 */
export function configHash(cfg: BenchConfig): string {
  const { forgeDir, forgeJar, bridgeJar, java, javaOpts, ...engine } = cfg.engine;
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as any)[k])])) : v;
  return crypto.createHash("sha256").update(JSON.stringify(sorted({ event: cfg.event, engine, seats: cfg.seats, pricing: cfg.pricing }))).digest("hex");
}

/** The seat's config switches reasoning off (OpenRouter's unified `reasoning` field, OpenAI's effort, or Anthropic without thinking). */
export function reasoningDisabled(s: SeatConfig): boolean {
  const r = s.extraBody?.reasoning as { enabled?: boolean; max_tokens?: number; effort?: string } | undefined;
  if (r) return r.enabled === false || r.max_tokens === 0 || r.effort === "none";
  if (s.reasoningEffort) return s.reasoningEffort === "none";
  return s.provider === "anthropic" && !s.thinkingBudget;
}

/**
 * Output cap per call. Reasoning and the answer share it, so a seat that may reason gets room for both: 4096 tokens
 * with reasoning off (an answer or a full set of notes fits easily), 16384 otherwise. A seat's maxTokens overrides it.
 */
export function maxTokensFor(s: SeatConfig): number {
  return s.maxTokens ?? (reasoningDisabled(s) ? 4096 : 16384);
}

/** Checks that every LLM seat's key env var is actually set. Returned as warnings so `check` can list them all. */
export function missingKeys(cfg: BenchConfig): string[] {
  const out: string[] = [];
  for (const s of cfg.seats) {
    if (s.apiKeyEnv && !process.env[s.apiKeyEnv]) out.push(`${s.id}: env var ${s.apiKeyEnv} is not set`);
  }
  return out;
}
