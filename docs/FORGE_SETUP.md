# Running with Forge (tomorrow's runbook)

The harness was built and tested in a sandbox that could not reach Maven Central, so **the Forge side has not run yet**. The Java bridge has been type-checked against Forge's current source (0 errors), and the Node side of the socket protocol has been tested against a fake bridge. Expect a short debugging pass the first time real Forge games run.

## 0. Prerequisites (your machine)

- Java 17+ (`java -version`)
- Node 20+ (`node -v`)
- About 2 GB of disk for Forge

## 1. Get Forge

**Option A: release build (fastest).** Download the latest `forge-gui-desktop-<ver>.tar.bz2` from https://github.com/Card-Forge/forge/releases and unpack it, e.g. to `~/forge`. You should see `res/` and `forge-gui-desktop-<ver>-jar-with-dependencies.jar` in it.

**Option B: build from source** (needed if we patch Forge later):
```bash
git clone --depth 1 https://github.com/Card-Forge/forge.git ~/forge-src
cd ~/forge-src && mvn -pl forge-gui-desktop -am -DskipTests package
# jar: forge-gui-desktop/target/forge-gui-desktop-*-jar-with-dependencies.jar ; res: forge-gui/res
```
Set `engine.forgeDir: ~/forge-src` (the harness finds the jar in `forge-gui-desktop/target` and uses `forge-gui/` as the working directory).

Sanity check that Forge runs headless:
```bash
cd ~/forge && java -jar forge-gui-desktop-*-jar-with-dependencies.jar sim -d <any two .dck in res/> -n 1 -q
```

## 2. Install the harness

```bash
cd mtg-bench
npm install
npm run bench -- cards index --forge-res ~/forge/res     # builds data/cards.json from Forge's card scripts
npm run bench -- cubes --forge-res ~/forge/res           # lists bundled cubes and sizes (need ≥ 360 cards)
```
Put the Comprehensive Rules at `data/MagicCompRules.txt` (see `data/README.md`).

## 3. Build the bridge

```bash
bridge/build.sh ~/forge/forge-gui-desktop-*-jar-with-dependencies.jar
# → bridge/build/mtg-bench-bridge.jar
```
If it doesn't compile, the Forge version probably differs from the source I checked against (`2.0.15-SNAPSHOT`, Sept 2026). Paste the javac errors back to me.

## 4. Smoke tests, in order

```bash
# a) harness only, no Forge, no keys
npm run bench -- run config/smoke.mock.yaml --run-id smoke-mock

# b) Forge, bots only (forge-ai / rank-bot / random / echo): proves the bridge end-to-end for free
#    (edit engine.forgeDir in the config first)
npm run bench -- check config/forge-bots.yaml
npm run bench -- run config/forge-bots.yaml --run-id forge-bots

# c) Forge + one cheap LLM seat + 7 bots, 1 pod: measures real tokens/decision and cost per pod
npm run bench -- check config/forge-1llm.yaml --ping
npm run bench -- run config/forge-1llm.yaml --run-id forge-1llm
```
Per-match Forge logs are in `runs/<run>/forge-logs/<matchId>.log`. Add `--verbose` to see bridge log lines.

## 5. Things to watch on the first real run

| Symptom | Likely cause / fix |
|---|---|
| `bridge exited with code 1` right away | Forge couldn't find `res/`: `forgeDir` must be the folder containing `res/` (release) or the repo root (source). |
| Error loading decks | A card name mismatch between the cube list and Forge. Run `check`, which lists cube cards missing from the DB. |
| A seat's fallback rate is high | Read `decisions.jsonl` rows with `"fallback": true` or `"forfeit": true`; the `error` field says why (invalid ids, malformed answers, time budget used up). Provider failures show up as API errors in `usage.jsonl` and abandoned matches, not fallbacks. |
| Games end in `turn-cap` draws a lot | Raise `maxGameTurns`, or check whether an agent always passes (see `priority` decisions). |
| Very slow games | `parallelMatches` × Forge JVM memory. Each match is one JVM (`-Xmx3g`); lower `parallelMatches` or `-Xmx`. |

## What the agent decides vs. what Forge AI decides

Spells and abilities the agent chooses are cast through Forge's **generic casting path** (the one human players use), which asks the player for every sub-decision. Each of those goes to the agent.

| Area | Agent decides |
|---|---|
| Game start | play/draw, mulligan, which cards to bottom |
| Priority | play land / cast / activate / pass (see stops below) |
| Casting | which version (alternative additional costs), optional costs (kicker, buyback, entwine…), **X**, **modes**, **targets** (incl. spells on the stack), **divided damage**, **which cards pay** sacrifice/discard/exile/return/tap costs, delve, **which lands to tap** |
| "Unless you pay" | whether to pay (Mana Leak, Rhystic Study…), and how |
| Triggers | optional "may" triggers, **order** of simultaneous triggers, their targets and modes |
| Combat | attackers (and which planeswalker/battle), exert, blockers, **combat damage assignment** (incl. trample) |
| Library | **scry / surveil** (and the order of cards kept on top), ordering cards put into the library, searching (tutors, fetch effects) |
| Effects | edicts (choose what to sacrifice/destroy), discard, choose a card/player/number/colour/type/pile/counter/keyword/replacement effect, yes/no prompts |

**Mana payment:** the agent chooses *which* sources to tap. Forge then assigns them to the cost's symbols (colours, hybrid, and so on) using only those sources. A choice that can't pay is sent back once with an error. The question is only asked when it can matter, i.e. there are more untapped sources than the cost needs *and* they aren't all the same card (`event.manaPayment: smart`); set `always` to ask on every payment.

**Still Forge AI** (rare in cube, and each one reported as *delegated*): naming an arbitrary card, convoke/improvise, "add mana in any combination", choosing several spells at once, choosing modes that may repeat, and damage-assignment order under the legacy rules (off by default). Also: any decision where the agent's answer is missing or illegal, when a split has too many options to list (over 60), or when a number range is over 40.

**Delegated decisions are counted.** Every time Forge's AI decides for an agent, the bridge reports it, and `report.md` shows the count per seat and the share of that seat's game decisions. If the share is high, the rating partly reflects Forge's AI, so check it before trusting a result.

**Priority stops** (`event.priorityStops: smart`, the default; `all` asks at every priority pass): the agent is asked only when it has at least one legal non-mana action AND the moment matters: its own main phases; its own declare-blockers step (combat tricks); the opponent's upkeep, declare-attackers, declare-blockers and end step; and whenever the opponent has something on the stack. This cuts calls several-fold compared with asking at every priority pass.

Each of these delegations is a knob we can move to the agent later, in `PlayerControllerExternal.java`.
