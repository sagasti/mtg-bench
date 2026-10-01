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
| Java bridge | ⚠️ **Has never been compiled against real jars or run.** It was written in a sandbox without Maven Central access. It **type-checks with 0 errors** against Forge source at commit `2ccbbb01326e28b38788c50f7f0e01b5d12f32b3` (2026-09-28, version `2.0.15-SNAPSHOT`), using stubs for gson, guava and commons-lang3. |
| Real LLM seats | ⚠️ Never called. The provider code follows each API's documented format and was exercised only through the `echo` stand-in. |
| `data/MagicCompRules.txt` | ❌ Missing. Download it (see `data/README.md`). |

**Expect to debug the bridge.** It is the riskiest code. The places most likely to need fixes, roughly in order:
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
src/tournament/               run.ts (event loop), schedule.ts (round robin / Swiss)
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
