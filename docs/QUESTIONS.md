# Owner questions

Decisions that need the owner. Asked one at a time, interview style; each entry stands on its own. Answers are
recorded here and acted on.

Status: **open** (not asked yet) · **asked** · **answered** (with the answer and what was done).

---

## Q1. Should rank-bot get a new version label now that the bridge fixes changed what it sees?

- **Status:** answered 2026-10-03: **bump it.** Done with Q2 as one change: rank-bot v3 → v4; random v1 → v2 as well
  (its options changed for the same reason; flagged to the owner). Branch `fix/rankbot-v4`.
- **Background:** rank-bot (and random, forge-ai) are fixed reference players. Ratings from different runs are only
  comparable if those references behave the same. Each bot has a version label recorded in every run, and reports
  refuse to pool runs whose labels differ (you can force it).
- **What changed:** rank-bot's code didn't change, but the 2026-10-03 interface fixes changed the options it's offered:
  no more uncastable counterspells, Black Lotus now usable, X capped by mana, a forced keep at an empty hand. So it
  plays differently from the rank-bot in earlier runs.
- **Options:**
  - *Bump the label* (rank-bot human-v2 → human-v3): new runs won't silently pool with old ones.
  - *Keep it*: old and new results can be combined without a warning, even though the bot's play differs.
- **Recommendation:** bump it.

## Q2. Fix rank-bot's hand-size hint after mulligans, as part of the same version change?

- **Status:** answered 2026-10-03: **fix it.** `handSize` is now the actual hand (Forge's London mulligan has already
  put the cards on the bottom when it asks), in both bridges. Conformance baseline re-recorded: rank-vs-rank now keeps
  6-card hands it used to keep only by mistake, so that fixture plays fewer decisions.
- **Background:** when deciding keep or mulligan, rank-bot gets a hint with its hand size. After k mulligans it is told
  7 − 2k cards instead of the real 7 − k, so it mulligans as if its hand were smaller than it is.
- **Options:** fix it now (changes rank-bot's mulligan behaviour, covered by the Q1 label change), or leave it.
- **Recommendation:** fix it together with Q1, so there's one version change, not two.

## Q3. Gemini's empty responses: count a confirmed content-filter block against the model, or as an outage?

- **Status:** open (needs data from the next run)
- **Background:** Gemini (Google AI Studio) sometimes returns an empty answer. Twice this cost a whole match
  (one replayed fine, one was censored). From now on we record Google's own reason for each empty answer
  (MB-051). If the reason is a content filter (e.g. "RECITATION": Google refusing text it thinks reproduces
  copyrighted material, plausibly card text), that's a property of the model's provider, not an outage.
- **Options:** treat filter blocks as the seat failing (counts against Gemini, like a forfeit), or as infrastructure
  (replayed/censored, as now).
- **Recommendation:** decide after the next run shows what the reasons actually are.

## Q4. Reasoning-mandatory models: lowest effort, or the provider's default?

- **Status:** answered 2026-10-03: **per-seat configuration, and treat reasoning as something to test, not fix.**
  Every seat already carries its own settings (`extraBody`, `maxTokens`) and only needs a unique id, so the same model
  can be entered twice at different reasoning effort and play itself (example: `config/reasoning-ab.example.yaml`,
  gpt-5-nano at low vs high, validated with `check`). No single rule for reasoning-mandatory models; each event's config
  says what each seat runs, and the report shows each seat's reasoning tokens. The seat-spec check verifies only
  "reasoning off" (an effort level can't be verified from the response).
- **Background:** five models run with reasoning off. gpt-5-nano, gpt-oss-120b and glm-flash can't turn it off, so they
  run at "low" effort. gpt-5-nano at low effort wrote a 41-word study brief that stopped mid-sentence and built a
  28-land deck; its results may reflect our setting more than the model.
- **Options:** keep "low" (closest to the others), use the provider's default (fairer to those models, but they then
  think more than everyone else), or run them both ways as an ablation.
- **Recommendation:** run gpt-5-nano both ways once (cheap) and decide from the difference.
