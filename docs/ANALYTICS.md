# Analytics and token tracking

Every run writes to `runs/<runId>/`:

| File | One row per | Key fields |
|---|---|---|
| `usage.jsonl` | **model API call** | seat, provider, model, phase, kind, requestId, matchId, game, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `latencyMs`, `stopReason`, `httpStatus`, `error`, `toolCallsRequested` |
| `decisions.jsonl` | **decision** | the same ids, token totals for the decision, `numOptions`, `choice`, `choiceLabels`, `valid`, `invalidAttempts`, `fallback`, `autoResolved`, `modelCalls`, `toolCalls` by name, `latencyMs`, `rationale`, `error` |
| `draft.jsonl` | draft pick | seat, pack, pick, card taken, full pack contents |
| `matches.jsonl` | match | seats, per-game winner, on-the-play, turns, end reason, decisions per seat, duration, `delegations` (decisions Forge's AI made for an agent) |
| `events.jsonl` | run/pod milestone | seating, standings, cube size, seeds; `run_start.provenance`: harness commit (+ uncommitted-changes flag), engine, Forge commit (else jar name), bridge jar SHA-256, `cards.json` and rankings-file SHA-256 (also in `config.json`, and in report.md under "Versions") |
| `pod<N>/decks/*.dck, *.json` | deck | main deck, sideboard, basics |
| `prep/<seat>.md` | seat | cube-study brief |
| `forge-logs/<match>.log` | match | JVM output (Forge engine only) |
| `ratings.json`, `summary.json`, `report.md` | run | aggregates (below) |

## Token accounting per provider

| Provider | input | cacheRead | cacheWrite | output | reasoning |
|---|---|---|---|---|---|
| Anthropic | `input_tokens` (uncached) | `cache_read_input_tokens` | `cache_creation_input_tokens` | `output_tokens` (includes thinking) | not split out (0) |
| OpenAI-compatible | `prompt_tokens − cached_tokens` | `prompt_tokens_details.cached_tokens` | 0 | `completion_tokens` | `completion_tokens_details.reasoning_tokens` (a subset of output) |

Cost = input·price.input + output·price.output + cacheRead·price.cacheRead + cacheWrite·price.cacheWrite, using the `pricing` block in the config (USD per 1M tokens, keyed by model id). A missing cache price defaults to 0.1× (read) or 1.25× (write) the input price. Models without a pricing entry show `n/a`, but their token counts are still recorded.

Decisions with exactly one legal answer are **auto-resolved** and never sent to a model. They're counted separately, so tokens-per-decision reflects real choices only.

## Errored matches are censored

A match that ends in an error (`error` set in `matches.jsonl`: match timeout, bridge crash, provider outage, harness error) is **censored**:

- it has no winner (`winner: null`) and awards no Swiss/standings points to either seat (`pod_end` standings list a seat's censored matches);
- it is left out of the ratings at both levels, **including the games it finished**. Errors cut off long matches (control decks, game 3s, the slower provider's seat), so keeping the finished games and dropping the rest would bias the sample;
- its raw games stay in `matches.jsonl`, and `report.md` / `summary.json` list censored matches and the finished games left out, per seat.

A seat with many censored matches is rated on a biased sample even so; fix the cause and re-run rather than reading its rating.

## Seeds and independent replicates

Packs, seating, pairings and match seeds all derive from `event.seed`, each from its own stream (`pod<N>` → `seating`, `draft`, `swiss<R>`, match id), so drawing one never shifts another. Packs are fixed by design: two events with the same cube and seed draft the same packs in the same seats, which suits paired comparisons and replays but makes them one replicate, not two. Give each event of a series its own seed (e.g. base + event index). `pod_start` records `seed` and `draftSeed` (the seed whose packs the pod played; the source's in a `--decks-from` / `--pools-from` run), and `run_start` records each seat's `temperature` when set. `report` and `rate` refuse to pool runs with a pod of the same cube, draft seed and pod index unless given `--allow-same-seed`.

## report.md sections

A run without `run_end` in `events.jsonl`, or with a pod that has `pod_start` but no `pod_end`, stopped early: the report opens with **INCOMPLETE** and `summary.json` lists the reasons under `incomplete`.

1. **Ratings**: Bradley-Terry fit over all games of uncensored matches, Elo scale, 95% bootstrap CI (resampling whole matches; a cluster is run + match id, so merged runs never share one). Censored matches per seat follow the table.
2. **Token usage and cost by seat**: decisions, calls, each token type, tokens/decision, cost, p50/p95 decision latency.
3. **By seat × phase**: study / draft / deckbuild / game split of tokens and cost.
4. **By decision kind**: average tokens, invalid answers and fallbacks per kind (e.g. are blockers expensive? do models flub targets?).
5. **Reliability and tool use**: invalid answers, fallback rate, API errors, knowledge-tool calls by tool.
6. **Decisions made by Forge AI on an agent's behalf**: count per seat, share of that seat's game decisions, and the most common kinds with reasons.
7. **Games**: average length, on-the-play win rate, end reasons, failed matches.

## Commands

```bash
npm run bench -- report runs/<run>                     # rebuild report.md for a run
npm run bench -- report runs/a runs/b runs/c           # merged report across runs
npm run bench -- report runs/a runs/b --allow-same-seed  # merge runs that drafted the same packs (not independent)
npm run bench -- rate runs/a runs/b --level match      # ratings from match wins instead of games
npm run bench -- rate runs/* --anchor random=1000      # pin a seat's rating
```

The JSONL files are plain data, so any notebook can load them directly, e.g. `pd.read_json("usage.jsonl", lines=True)`.
