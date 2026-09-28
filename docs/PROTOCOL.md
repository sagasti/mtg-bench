# Harness ↔ engine protocol

## Decision contract (all engines)

```ts
DecisionRequest {
  requestId, phase: "study"|"draft"|"deckbuild"|"game", kind,
  prompt: string,           // plain-language instruction
  state: object,            // player-filtered view (rendered as YAML for LLMs)
  options: [{ id, label, card?, meta? }],   // meta = bot hints, never shown to LLMs
  min, max,                 // how many ids to return
  hints?: object,           // bot-only precomputed values, never shown to LLMs
  constraints?: object      // e.g. { minDeckSize: 40 } for deckbuild
}
DecisionResponse { choice: string[], basics?: {Forest: 9,…}, notes?, rationale? }
```

Kinds: `draft_pick`, `deckbuild`, `mulligan`, `london_bottom`, `priority`, `targets`, `attackers`, `blockers`, `choose_entity`, `choose_cards`, `confirm`, `discard` (plus `cube_study`, which is free text).

A new engine only has to turn its own decision points into DecisionRequests and implement `GameEngine.playMatch(spec) → MatchResult` (`src/engine/types.ts`).

## Forge bridge wire format

The harness opens a TCP server on 127.0.0.1 (random port) and spawns:
```
java -cp <forge jar>:<bridge jar> forge.bridge.AgentBridge \
  --port P --token T --deck0 a.dck --deck1 b.dck --external0 true --external1 false \
  --games 3 --seed S --max-turns 40 [--stops smart|all]
```
with cwd = the Forge install. The bridge connects back and exchanges JSON lines:

| Direction | Message |
|---|---|
| bridge → harness | `{"type":"hello","token":T}` (first line; wrong token ⇒ connection dropped) |
| bridge → harness | `{"type":"game_start","game":1}` |
| bridge → harness | `{"type":"decision","rid":7,"seat":0,"game":1,"kind":"blockers","prompt":…,"state":{…},"options":[…],"min":0,"max":3,"hints":{…}}` |
| harness → bridge | `{"type":"answer","rid":7,"choice":["c41->c17"]}` |
| bridge → harness | `{"type":"game_end","game":1,"winner":0,"onThePlay":1,"turns":11,"reason":"LifeReachedZero"}` (`winner` omitted = draw) |
| bridge → harness | `{"type":"match_end"}` |
| bridge → harness | `{"type":"log"|"error","msg":…}` |

The game thread blocks on each decision, so there is at most one outstanding request per match. An `answer` with an empty or illegal `choice` makes the bridge use Forge AI's choice for that decision.

## Ids in Forge decisions

- Cards: `c<forge card id>` (stable within a game; the same id in `state` and `options`)
- Players: `you` / `opponent`
- Priority options: `pass`, `sa1`, `sa2`, … (valid only for that request)
- Attacks: `c12` (single defender) or `c12@player` / `c12@c30` (planeswalker/battle)
- Blocks: `<blocker>-><attacker>`, e.g. `c41->c17`
