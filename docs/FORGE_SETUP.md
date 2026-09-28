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
| A seat's fallback rate is high | Read `decisions.jsonl` rows with `"fallback": true`; the `error` field says why (invalid ids, timeouts, API errors). |
| Games end in `turn-cap` draws a lot | Raise `maxGameTurns`, or check whether an agent always passes (see `priority` decisions). |
| Very slow games | `parallelMatches` × Forge JVM memory. Each match is one JVM (`-Xmx3g`); lower `parallelMatches` or `-Xmx`. |

## What the agent decides vs. what Forge AI decides (v1)

**Agent:** mulligan; which cards to bottom; every priority stop (play land / cast spell / activate ability / pass); targets for its own spells and its own triggered abilities, including spells and abilities on the stack (counterspells); attackers (including which planeswalker/battle); blockers; discard; generic "choose a card/player", "choose N cards" and yes/no prompts from effects.

**Forge AI (for now):** mana payment and which lands to tap; X values; additional/optional costs paid as costs (sacrifice/discard costs); charm/modal choices; divided damage; ordering simultaneous triggers; damage assignment order among multiple blockers; scry/surveil; choosing numbers/colours/piles; sideboarding (disabled; the same deck is used every game).

**Priority stops** (`smart`, the default): the agent is asked only when it has at least one legal non-mana action AND the moment matters: its own main phases; its own declare-blockers step (combat tricks); the opponent's upkeep, declare-attackers, declare-blockers and end step; and whenever the opponent has something on the stack. This cuts calls several-fold compared with asking at every priority pass.

Each of these delegations is a knob we can move to the agent later, in `PlayerControllerExternal.java`.
