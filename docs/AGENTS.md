# Defining the 8 agent slots

An event always has exactly **8 seats**, the size of a real draft pod. Each seat is one entry under `seats:` in your event YAML, and each seat is one competitor in the ratings. Seats can be LLMs from any provider or one of the built-in reference bots.

```yaml
seats:
  - id: claude-opus            # required, unique, stable across runs (it's the name in the ratings)
    provider: anthropic        # required, see "Providers" below
    model: claude-opus-5-5     # required for LLM providers, exact API model id
    apiKeyEnv: ANTHROPIC_API_KEY   # required for LLM providers, NAME of the env var holding the key
    maxTokens: 4096            # optional, max output tokens per call, reasoning included (default 4096 with reasoning off, else 16384)
    temperature: 0.7           # optional (ignored when thinkingBudget is set)
    thinkingBudget: 4000       # optional, Anthropic extended thinking budget in tokens
    reasoningEffort: medium    # optional, OpenAI-style reasoning effort
    baseUrl: https://…         # optional, override the endpoint (proxies, self-hosted servers)
    headers: { X-Foo: bar }    # optional, extra HTTP headers
    extraBody: { top_p: 0.9 }  # optional, merged into every request body (provider-specific knobs)
    label: "Opus (thinking)"   # optional, display name
    concurrency: 2             # optional, max model calls in flight for this seat (rate-limit guard; default no limit)
    maxSpendUsd: 50            # optional, stop the seat once its computed cost reaches this (needs a pricing entry)
    maxP95LatencySec: 60       # optional, stop the seat once its p95 decision latency exceeds this (after 20 decisions)
    backupProviders: [deepinfra]   # optional, openrouter only: backup host slugs, used only after the primary host fails
```

**Backup hosts (`backupProviders`, OpenRouter only).** A seat pins its host with `extraBody.provider.order` and
`allow_fallbacks: false`, which keeps host and quantisation constant but makes the host's outages the seat's. A seat may
list backup host slugs serving the same model and quantisation (check each on the model's OpenRouter page and with
`check --ping` against a copy of the seat). Within a call, after two consecutive failures on a host the next host in
the list is tried, pinned alone without fallbacks; a host failed over from is skipped by new calls for 5 minutes, then
the primary is tried first again. The retry window covers all hosts of a call. Backup hosts pass the seat-spec check;
`servedBy` records who answered each call, and the report flags any seat served by more than one host.

**Budgets stop a seat, not the run.** Once a seat reaches `maxSpendUsd` (tokens × `pricing`, counted from the run's start) or its p95 decision latency exceeds `maxP95LatencySec`, it stays stopped: each of its remaining matches is recorded as not played (`notPlayed` in `matches.jsonl`; no games, no result for either seat, no forfeit) and the rest of the event goes on. Later draft picks and deckbuilds in other pods are rank-bot fallbacks so the pod can still draft. The check runs before each match and each decision outside games, so a match already under way finishes: a seat can overshoot by about one match's cost. report.md lists the matches not played per seat and why.

**Reasoning and host are part of the seat's spec.** Reasoning counts as disabled when `extraBody.reasoning` has
`enabled: false`, `max_tokens: 0` or `effort: "none"` (or `reasoningEffort: none`, or Anthropic without
`thinkingBudget`). Every call is checked: reasoning tokens on a seat with reasoning disabled, or a `servedBy` host
outside a pinned `extraBody.provider.order` (and the seat's `backupProviders`) with `allow_fallbacks: false`, logs a warning (once per seat) and marks the
call and its decision with `specViolation`. `check --ping` runs the same check on one call per seat.

## API keys

Keys are **never** written into the config. A seat names an environment variable (`apiKeyEnv`), and the harness reads the key from the environment at run time. The config validator rejects any seat that has an `apiKey:` field.

1. `cp .env.example .env` and fill in the keys you need (`.env` is git-ignored), **or** export them in your shell.
2. Several seats can share one variable, e.g. two Anthropic models both using `ANTHROPIC_API_KEY`.
3. To run the same provider under separate billing accounts, use different variable names (`ANTHROPIC_API_KEY_TEAM_B`).
4. `npm run bench -- check config/my.yaml` lists any missing variables. `… check config/my.yaml --ping` sends each LLM seat one tiny request, which confirms the key, the model id and tool calling all work.

The run folder's `config.json` snapshot contains only variable names, so it's safe to share.

## Providers

| `provider` | What it is | Needs |
|---|---|---|
| `anthropic` | Anthropic Messages API. Uses tool use and prompt caching (system prompt and tools are cached). `thinkingBudget` turns on extended thinking. | `model`, `apiKeyEnv` |
| `openai` | OpenAI Chat Completions with function calling. | `model`, `apiKeyEnv` |
| `openrouter` | Any model on OpenRouter (OpenAI-compatible; base URL preset). | `model` (e.g. `vendor/model`), `apiKeyEnv` |
| `gemini` | Google's OpenAI-compatible Gemini endpoint (base URL preset). | `model`, `apiKeyEnv` |
| `openai` + `baseUrl` | **Any** OpenAI-compatible server: vLLM, Ollama (`http://localhost:11434/v1`), LM Studio, Together, xAI, etc. Omit `apiKeyEnv` for servers without auth. | `model`, `baseUrl` |
| `forge-ai` | Reference anchor. **Forge's built-in AI plays its games**; it drafts and builds like `rank-bot`. | nothing |
| `rank-bot` | Reference anchor. Drafts by CubeCobra rank with colour commitment, builds a 2-colour 23-spell/17-land deck, and plays greedily. | nothing |
| `random` | Floor anchor. Uniformly random legal choices. | nothing |
| `echo` | Offline stand-in for an LLM. It goes through the full prompt, tool-loop, validation and analytics path but answers randomly, and estimates tokens as characters ÷ 4. Use it to smoke-test a config for free. | nothing |

Every LLM must support **tool/function calling**. Answers are submitted through a `submit_decision` tool. A model that replies in prose gets one nudge, and the harness also tries to pull a JSON answer out of the text.

## Recommended line-ups

- **Comparing 5 LLMs:** 5 LLM seats plus `forge-ai`, `rank-bot` and `random` as anchors. The anchors cost nothing and pin the rating scale across runs, but only while the anchors themselves don't change: each bot seat records an anchor version (`rank-bot@human-v2`; docs/ANALYTICS.md "Anchor versions"), and runs with different anchor versions or cubes aren't pooled.
- **Comparing 8 LLMs:** allowed, but keep at least one anchor in some pods (e.g. alternate line-ups across runs) so ratings stay anchored.
- **Ablations:** the same model can take several seats with different settings, e.g. `opus-think` (with `thinkingBudget`) vs `opus-nothink`. Seat ids must differ. Cube study and knowledge level are per-event settings, not per-seat, so run those comparisons as separate events.

## What every seat shares (fairness)

These are event-level settings and cannot be set per seat: knowledge level, tools and the per-decision tool budget, retry limit, timeout, notes, cube study, and prompt version. Seating is reshuffled every pod (`rotateSeats`), so no model always sits next to the same neighbour.

Agents never see:
- the cube's name or the event name (a hard check fails the call if either appears in a prompt),
- who their opponent is (players are "P1"/"P2" and "you"/"opponent"),
- which model sits to their left or right in the draft,
- hidden information: the opponent's hand, library order, face-down cards, the next packs.

## When an agent fails

There are two kinds of substitution, and both are reported:
- **Fallback** (harness): the model didn't produce a valid answer, so `rank-bot`'s choice is used. It's shown per seat in the report's reliability table.
- **Delegated** (Forge): Forge's own AI decided, either because the answer was rejected inside the engine (e.g. an illegal block) or because it's one of the few decision types not yet offered to agents. It's shown in its own report section.

Per decision the harness validates the answer. An illegal answer (including a malformed `choice` or unparseable tool arguments) is sent back with the reason ("unknown option id …") and the agent may try again, up to `maxRetries`. After that, or when the decision's time budget (`decisionTimeoutSec`) runs out, the decision is forfeited: the null action in games, `rank-bot`'s deck in deckbuilding. The decision row keeps the reason in `error`.

The time budget works like a chess clock: it counts the model's time only. Provider failures are not the agent's: 429, 408, 529, 5xx, network errors and in-body errors (HTTP 200 with an `error` object, `finish_reason: "error"`, or an empty answer with no output tokens) are retried with exponential backoff from 2 s, capped at 60 s, honouring `Retry-After` (capped at 60 s too); the clock is paused while backing off and doesn't count failed attempts. Transient failures (429, 408, 529, 5xx, network errors, in-body errors whose code is one of those or that say the host is unavailable or rate-limited, such as OpenRouter's 502 "JSON error injected into SSE stream" / `provider_unavailable`, and `finish_reason: "error"` unless the model's own `native_finish_reason` is a content block) are waited out for up to `event.providerRetryWindowSec` (default 1200 s = 20 min) from the call's first failure. Other in-body failures, an empty answer above all, may be deterministic (a content filter such as Gemini's `RECITATION`), so they get 7 attempts. A provider still failing after that abandons the match as an infrastructure error (replayed once at the end of the pod's schedule). Every failed attempt is a usage row with `error`, `nativeFinishReason` and `providerError` where the provider sent them. An answer cut off by the output cap (`length` / `max_tokens`) is asked again once with twice the cap (up to 32768) and marked `truncated`. An exception inside the harness (rendering, templates, the prompt-leak guard) abandons the match as a harness error rather than counting as a forfeit.

An abandoned match that wasn't a harness bug (provider failure, match timeout, bridge crash) is replayed once from scratch, same decks and seed, at the end of its round; if the replay fails too it is censored (docs/ANALYTICS.md). The match timeout is `engine.matchTimeoutSec` if set, else `gamesPerMatch` × `engine.gameTimeoutSec` (default 3600 s, i.e. 60 minutes a game: 3 h for best-of-3). Raise `gameTimeoutSec` for slow seats (reasoning models, two LLMs in one match) rather than letting their long matches be cut off.

## Cost planning

Rough call counts per pod, with `round-robin` and best-of-3:

| Phase | Decisions per LLM seat |
|---|---|
| Cube study | 1 conversation (the whole card list, about 15–40k input tokens; once per run, reused across pods) |
| Draft | 45 picks (the last pick of each pack is automatic) |
| Deckbuild | 1 |
| Games | 7 matches × about 2.5 games × **N** decisions per game |

N depends on the engine. In the mock engine it's about 60. In Forge, agents now make every sub-decision (targets, X, modes, which lands to tap, damage assignment, scry…) and ordering questions are asked one pick at a time, so expect roughly 100–250 per game with smart priority stops and smart mana payment. Run one pod with a single LLM seat first and read `report.md`: *Tokens/decision* and *Tokens by seat × phase* will give you a real per-pod cost before you scale up `pods`.
