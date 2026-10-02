# Handoff: get mtg-bench running against real Forge

**For:** a coding agent working on the owner's dev machine.
**Goal:** take this harness from "tested against a mock engine" to "real Forge games, with real LLM seats, producing a trustworthy report".

Read this file first. Then read `README.md`, and `docs/FORGE_SETUP.md` (the runbook these steps follow). Read the other docs when a step needs them.

---

## 1. What this project is

mtg-bench is a benchmark. Eight AI agents cube-draft Magic: The Gathering, build decks and play each other. Ratings are computed from the results, along with token and cost analytics.

- **Harness:** Node and TypeScript, in `src/`. It runs the cube study, the draft, deckbuilding, round robin (or Swiss) matches, Bradley-Terry ratings and the analytics report. LLM seats can be Anthropic, OpenAI, Gemini, OpenRouter or any OpenAI-compatible server. There are also built-in bots: `forge-ai`, `rank-bot`, `random`, and `echo`, which is an offline stand-in for an LLM.
- **Engine:** [Forge](https://github.com/Card-Forge/forge), a Java Magic rules engine. The harness spawns one JVM per match. The **bridge** (`bridge/src/forge/bridge/*.java`) runs inside that JVM. It connects back to the harness over a localhost TCP socket and sends every player decision as JSON (`docs/PROTOCOL.md`).
- **Mock engine:** `src/engine/mock/`, a deliberately simplified rules engine used only to test the pipeline. Never report its results.

### Design decisions already made (don't undo without asking the owner)
- **Exactly 8 seats** per pod. API keys come only from env vars (`apiKeyEnv`); configs never contain keys.
- **Round robin** is the default format (7 rounds per pod), best-of-3.
- **Knowledge level** is set per event, the same for every seat: `names | oracle | oracle+tools | oracle+tools+primer` (default). Prompts are versioned under `prompts/v1/`. Changing a prompt means creating a new version folder, never editing v1 in place.
- **Agents never see** the cube's name, the event name, their opponent's identity, or hidden information. `assertNoLeak` in `src/agents/llm.ts` enforces the names part. Bot-only hints (`meta`, `hints`) are never rendered into LLM prompts.
- **Cube study:** before the draft, each LLM seat writes its own strategy brief, which is shown in its system prompt.
- **Agents make every game decision.** Agent casts go through Forge's generic `PlaySpellAbility` path, so the agent chooses optional costs, X, modes, targets (including spells on the stack), divided damage, cost payments and which lands to tap. It also handles combat damage assignment, scry/surveil, trigger order and so on. Anything Forge's AI decides for an agent is reported as **delegated** and shown per seat in `report.md`.

---

## 2. Current state

| Part | Status |
|---|---|
| Harness (draft, deckbuild, round robin/Swiss, ratings, analytics, report) | ✅ Runs end to end on the mock engine (`config/smoke.mock.yaml`) |
| Node side of the Forge protocol | ✅ Tested against a fake bridge process that speaks the wire format |
| Java bridge | ✅ Built with `bridge/build.sh` against Forge at commit `2ccbbb01326e28b38788c50f7f0e01b5d12f32b3` (2026-09-28, `2.0.15-SNAPSHOT`). Default path: Forge's human controller driven headlessly (`AgentGuiGame` + `InputDriver`, `docs/SPIKE-remote-human.md`); validated on 8-bot round robins (human-bots-9: 28/28, no errors, no engine exceptions, nothing delegated) and LLM matches (human-llm-1). The older `PlayerControllerExternal` path (`engine.controller: ai`) still works and is slated for removal. |
| Real LLM seats | ✅ DeepSeek V4 Flash via OpenRouter (`config/forge-1llm.yaml`), used for iteration; cost is recorded as reported by the provider. |
| `data/MagicCompRules.txt` | ❌ Missing. Download it (see `data/README.md`). |

**Historical: the list below was the risk list for the original `PlayerControllerExternal` bridge.** It applies only with `engine.controller: ai`; the human-controller path lets Forge validate every action itself (see `docs/SPIKE-remote-human.md` for its own trouble spots: nested mana payments, the input latch, the EDT).
1. `PlayerControllerExternal.playChosenSpellAbility` → `PlaySpellAbility.playSpellAbility(this, …)`. This is Forge's human casting path, driven by a controller that still extends `PlayerControllerAi` (so `isAI()` is true). Watch for game code that branches on `isAI()` or casts the controller to `PlayerControllerHuman`.
2. `payManaCost`. The agent picks the sources, and every other source is temporarily put into `AiCardMemory.MemorySet.HELD_MANA_SOURCES_FOR_NEXT_SPELL`, so the AI payer won't use them. Check that the payer really respects this and that the reservations are released afterwards.
3. `orderAndPlaySimultaneousSa` and `playTrigger`, which were rewritten to follow the human controller. Check trigger ordering and that targeted triggers get their targets.
4. `assignCombatDamage`: a `null` map key means damage to the defending player. The code assumes modern rules (no damage assignment order).
5. `StateView`: the hidden-information filtering and the public-log whitelist.
6. Turn cap: `game.setGameOver(GameEndReason.Draw)` is called from inside a controller callback.

---

## 3. Tasks, in order (each has a "done when")

### T0. Prerequisites
Java 17+, Node 20+, git, `unzip`. About 2 GB of disk for Forge.
**Done when** `java -version` and `node -v` both work.

### T1. Install the harness
```bash
cd mtg-bench && npm install
```
**Done when:** `npm run typecheck` passes.

### T2. Get Forge
Prefer building from source at the commit the bridge was checked against, so the APIs match:
```bash
git clone https://github.com/Card-Forge/forge.git ~/forge-src
cd ~/forge-src && git checkout 2ccbbb01326e28b38788c50f7f0e01b5d12f32b3
mvn -pl forge-gui-desktop -am -DskipTests package
```
Alternatively, use a release build (`forge-gui-desktop-<ver>.tar.bz2` from GitHub Releases) unpacked to `~/forge`, if the source build is a problem. A newer Forge may need small bridge fixes.

Sanity check: run one AI-vs-AI game headless with Forge's own `sim` mode (`java -jar <jar> sim -d <deck1.dck> <deck2.dck> -n 1 -q`, run from the directory containing `res/`).
**Done when** a game result prints.

### T3. Card data, cube, rules
```bash
npm run bench -- cards index --forge-res <forge>/res        # source checkout: ~/forge-src/forge-gui/res
npm run bench -- cubes --forge-res <forge>/res
```
Save the Comprehensive Rules TXT as `data/MagicCompRules.txt` (`data/README.md`).
**Done when** `cards.json` holds about 34k cards and the default cube (`Adam Styborkski's Pauper Cube`, 395 cards) is listed.

### T4. Build the bridge
```bash
bridge/build.sh <path to forge-gui-desktop-*-jar-with-dependencies.jar>
```
**Done when** `bridge/build/mtg-bench-bridge.jar` exists. If javac fails, fix the bridge to match the Forge APIs. Keep the behaviour described in the class comments.

### T5. Mock smoke test (no Forge, no keys)
```bash
npm run bench -- run config/smoke.mock.yaml --forge-res <forge>/res --run-id smoke-mock
```
**Done when** it finishes and writes `runs/smoke-mock/report.md`.

#### Re-running from saved state
A finished run can seed a new one, so the expensive early stages (study, draft, deckbuild) don't have to be repeated to replay the matches or try a different engine setting:
```bash
npm run bench -- run <config.yaml> --decks-from runs/<source>   # seating + decks from the source; only the matches are played
npm run bench -- run <config.yaml> --pools-from runs/<source>   # seating + drafted pools from the source; deckbuild and matches are played
```
Both reuse the source's seating (`events.jsonl` `pod_start`) and, for LLM seats, the study brief (`prep/<seat>.md`) and the pod scratchpad (`pod<N>/notes/<seat>.md`, written after the draft and again after deckbuild, so it holds the seat's latest notes). Decks come from `pod<N>/decks/<seat>.json`; pools are rebuilt from the `pick` rows in `draft.jsonl`. The config's seat ids must match the source's. Match seeds come from the new config's `seed`; the new run gets its own run dir, records `source: { runDir, mode }` in `config.json` and the `run_start` event, and never writes to the source.

### T6. Forge with bots only (the important one, and free)
Edit `config/forge-bots.yaml`: set `engine.forgeDir`, plus `forgeRes` if needed. Then:
```bash
npm run bench -- check config/forge-bots.yaml
npm run bench -- run config/forge-bots.yaml --run-id forge-bots --verbose
```
Here `rank-bot`, `random` and `echo` all play **through the bridge**, which exercises every decision type.
**Done when:**
- all 28 matches complete, with no `error` in `matches.jsonl` and no Java exceptions in `runs/forge-bots/forge-logs/*.log`;
- in `report.md`, the delegated section shows **no `no valid answer` delegations for bot seats**. Bots always answer from the option list, so any such entry is a bridge bug. A few rare-type delegations (e.g. `name_a_card`) are fine;
- games end mostly by life loss (`LifeReachedZero`), not by the turn cap or errors;
- spot-check `decisions.jsonl`: target, mana_payment, assign_damage, scry and similar decisions appear and their `choiceLabels` make sense.

Debugging tip: if one match keeps failing, re-run with `event.parallelMatches: 1` and read its forge log. A `bench match` command that plays a single match between two saved decks would speed this up. Feel free to add one in `src/cli.ts`.

### T7. One real LLM seat
Fill `.env` (`cp .env.example .env`), then:
```bash
npm run bench -- check config/forge-1llm.yaml --ping
npm run bench -- run config/forge-1llm.yaml --run-id forge-1llm
```
Add that model's prices to `pricing:` in the config first; get them from the provider's pricing page, and don't guess.
**Done when:**
- the run completes;
- the LLM seat's fallback rate is under about 2% and its delegated share under about 2%;
- you report **tokens per decision, decisions per game, and cost per pod** from `report.md`;
- you've read about 10 rendered prompts and answers end to end (the `decisions.jsonl` rows plus the prompt text) and confirmed the state, options and card reference make sense to a human player.

### T8. Hand back to the owner
Write a short report: what you changed and why, the T6/T7 numbers, and anything that still looks wrong. **Stop there.** The full 8-model event (`config/event.example.yaml`) costs real money, and the owner decides when to run it and which models to use.

---

## 4. Ground rules
- Don't commit `.env`, API keys, `data/cards.json`, `data/MagicCompRules.txt` or `runs/` (they're already in `.gitignore`).
- Don't edit `prompts/v1/*` in place. If a prompt must change, copy it to `prompts/v2/` and point `event.promptVersion` at v2.
- Keep the fairness rules in section 1 intact, and run `npm run typecheck` after TypeScript changes.
- Commit in small steps with clear messages. If the repo has no remote, ask the owner where to push.
- If something needs a design decision (e.g. the rules engine can't support a decision type, or costs look far higher than expected), stop and ask the owner rather than choosing yourself.

## 5. Map of the code
```
src/cli.ts                    commands: cards index | cubes | check | run | report | rate
src/config.ts                 event YAML schema + validation (8 seats, knowledge, format, mana/priority options)
src/types.ts                  DecisionRequest/Response contract + validation
src/agents/agent.ts           Seat wrapper: auto-resolve, validation, fallback, notes, analytics
src/agents/llm.ts             LLM tool-use loop, cube study, leak guard
src/agents/render.ts          prompt rendering (state YAML, options, card reference)
src/agents/providers/         anthropic.ts, openai.ts (OpenAI-compatible), echo.ts
src/agents/bots.ts            random / rank-bot / forge-ai drafting+building policies
src/knowledge/                lookup_card / search_cube / search_rules tools, CR index
src/draft/ src/deckbuild/     draft (3×15, passing) and deckbuilding
src/tournament/               run.ts (event loop), resume.ts (--decks-from / --pools-from), schedule.ts (round robin / Swiss)
src/engine/forge/forge.ts     spawns the bridge JVM, TCP protocol, delegation capture
src/engine/mock/mock.ts       simplified engine (testing only)
src/analytics/                recorder.ts (JSONL), report.ts (report.md / summary.json)
src/rating/                   Bradley-Terry + bootstrap CIs
bridge/src/forge/bridge/      AgentBridge (main), PlayerControllerExternal (all decisions),
                              AgentCostDecision (cost choices), StateView (player-filtered state),
                              BridgeClient (socket), LobbyPlayerExternal, MatchContext
prompts/v1/                   versioned prompt templates
config/                       smoke.mock.yaml, forge-bots.yaml, forge-1llm.yaml, event.example.yaml
```

---

## 6. Decisions log (owner decisions, newest first)

### 2026-10-02
- **The human bridge never hands a choice to Forge's helper buttons** (MB-030). "End Turn" / "Undo" at priority made Forge pass every later priority of the turn and skip the attack, unrecorded (1,852 such decisions in the run data); the revealed-hand confirm's "End Turn", the London mulligan's "Auto" and the attack screen's "Alpha Strike" / "Call Back" are gone too. Revealed hands are acknowledged (forced), Forge's yield suggestions declined (policy).
- **Null actions on the human bridge** (MB-032, MB-035): pass at priority, keep at a mulligan, "no" to a yes/no question (ids `yes`/`no`), "play" at play/draw, Cancel during a cast; a selection without Cancel (edict, forced discard) gets the harness's first legal choices, clicked like an answer. OK is never pressed while Forge shows it disabled.
- **Attacks and blocks are validated before OK and asked as a whole set** (MB-031, MB-037): the seat's earlier declarations are undone before each ask, Forge's `validateAttackers` / `validateBlocks` runs before confirming and its reason goes back to the agent; `maxRetries` re-asks per combat step, then no attack / no blocks (forfeit) or, if a requirement makes that illegal, Forge's AI (delegated).
- **Turn cap on every path** (MB-007): past `maxGameTurns` the bridge ends the game as a draw for both players, end reason "Draw (turn cap of N turns)". Forge marks every player without an outcome as a winner, so the AI-controller path's cap had been recording the draw as a win; fixed too. How draws enter the ratings is still open (rating code).
- **Notifications are information, not rejections** (MB-033, MB-036): reveals and Forge's notifications go into the next prompt as "Since your last decision: ..."; only error dialogs, illegal clicks and invalid cost payments read as "Forge rejected your last choice".
- **Affordability filters, one level down** (MB-002, MB-005): a card's unaffordable abilities (evoke, suspend...) and optional costs (kicker...) aren't offered, as at priority; convoke/improvise/delve spells use an estimate (mana + helpers, colours unchecked) instead of being offered unfiltered. Every card or ability kept off a question is counted as policy, so the filters' reach is visible. `prompts/v2/game.md` now describes these rules and the priority stops (it assumes `priorityStops: smart`, `manaPayment: smart`).
- **rank-bot on the human bridge** (MB-002, MB-013): the bridge produces the tags rank-bot reads (`sorcerySpeedOk`, mulligan `keep` + `handLands`/`handSize`, `hostile`), and rank-bot never answers `[]` to a target question, delves greedily. `sorcerySpeedOk` is literal (own main phase, empty stack), so rank-bot now casts only at sorcery speed. Its behaviour, and so its anchor ratings, differ from earlier runs: don't pool rank-bot ratings across this change.
- **Decision kinds on the human bridge follow `src/types.ts`** (MB-009): play_draw, london_bottom, discard, scry/surveil (and their order steps), cost_choice (delve), pay_or_else, optional_costs, confirm, choose_color, choose_option, instead of choose_cards.

### 2026-10-01
- **The human-controller bridge is the default** (`engine.controller: human`); `spike/remote-human` merged to master. Rationale: Forge validates every action as it does for a human, prompts use Forge's own wording, and the agent sees every decision a human would (49 decisions/game on bots after the mitigations). Validation before switching: two clean 8-bot round robins (human-bots-8, human-bots-9), the Prophetic Prism mana race found and fixed (`InputDriver` waits for Forge's payment task; the engine-exception report would now expose a recurrence), and six DeepSeek games with no errors, exceptions, delegations or forfeits ($0.011/game). The AI-controller path stays selectable with `engine.controller: ai` until it is removed.
- **Engine exceptions are recorded per match and reported.** Forge catches exceptions from game actions, prints "== Report a crash ==" and carries on, so a game can finish in a corrupt state with nothing visible in the results. The harness now scans each match's `forge-logs/<match>.log`, stores `engineErrors[]` (game, exception, first Forge frame) in `matches.jsonl`, and `report.md` / `summary.json` list them under "Engine exceptions". Any match with a count above zero is suspect. Old runs are scanned at report time. Found while fixing a mana race on the human bridge: human-bots-8, previously counted as clean, had one match whose mana pool was corrupted by two concurrent payments (30 exceptions over the rest of the game).
- **Decision provenance is tracked and reported for every in-game action** (owner request: losing track of offloaded decisions would undermine the results scientifically). Categories: agent, forced, policy, delegated, forfeit; definitions, every mechanism and every option filter are in `docs/DECISION-PROVENANCE.md`, and `report.md` shows per-seat counts with reasons. Any new mechanism that acts for a seat must be recorded and added to that document. Auto mana payment now applies only to interchangeable sources (same-name lands, nothing attached, no counters).
- **Information exposure follows MTR 4.1 at Regular REL.** The Magic Tournament Rules sort game information into status, free, derived and private. At Regular REL derived information counts as free, so the prompt includes all status, free and derived information: current characteristics and rules text of every visible object (Forge's card-detail text), zone counts, and the match score. Private information (opponent's hand, library order, face-down identities) is never shown. Computed assessments ("is this lethal?", "does my blocker survive?") are not information; they stay out of prompts.
- **Match notes (prompts v2, MTR 2.11).** After each game that isn't the last, an LLM seat gets the game's public log and its current match notes, and rewrites the notes with `submit_notes` (at most 400 words). They are shown in every prompt for the rest of the match. The in-game scratchpad now lasts one game, so stale state can't leak into the next. One extra model call per game. Prompt versions without `between-games.md` (v1) keep the old per-match scratchpad.
- **Forfeits instead of rescues.** After `maxRetries` (3) failed re-asks, a decision gets the null action (pass, decline, nothing, first legal option, or a cancelled cast) and is counted as a forfeit against the agent. Delegation to Forge's AI is only for decision types the bridge doesn't offer yet. Provider failures abandon the match as an infrastructure error.
- **Iterate gameplay with `bench match`** (fixed decks, no draft) on a cheap model: DeepSeek V4 Flash via OpenRouter, reasoning off, host pinned to one fp8 provider (Baidu). The report's reported-cost column is OpenRouter's actual charge.

## 7. Future work

- **Competitive-REL information tier** (decided 2026-10-01 to defer as over-complicated for now). At Competitive REL, derived information (current characteristics, zone counts, Oracle text) is something a player is entitled to but must work out or look up. A `competitive` option would show only status and free information in the prompt (names, counters, tapped/attached/zone, life, phase, score) and make derived information available through tools (`inspect(card)` for a permanent's current characteristics, zone counts, `lookup_card`), testing whether a model checks before acting. Sources: MTR 4.1 (https://blogs.magicjudges.org/rules/mtr4-1/).
- **Remove the AI-controller bridge** (`PlayerControllerExternal`, `AgentCostDecision`, `engine.controller: ai`) once a few more human-path events have run; then drop the "both bridges" columns from `docs/DECISION-PROVENANCE.md`.
- **Upstream the InputPayMana fix.** Forge clears the payment lock in `updateMessage` when a nested payment closes while the outer activation is still running (`InputPayMana.activateManaAbility`'s task); concurrent `runWithController` calls then corrupt `Player.controlledBy` or the mana pool. The bridge works around it (`InputDriver.manaTask`); the real fix is a one-liner in Forge.
- ~~**"Remote human" bridge spike.**~~ Done 2026-10-01 and now the default; see the decisions log. Original note: Drive Forge's human controller through a headless `IGuiGame` instead of overriding `PlayerControllerAi`, so Forge validates every action as it does for a human (fixes the unpayable-miracle walk-through and mana-unaware mode choices) and supplies its own prompt wording.
- **Sideboarding between games.** Not implemented: decks carry a sideboard (undrafted pool cards), but nobody changes decks between games. Forge calls `PlayerController.sideboard()` between games (`Match.java`), our controller inherits the AI's version, and AI sideboarding is off by default (`GameRules.AISideboardingEnabled`). The between-games step (match notes) is the natural place to add it: let the agent swap pool cards and basic lands, with Forge's AI sideboarding enabled for `forge-ai` seats so both sides get the same option. Until then, `prompts/v2/between-games.md` tells agents there is no sideboarding.
