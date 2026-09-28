# Prompts, knowledge levels and cube study

Everything an agent is told lives in versioned files under `prompts/<version>/`. The version is set by `event.promptVersion`, and each run copies the prompts it used into `runs/<run>/prompts/`. Changing a prompt means creating a new version folder: results from different prompt versions are **not** comparable.

## How a decision is presented

Each decision is a single, fresh conversation. The model gets no chat history. Continuity comes only from the explicit, logged channels described below.

**System prompt** (identical for every decision within a phase, so providers can cache it):
1. `system.md`: role, format, how to answer, and "you only see legal information".
2. The knowledge block for the event's knowledge level (below).
3. `notes.md`: an explanation of the scratchpad (if `carryNotes`).
4. `primer.md`: the rules primer (only at level `oracle+tools+primer`).
5. The phase section: `draft.md`, `deckbuild.md` or `game.md`.
6. The seat's own cube-study brief (if `cubeStudy`; shown during the draft only, or throughout if `briefScope: all`).

**User message** (rendered by `src/agents/render.ts`):
```
# Decision: priority
You have priority. Play a land, cast a spell, activate an ability, or pass.

## Your notes           ← the seat's own scratchpad from its previous decision in this scope
## State                ← player-filtered game/draft state as YAML
## Options
- [pass] Pass priority (move to the next step)
- [sa2] Cast Lightning Bolt (R)
Choose exactly 1 option. Answer with the submit_decision tool.
## Card reference       ← oracle text of every non-basic card mentioned above (levels oracle+)
```

The agent answers with `submit_decision({choice: [ids], rationale?, notes?, basics?})`. Only ids that appear in the list are accepted, so illegal moves are impossible by construction. How the agent *chooses* is what gets measured, not whether it can generate legal moves.

## Knowledge levels (`event.knowledge`)

| Level | Card text | Tools | Rules primer |
|---|---|---|---|
| `names` | none (names only; tests memorised knowledge; prone to contamination) | – | – |
| `oracle` | inline "Card reference" for every card in the decision | – | – |
| `oracle+tools` | inline | `lookup_card`, `search_cube`, `search_rules` | – |
| `oracle+tools+primer` (recommended) | inline | same | ~900-token summary of turn structure, priority, the stack, combat, common keywords |

**Oracle text source.** It comes from Forge's own card scripts, so it's the exact text the engine implements, including all faces of double-faced, split and modal cards.

**The tools.** All are limited to `maxToolCallsPerDecision` knowledge calls per decision, the same for every seat, and every call is logged.
- `lookup_card(name)`: full text of any card.
- `search_cube(text?, colors?, type?, max_cmc?)`: searches the cube's card list (up to 30 results). This lets agents read signals or ask what tricks an opponent might have. The cube's *name* is never exposed.
- `search_rules(query)`: searches the Comprehensive Rules, by rule number (`702.19`, which returns the rule and its subrules) or by keywords (TF-IDF ranked, glossary included). Needs `data/MagicCompRules.txt` (see `data/README.md`).

## Cube study (`event.cubeStudy`)

Before pod 1, every LLM seat gets one conversation containing the full card list of the cube (with oracle text unless the level is `names`). It writes a strategy brief of at most `briefMaxWords` words covering archetypes, colour depth, key cards, pick priorities and signals, and submits it with `submit_brief`. It has the same tools as in the draft, with double the budget.

- Each seat writes **its own** brief, so the brief is part of what's being measured. A weak plan hurts that seat.
- The brief is saved to `runs/<run>/prep/<seat>.md` and reused for every pod in the run.
- It's placed in the system prompt, so it's cached and cheap per pick.
- Token cost is logged as phase `study`.
- To measure its value, run the same line-up with `cubeStudy: false` as a separate event and compare the ratings.

Caveat: well-known cubes have published archetype guides, so a brief partly measures memory. Less-known or custom cubes reduce that.

## Continuity channels

| Channel | Scope | Written by |
|---|---|---|
| `notes` scratchpad | draft + deckbuild share one scope per pod; each match has its own scope | the agent, via `submit_decision.notes` (replaces the previous notes) |
| cube-study brief | whole run | the agent, once before the draft |
| `recentLog` in game state | current game | the engine (public events only) |

There is no hidden memory. If an agent wants to remember that the opponent played two Counterspells in game 1, it has to write that in its notes.

## Anti-leak rules

- The cube name and event name are not template variables, and `assertNoLeak` makes an agent call fail if either appears anywhere in a prompt.
- Deck files sent to Forge are named `Deck`. Players are `P1`/`P2` and "you"/"opponent".
- Bot-only hints (`meta` on options) are never rendered into LLM prompts.
