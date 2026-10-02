# Evaluation plan (draft for review, 2026-10-02)

> **Status:** reviewed 2026-10-02 (`docs/EVALUATION-PLAN-REVIEW.md`). Revisions are deferred until the full 8-LLM event runs cleanly; the review's top changes (power section, no adaptive stopping, Forge-relative stage scores with several pilots, synthesised cube as headline, pre-registered analysis) are to be folded in then.

What mtg-bench should measure, and how, now that the harness is trustworthy enough to run. This is a proposal: nothing
here is implemented unless it says so. Related: `HANDOFF.md` (status, decisions), `docs/ANALYTICS.md` (ratings),
`docs/DECISION-PROVENANCE.md` (who made each decision), `docs/tickets/` (MB-001..).

## 1. What is measured

Competence of an LLM agent at Magic: The Gathering cube draft: studying an unfamiliar card pool, drafting in an 8-seat
pod, building a 40-card deck, and playing best-of-N matches. Games run in the Forge rules engine; agents see the game
state and legal options and answer through tool calls. Every action not chosen by the agent is attributed (forced,
policy, delegated, forfeit) and reported.

The headline remains an **end-to-end rating** (Bradley-Terry on game outcomes, Elo scale). This plan adds **stage
scores** that explain it, and a set of **experimental conditions** that test what drives it.

## 2. Principle: Magic is noisy; minimise variance by design before adding samples

Observed: two identical Forge AI seats in one pod differed by 330 Elo (`runs/full-llm-1`); per-seat 95% CIs from one pod
are ±200–280 Elo. Draft luck (packs, seat, neighbours), deck strength, and game luck (shuffles, mulligans, play/draw)
all add variance. Methods, roughly in order of value:

1. **Paired comparisons with common random numbers**: compare conditions/models on identical packs, decks, seeds and
   library orders, so luck cancels in differences (`--decks-from`, `--pools-from`, fixed seeds exist).
2. **Duplicate format**: each pair of players plays twice with decks swapped (as in duplicate bridge/poker), cancelling
   deck strength and seat advantage within the pair.
3. **Fixed packs, balanced seating**: draft the same packs under a Williams/Latin-square set of 8 seatings so each model
   drafts from each position with varied neighbours.
4. **Deck quality measured independently**: Forge AI pilots every drafted deck against every other (free).
5. **A model of the noise sources**: estimate player skill and deck strength jointly, with pods as the replication
   unit (bootstrap over pods is implemented, MB-001).
6. **Balance known nuisances by design**: play/draw alternates within a pair; seat positions rotate.
7. **Adaptive allocation**: stop sampling pairs whose intervals separate; spend games on close comparisons.
8. **Remove harness-added noise and bias**: provider errors not scored as misplays, consistent reasoning settings and
   pinned hosts, no hidden turn-skips, errored matches replayed then censored (done 2026-10-02, MB-003..MB-038).

A **noise floor** comes first: 20 all-bot pods (same 8 bots, fresh packs per pod; free, ~1 h) give each bot's
between-pod rating SD, which sizes every experiment below.

## 3. Stage-wise evaluation: one pod, many measurements

Rule: hold a stage's input fixed, vary who performs the stage, and score the output with a yardstick independent of the
agent being judged.

| Stage | Fixed input | Artifact | Score | Cost |
|---|---|---|---|---|
| Cube study | cube list | strategy brief | (a) automatic accuracy: cited cards not in the cube, wrong colours/costs; (b) utility: a fixed reference drafter with vs without the brief, measured by deck quality | (a) free; (b) extra drafts (~$0.35 each) |
| Draft | packs (+ seat) | 45-card pool | pool strength with build and play factored out: a fixed builder (Forge `BoosterDeckBuilder`) builds the pool's deck; Forge AI pilots it vs a gauntlet; optionally pick-level agreement with a reference ranking | free |
| Deckbuild | a pool | 40-card deck | build delta: agent's deck vs fixed builder's deck from the same pool, both Forge-AI-piloted; **cross-build**: every model builds from every pool of the pod | ~$0.10 per pod + free bot games |
| Play | a deck pair | game results | every model pilots every deck (sampled), fitted with player + deck effects; also own-deck vs others'-decks ("fit") | ~$0.08 per LLM-vs-LLM game |

The end-to-end rating stays the headline; stage scores explain it. Forge AI and Forge's deck builder serve as fixed,
free yardsticks independent of the LLMs.

## 4. Experimental conditions (separate experiments)

- **Cube familiarity**: a well-known cube (LSVCube, published pick orders and guides) vs a synthesised cube (generated
  from the union of bundled cubes, balanced by colour/curve, seed-fixed, unpublished, matched power level). The gap
  estimates cube-specific memorisation.
- **Card-name recall**: real names vs aliased names (Forge keeps real names; every prompt surface, tool and log shown to
  the agent uses aliases; leak-checked). Card text stays, so reading is preserved and name-keyed recall is cut. Famous
  rules text remains recognisable, so this is a partial control and is reported as such. Later: perturbed cards (custom
  Forge scripts altering cost/stats of familiar cards).
- These form a 2×2 factorial (cube × names). The headline leaderboard uses real cards on the known/synthesised cube;
  the aliased condition is a diagnostic ("recall premium" per model).
- **Interface ablations** (paired, same decks/seeds): priority stops smart vs all; reasoning on vs off for one model;
  knowledge tier (names only / Oracle text / text + tools); study brief and match notes on/off.
- **Baselines**: Forge AI as a fully Forge-native anchor (its own draft AI and deck builder; profile chosen by a
  round-robin of Forge's four AI profiles: Default, Cautious, Reckless, Experimental; others form a bot population);
  random and rank-bot as floors; a human baseline is not practical at statistical scale (a play-against-an-agent mode is
  planned for fun, outside the leaderboard).

## 5. Proposed programme and cost

Per cell of the 2×2: 8 permuted-seat drafts (~$3), Forge AI evaluation of all 64 decks ($0), cross-build (~$0.80), and
a duplicate round robin on 2 drafts (~$9): about **$13 per cell, ~$50 for all four**, 2–3 days wall-clock (games bound
by ~6 concurrent JVMs). Interface ablations: ~$10–15 on two cheap models. Unit costs are measured from single sanity
games and one event (±50%) for an 8-model lineup of cheap OpenRouter models (DeepSeek V4 Flash, Qwen 3.7 Flash,
gpt-oss-120b, gpt-5-nano, Gemini 2.5 Flash Lite, gpt-6-luna, GLM 5.3 Flash, Mistral Small); game counts will be set
from the noise floor.

## 6. Reporting

Implemented: per-decision provenance, provider-reported cost, per-pod ratings and pod bootstrap, censored/replayed
matches, version provenance (harness/Forge/bridge/card-data hashes), a pre-registration config hash, an exclusion rule
(failure rate > 5%), anchor versioning, a bridge conformance check. Planned: stage scores, condition contrasts with
paired CIs, and a methods section listing every policy that acts for a seat.

## 7. Known limitations

Single engine (Forge) and its AI as anchor; one cube family per condition; LLM sampling is non-deterministic (provider
default temperatures; to be fixed per seat); cheap models only so far; Magic's variance means modest differences need
many games; the harness's interface (smart stops, affordability filter) shapes which decisions exist.
