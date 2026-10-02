# Analytics and token tracking

Every run writes to `runs/<runId>/`:

| File | One row per | Key fields |
|---|---|---|
| `usage.jsonl` | **model API call** | seat, provider, model, phase, kind, requestId, matchId, game, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `latencyMs`, `stopReason`, `httpStatus`, `error` (every failed provider attempt, retried or not), `toolCallsRequested`, `servedBy`, `truncated` (hit the output cap), `timedOut` (aborted by the decision clock), `specViolation` (broke the seat's reasoning/host spec) |
| `decisions.jsonl` | **decision** | the same ids, token totals for the decision, `numOptions`, `choice`, `choiceLabels`, `valid`, `invalidAttempts`, `fallback`, `autoResolved`, `modelCalls`, `toolCalls` by name, `latencyMs`, `rationale`, `error` (why it failed), `forfeit`, `infraError` (the match was abandoned after this row), `timedOut`, `truncated` (calls cut off), `specViolation`, `attempt` (an engine re-ask of the same step). Match notes have phase `between_games`. |
| `draft.jsonl` | draft pick | seat, pack, pick, card taken, full pack contents |
| `matches.jsonl` | match | seats, per-game winner, on-the-play, turns, end reason, decisions per seat, duration, `delegations` (decisions Forge's AI made for an agent), `error` + `errorKind` (abandoned match), `replayOf` (a replay of that errored match) |
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

## Errored matches are replayed once, then censored

A match that ends in an error (`error` set in `matches.jsonl`, with `errorKind`: `infra` provider outage, `timeout` match timeout, `bridge` bridge crash, `harness` a bug in our code) is first **replayed**, unless it was a harness bug: once the round's other matches are done, it is played again from scratch with the same seats, decks and seed, as match `<id>-replay` with `replayOf: <id>`. The replay stands in for the match in standings and ratings. Bots' and the echo provider's random streams have moved on by then, so a replay isn't a re-run of the same games. The errored attempt stays in `matches.jsonl` (its tokens are in the cost tables) but counts nowhere else.

The match timeout is `engine.matchTimeoutSec` if set, else `gamesPerMatch` × `engine.gameTimeoutSec` (default 3600 s: 60 minutes a game, 3 h for best-of-3), so a slow seat's long matches aren't cut off at a fixed 2 h.

A match whose replay errors too, or that hit a harness bug, is **censored**:

- it has no winner (`winner: null`) and awards no Swiss/standings points to either seat (`pod_end` standings list a seat's censored matches);
- it is left out of the ratings at both levels, **including the games it finished**. Errors cut off long matches (control decks, game 3s, the slower provider's seat), so keeping the finished games and dropping the rest would bias the sample;
- its raw games stay in `matches.jsonl`, and `report.md` / `summary.json` list replayed matches, censored matches and the finished games left out, per seat (a pairing whose replay errored counts once as censored).

A seat with many censored matches is rated on a biased sample even so; fix the cause and re-run rather than reading its rating.

## Pods are the replication unit

A seat drafts one deck per pod and plays every game of the pod with it, so its games within a pod are correlated through the deck: identical bots differ by 300+ Elo within one pod. Hence:

- **Bootstrap.** With one pod the 95% CI resamples matches (a cluster is run + match id), which leaves out pod-to-pod variation; don't compare seats on a one-pod CI. With more than one pod (one run with `pods: N`, or several runs merged) it resamples pods with replacement, then matches within each drawn pod; a pod is run + pod index.
- **Per-pod ratings.** report.md ("Ratings by pod") and summary.json (`podRatings`) fit each pod on its own and give each seat's SD between pods. For an all-bot line-up that SD is the noise floor: two seats closer than about two of it can't be told apart by one pod, and pooling N pods shrinks it by roughly √N. Size real events from it.

## Draws

A game that reaches `maxGameTurns` ends as a draw ("Draw (turn cap of N turns)" on the bridge, `turn-cap` on the mock engine). Bradley-Terry scores a drawn game 0.5 for each seat at game level, and a match with equal game wins 0.5 at match level (`rate --level match`); a draw is evidence that the two seats are close, like any other result. Draws aren't dropped, because whether a seat lets games stall is part of its play. The Games section lists turn-cap draws per seat; a seat with many of them is being rated partly on stalled games.

## Seeds and independent replicates

Packs, seating, pairings and match seeds all derive from `event.seed`, each from its own stream (`pod<N>` → `seating`, `draft`, `swiss<R>`, match id), so drawing one never shifts another. Packs are fixed by design: two events with the same cube and seed draft the same packs in the same seats, which suits paired comparisons and replays but makes them one replicate, not two. Give each event of a series its own seed (e.g. base + event index). `pod_start` records `seed` and `draftSeed` (the seed whose packs the pod played; the source's in a `--decks-from` / `--pools-from` run), and `run_start` records each seat's `temperature` when set. `report` and `rate` refuse to pool runs with a pod of the same cube, draft seed and pod index unless given `--allow-same-seed`.

## Anchor versions

The bots only pin the rating scale while they play the same way. A bot's play depends on its policy (`src/agents/bots.ts`) and on the tags the bridge computes for it (option `meta`, request `hints`), and its drafting on the cube (unranked cards score a flat 0.3). So each bot seat's anchor version is recorded in `run_start.anchors`, e.g. `rank-bot@human-v2`: provider, the path that feeds it tags (`mock`, or the Forge controller `human` / `ai`) and the policy version in `BOT_VERSIONS` (bots.ts). **Bump a bot's version whenever bots.ts changes its policy or the bridge changes the tags it reads** (`InputDriver.botTags`, the attack/block hints, `PlayerControllerExternal`). report.md lists the anchors under "Versions".

`report` and `rate` refuse to pool runs whose anchors differ (a bot provider with two versions, counting runs from before anchors were recorded as `unrecorded`) or that were played on different cubes, unless given `--allow-anchor-changes`. forge-ai's play is Forge's own AI, so a Forge bump changes it too: run the conformance check (`bench conformance`) and bump `forge-ai` when it reports a change.

## report.md sections

A run without `run_end` in `events.jsonl`, or with a pod that has `pod_start` but no `pod_end`, stopped early: the report opens with **INCOMPLETE** and `summary.json` lists the reasons under `incomplete`.

1. **Ratings**: Bradley-Terry fit over all games of uncensored matches, Elo scale, 95% bootstrap CI (resampling pods, then matches within them, when there is more than one pod; otherwise whole matches; a cluster is run + match id, so merged runs never share one). With several pods, **Ratings by pod** follows: each pod's own fit and each seat's SD between pods. Censored matches per seat follow the table.
2. **Token usage and cost by seat**: decisions, calls, each token type, tokens/decision, cost, p50/p95 decision latency. Tokens, calls and cost are summed from `usage.jsonl`, so the calls of a decision that ended in an infrastructure error (which has no decision row) still count; the report says how many such calls there were. Decision counts, validity and latency come from `decisions.jsonl`.
3. **By seat × phase**: study / draft / deckbuild / game split of tokens and cost.
4. **By decision kind**: average tokens, invalid answers and fallbacks per kind (e.g. are blockers expensive? do models flub targets?).
5. **Reliability and tool use**: invalid answers, forfeits (a timed-out decision is a forfeit, labelled "timed out" in the forfeit table), bridge re-asks (`attempt > 0` rows: the same in-game step asked again, not a new decision), fallback rate, API errors, truncated calls (stopped at the output-token limit) as a share of calls, decisions abandoned by an infrastructure error (`infraError`; not counted as the agent's anywhere), knowledge-tool calls by tool. Seats whose calls or decisions carry `specViolation` (outside their pinned reasoning regime or host) are listed under **SPEC VIOLATIONS** at the top of the report.
6. **Decisions made by Forge AI on an agent's behalf**: count per seat, share of that seat's game decisions, and the most common kinds with reasons.
7. **Games**: average length, on-the-play win rate, end reasons, turn-cap draws per seat, failed matches.

## Commands

```bash
npm run bench -- report runs/<run>                     # rebuild report.md for a run
npm run bench -- report runs/a runs/b runs/c           # merged report across runs
npm run bench -- report runs/a runs/b --allow-same-seed  # merge runs that drafted the same packs (not independent)
npm run bench -- report runs/a runs/b --allow-anchor-changes  # merge runs whose bot anchors or cube differ (not one scale)
npm run bench -- rate runs/a runs/b --level match      # ratings from match wins instead of games
npm run bench -- rate runs/* --anchor random=1000      # pin a seat's rating
```

The JSONL files are plain data, so any notebook can load them directly, e.g. `pd.read_json("usage.jsonl", lines=True)`.
