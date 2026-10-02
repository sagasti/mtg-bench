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

Kinds:
- draft/build: `draft_pick`, `deckbuild`
- game start: `play_draw`, `mulligan`, `london_bottom`
- priority and casting: `priority`, `choose_ability`, `optional_costs`, `announce_x`, `choose_mode`, `targets`, `divide`, `cost_choice`, `mana_payment`, `pay_or_else`
- combat: `attackers`, `exert`, `blockers`, `assign_damage`
- triggers and library: `order_triggers`, `scry`, `scry_order`, `surveil`, `surveil_order`, `order_library`, `search`
- generic: `choose_entity`, `choose_cards`, `choose_number`, `choose_color`, `choose_option`, `confirm`, `discard`
- plus `cube_study` (free text)

Ordering decisions are asked one pick at a time ("which is first?"), so every decision is a plain choice from a list.

A new engine only has to turn its own decision points into DecisionRequests and implement `GameEngine.playMatch(spec) → MatchResult` (`src/engine/types.ts`).

## Forge bridge wire format

The harness opens a TCP server on 127.0.0.1 (random port) and spawns:
```
java -cp <forge jar>:<bridge jar> forge.bridge.AgentBridge \
  --port P --token T --deck0 a.dck --deck1 b.dck --external0 true --external1 false \
  --games 3 --seed S --max-turns 40 --stops smart|all --mana smart|always
```
with cwd = the Forge install. The bridge connects back and exchanges JSON lines:

| Direction | Message |
|---|---|
| bridge → harness | `{"type":"hello","token":T}` (first line; wrong token ⇒ connection dropped) |
| bridge → harness | `{"type":"game_start","game":1}` |
| bridge → harness | `{"type":"decision","rid":7,"seat":0,"game":1,"kind":"blockers","prompt":…,"state":{…},"options":[…],"min":0,"max":3,"hints":{…},"attempt":0}` (`attempt`: 0 for the first ask of an in-game step, 1, 2… for re-asks of the same step after Forge rejected the answer) |
| harness → bridge | `{"type":"answer","rid":7,"choice":["c41->c17"]}` |
| bridge → harness | `{"type":"game_end","game":1,"winner":0,"onThePlay":1,"turns":11,"reason":"LifeReachedZero"}` (`winner` omitted = draw) |
| bridge → harness | `{"type":"match_end"}` |
| bridge → harness | `{"type":"delegated","seat":0,"game":1,"what":"assign_damage","reason":"too many possible splits (84)"}`: Forge's AI decided for the agent |
| bridge → harness | `{"type":"log"|"error","msg":…}` |

The game thread blocks on each decision, so there is at most one outstanding request per match. An `answer` with an empty or illegal `choice` makes the bridge use Forge AI's choice for that decision.

## Ids in Forge decisions

- Cards: `c<forge card id>` (stable within a game; the same id in `state` and `options`)
- Players: `you` / `opponent`
- Priority options: `pass`, `sa1`, `sa2`, … (valid only for that request)
- Attacks: `c12` (single defender) or `c12@player` / `c12@c30` (planeswalker/battle)
- Blocks: `<blocker>-><attacker>`, e.g. `c41->c17`
