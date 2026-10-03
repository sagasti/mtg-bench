---
name: gameplay-analysis
description: Analyse an mtg-bench run's gameplay per seat with Sonnet agents — recurring mistakes (rules and card misreads, sequencing, combat, mana, mulligans, deckbuilding), combos and synergies attempted or executed, and play tendencies — and publish a comparison page. Use when asked what mistakes agents make, what combos they assemble, or for trends in how a run was played.
---

# Gameplay analysis

Turns one run's logs into a per-seat account of how each agent actually played, with evidence, and a cross-seat
comparison. Analysis runs on Sonnet subagents (one per seat, in parallel); you (the coordinator) verify and synthesise.

## Inputs

- A run dir, e.g. `runs/llm8-lsv-1` (default: the most recent run with LLM seats). It works on a run in progress (it
  covers the matches finished so far) and should be re-run when the event ends.
- Optional: a subset of seats.

## Steps

1. **Build a dossier per LLM seat** (bots have no rationales; skip them):
   `python3 .claude/skills/gameplay-analysis/extract.py <runDir> <seat> <scratch>/ga/<seat>.md`
   The dossier has the deck and builder's rationale, draft picks, and for every game the public Forge log plus each of
   the seat's decisions with what it saw (turn, phase, life, hand, own board, options), its choice, its own rationale,
   invalid answers and forfeits. Repeated identical decisions are collapsed with a count.

2. **Spawn one Sonnet agent per seat, all in one message** (`Agent`, `model: "sonnet"`, `subagent_type:
   "general-purpose"`). Use the prompt below with the seat and dossier path filled in. They only read files; no edits,
   no runs, no API calls.

3. **Check coverage, then verify.** Each review starts with a Coverage line; compare it with the dossier's `## Match`
   headings (`grep -n "^## Match"`). Send a review that skipped matches back to its agent to finish. Then, for each seat, spot-check the two most important claims against the dossier or the
   game log (`<runDir>/games/<match>-g<N>.log`). Drop or correct anything that doesn't hold. Card rules claims are
   checked against the card text in the rendered prompt or Forge's card script (`~/forge-src/forge-gui/res/cardsfolder`).

4. **Synthesise** a cross-seat comparison: the mistake taxonomy as a seat × category table (counts with one example
   each), combos and synergies per seat (attempted vs executed), notable good plays, and patterns shared by several
   models. Separate model mistakes from harness or interface effects (forced/policy actions, provider errors, prompt
   wording): those go in their own section and become tickets in `docs/tickets/`, not model scores.

5. **Publish** the comparison as an artifact page (one page; seats as sections or tabs) and give the user the link and
   a short summary. Save the per-seat write-ups under `<runDir>/analysis/` (git-ignored with the run).

## Per-seat prompt (fill in SEAT, DOSSIER, RUN)

```
You are an expert Magic: The Gathering player and coach reviewing how an AI agent (SEAT) played a cube draft event
(RUN; a powered cube, LSV Cube; best-of-3 matches against other AI agents through the Forge rules engine). Read the
dossier at DOSSIER in full (use Read with offsets; it is long). It contains the agent's deck and deckbuilding rationale,
its draft picks, and for each game Forge's public game log plus every decision the agent made: what it saw (turn,
phase, life totals, its hand and board, the options offered), what it chose, and its own stated rationale. Lines marked
FORFEIT or "invalid answer" are failures to give a legal answer. Read-only: don't edit files or run anything.

Read every line: the dossier is long and its lines are long, so read it in chunks of at most 300 lines with Read's
offset/limit until you reach the end (check the line count first). Start your report with a "Coverage" line listing
every match and game you read; a review that skips matches is incomplete.

Assess the agent's play like a coach writing a review for a student. Be specific and evidence-based: every claim cites
match id, game and turn, and quotes the decision or log line. Judge decisions against the options that were actually
offered and the information the agent had (it never saw the opponent's hand).

Report:
1. Mistakes, grouped by category, most costly first. Categories: card or rules misreads (e.g. ignoring a card's
   drawback), sequencing and mana use (wasted mana, wrong land, casting order), combat (attacks, blocks), resource and
   life management, mulligan and play/draw, deckbuilding and draft (only if visible in play), interface failures
   (invalid answers, forfeits, misunderstanding the option format). For each: what happened, why it was wrong, what
   would have been better, and whether it plausibly changed a game's result. Give a count per category.
2. Combos and synergies: which ones the deck contains, which the agent tried to assemble (cite rationale), which it
   executed, and which it missed when available.
3. Good plays: the 3–5 best decisions, with evidence.
4. Tendencies: style (aggressive, controlling, passive), how its rationales relate to its actual choices (does it do
   what it says?), consistency across games, use of its match notes.
5. A one-paragraph overall assessment and an estimated skill level in human terms (e.g. new player, casual, competent
   club player, strong), with your confidence.
Separate anything that looks like a harness or engine problem rather than the agent's own mistake, and list it at the
end. Don't speculate beyond the evidence; say so when the log doesn't show enough. Keep it under ~1,500 words.
```

## Notes

- Sonnet costs here are Claude usage, not OpenRouter spend.
- A dossier can be large (300–800 KB for a full event); that's expected. If one is too large for an agent, split it by
  match into two dossiers and run two agents for that seat.
