# Decision provenance: who made each in-game decision

A benchmark result is only as credible as our account of which choices the agent actually made. Every in-game
action taken for a seat is attributed to one of five sources, recorded in the run's data, and summarised in
`report.md` under "Who made each in-game decision" (per seat, with every reason and count) and in `summary.json`
under `provenance`.

## Categories

| Category | Meaning | Validity |
|---|---|---|
| **agent** | The agent chose among two or more legal options. | This is what the benchmark measures. |
| **forced** | Only one legal action existed, so no question was asked. | Neutral: no choice existed. |
| **policy** | A documented, configured rule acted without asking, where the alternatives are treated as equivalent or the stop is configured as not meaningful. | Must be disclosed with the rule; each rule is listed below and can be switched off where noted. |
| **delegated** | A real choice made by Forge's AI or by a fixed default (not the agent). | Contaminates the measurement; should be near zero. Every instance is reported with its reason. |
| **forfeit** | The agent failed the decision after `event.maxRetries` re-asks and got the null action (pass, decline, nothing, first legal option in engine order, or a cancelled cast). | Counts against the agent; measures its competence. |

"Agent share of real choices" in the report is agent / (agent + delegated + forfeit).

## Where it is recorded

- `decisions.jsonl`: one row per question asked. `autoResolved: true` = forced (a single option); `forfeit: true` =
  forfeit decided by the harness; `fallback: true` = rank-bot built the deck (deckbuilding only, not in-game).
- `matches.jsonl`: per match, `auto[]` (forced and policy actions taken by the bridge, counted per game, with reason),
  `delegations[]` (delegated, with reason) and `forfeits[]` (forfeits detected by the bridge, with reason).
- `report.md` / `summary.json`: the combined table and breakdown.
- `matches.jsonl` also carries `engineErrors[]`: exceptions Forge logged mid-game and carried on from. Not a decision
  source, but a match with any is suspect (its state may have been corrupt from that point), and `report.md` lists them
  under "Engine exceptions".

## Every mechanism, by bridge

The human-controller bridge (`engine.controller: human`, the default: `PlayerControllerHuman` driven headlessly by
`AgentGuiGame` + `InputDriver`) is what results are produced with. The AI-controller bridge (`engine.controller: ai`,
`PlayerControllerExternal`) is kept for comparison and will be removed.

### Actions taken without asking

| Mechanism | Category | Bridge | Recorded reason |
|---|---|---|---|
| A question with exactly one legal option | forced | both (harness) | decision row `autoResolved` |
| Phase that is not a "meaningful stop" (`event.priorityStops: smart`; `all` disables) | policy | both | "not a meaningful stop" / "phase is not a meaningful stop" (counted once per turn and phase) |
| Priority with nothing playable and affordable | policy | both | "nothing playable and affordable" |
| Priority with the agent's own spell or ability on top of the stack | policy | human | "own spell or ability on top of the stack" |
| Mana payment with exactly enough sources | forced | both | "exactly enough sources" / "nothing to choose" |
| Mana payment where every source is interchangeable: same-name lands, nothing attached, no counters (`event.manaPayment: smart`; `always` disables) | policy | both | "interchangeable sources: ..." |
| Mana cost that can't be paid: the cast is cancelled | forced | human | "cost can't be paid: cast cancelled" |
| No creature can block | forced | human | "no creature can block" |
| Only one legal damage split / divide split | forced | human | "only one legal split" |
| Sideboarding between games (not implemented: decks never change) | policy | human | "no sideboarding (not implemented)" |
| Order of cards put on the bottom by scry-like effects (kept as given) | policy | human | "order of cards put on the bottom unchanged" |
| An input that opens during an engine probe: its null button is pressed (should not happen; logged as a bridge error) | policy | human | "input opened during an engine probe: null button pressed" |
| Decision types not offered to agents (e.g. convoke on the AI bridge, naming a card) | delegated | both | "not offered to agents yet" / "free-text input ..." |
| Too many combat-damage or divide splits to list (> 60): default used | delegated | human | "too many possible splits; default used ..." |
| Attack/block still illegal after the null action (a requirement applies): Forge's AI declares | delegated | human | "declaration rejected and the null action is illegal ..." |
| Answer kept failing validation | forfeit | both (harness) | decision row `forfeit` |
| In-game failure after the retry budget (lands that can't pay, illegal attack/block, a click with no effect) | forfeit | both | "chosen sources could not pay ...", "declaration rejected ...", "same click N times without effect ..." |

### Options filtered before asking (not actions, but they shape what the agent sees)

| Filter | Bridge | Why |
|---|---|---|
| Priority offers only cards with something playable and affordable now (Forge's `canPlay`, `canPlayLand`, `ComputerUtilCost.canPayCost`) | both | A human may try anything; offering unpayable spells cost ~3x the decisions with no information gain. Cards with convoke, improvise or delve are always offered (their affordability can't be probed without asking the controller). |
| A card whose cast just failed is withheld until the game state changes | both | Prevents a deterministic agent re-picking a failed cast forever. Each withholding is counted as policy ("card withheld ...") on the human bridge. |
| Spells whose mandatory targets have no legal candidate are not offered; optional costs are offered only if affordable | AI bridge | Forge cancels such casts anyway; the human bridge leaves this to Forge. |

## Bot-only hints

Option `meta` and request `hints` (spell/land/pass type, "blocker survives", "incoming lethal"...) are read only by the
built-in bots (`rank-bot`, `random`). They are never rendered into LLM prompts (`src/agents/render.ts` prints labels
only), so they don't give LLM seats computed assessments.

## Adding a mechanism

Anything new that acts or chooses for a seat must call `ctx.auto(...)` / `AgentChannel.auto(...)` (forced, policy),
`delegated(...)` or `forfeited(...)`, and be added to the table above. A choice that isn't recorded doesn't exist as
far as the report is concerned, which is exactly what this document is meant to prevent.
