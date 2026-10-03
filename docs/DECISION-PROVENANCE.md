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
| **forfeit** | The agent failed the decision after `event.maxRetries` re-asks, or ran out of its time budget (`decisionTimeoutSec`, model time only), and got the null action (pass, decline, nothing, first legal option in engine order, or a cancelled cast). | Counts against the agent; measures its competence. |

"Agent share of real choices" in the report is agent / (agent + delegated + forfeit).

## Where it is recorded

- `decisions.jsonl`: one row per question asked. `autoResolved: true` = forced (a single option); `forfeit: true` =
  forfeit decided by the harness, with the reason in `error` (`timedOut: true` when the time budget ran out);
  `fallback: true` = rank-bot built the deck (deckbuilding only, not in-game); with prompts v3 (two-step deckbuilding,
  MB-049) a seat that fails after a valid deck proposal plays its latest proposal instead, not a fallback, recorded on the
  decision row as `deckReview.error`. Match notes written between games have
  phase `between_games`, so they are not in-game decisions. A row with `infraError: true` is the decision during which
  the provider kept failing; the match was abandoned there, so it is no one's decision (it is recorded for its tokens;
  the report's provenance table doesn't skip it yet, see MB-019).
  Provider failures and harness exceptions are never forfeits: the first abandons the match as an infrastructure error,
  the second as a harness error.
- `matches.jsonl`: per match, `auto[]` (forced and policy actions taken by the bridge, counted per game, with reason),
  `delegations[]` (delegated, with reason) and `forfeits[]` (forfeits detected by the bridge, with reason).
- `report.md` / `summary.json`: the combined table and breakdown.
- `matches.jsonl` `warnings[]`: things the bridge worked around without breaking a decision (a card's rules text
  Forge couldn't render, so its printed Oracle text was shown), counted once per game; report.md "Bridge warnings".
  Not decisions, but that decision went ahead with less information.
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
| Forge's auto-yield suggestion at priority ("pass until ..."; off in Forge's default preferences) is declined | policy | human | "Forge's auto-yield suggestion declined" |
| An opponent's revealed hand is acknowledged (OK; the cards are shown with the agent's next decision) | forced | human | "revealed cards acknowledged" |
| Mana payment with exactly enough sources: on the human bridge, every offered source is needed, counting what each makes (Black Lotus 3, Sol Ring 2...; MB-061). Forge's Auto pays, or, when Auto has no plan (MB-058), the sources are tapped one by one | forced | both | "exactly enough sources" / "nothing to choose" |
| Mana payment where every source is interchangeable: same-name lands, nothing attached, no counters (`event.manaPayment: smart`; `always` disables) | policy | both | "interchangeable sources: ..." |
| Mana cost that can't be paid (Forge's payment plan, recomputed every step, finds none, and the rules-only estimate of the seat's remaining mana doesn't cover what is owed, MB-058): the cast is cancelled (or, for "counter unless you pay", the payment is declined), and the agent's next question says so ("Since your last decision: Forge cancelled casting X with X=30: {28}{R}{W} was still owed ...", MB-056) | forced | human | "cost can't be paid: cast cancelled" / "cost can't be paid: payment declined" |
| Auto pressed ("exactly enough sources" or "interchangeable sources") but the payment didn't change: Auto isn't used again on that payment; the agent is asked for sources, or, with no source left, the cost can't be paid as above | forced | human | (the agent's question, or "cost can't be paid: ...") |
| No creature can block | forced | human | "no creature can block" |
| Keep/mulligan question with an empty hand: Forge asks at any hand size, but a mulligan from an empty hand does nothing, so the keep is clicked (MB-052) | forced | human | "keep: no smaller hand possible (the hand is empty)" |
| X in a mana cost when only the smallest X can be paid (or not even that: the payment then cancels the cast, as above) | forced | human | "X: only the smallest value can be paid" |
| A game in an unbreakable loop (the same state at priority, stack not empty, 20 times in one turn) is ended as a draw; see below | policy | both | "unbreakable loop: the same game state recurred 20 times in one turn; game drawn" (what `game_end`, both seats) |
| Only one legal damage split / divide split | forced | human | "only one legal split" |
| Sideboarding between games (not implemented: decks never change) | policy | human | "no sideboarding (not implemented)" |
| Order of cards put on the bottom by scry-like effects (kept as given) | policy | human | "order of cards put on the bottom unchanged" |
| An input that opens during an engine probe: its null button is pressed (should not happen; logged as a bridge error) | policy | human | "input opened during an engine probe: null button pressed" |
| Decision types not offered to agents (e.g. convoke on the AI bridge, naming a card) | delegated | both | "not offered to agents yet" / "free-text input ..." |
| Too many combat-damage or divide splits to list (> 60): default used | delegated | human | "too many possible splits; default used ..." |
| Attack/block still illegal after the null action (a requirement applies): Forge's AI declares | delegated | human | "declaration rejected and the null action is illegal ..." |
| Answer kept failing validation (including a malformed `choice` or unparseable tool arguments) | forfeit | both (harness) | decision row `forfeit`, reason in `error` |
| Decision time budget used up (model time; provider backoff and failed attempts excluded) | forfeit | both (harness) | decision row `forfeit` + `timedOut`, reason in `error` |
| In-game failure after the retry budget (lands that can't pay, illegal attack/block, a selection that never completes, a click with no effect) | forfeit | both | "chosen sources could not pay ...", "declaration rejected ...", "selection didn't complete the step ...", "same click N times without effect ..." |
| The same question (kind, prompt, options) re-shown with the same answer and nothing in the game changed (log length and state), more than `maxRetries` times in a row, across inputs (Forge re-shows some questions as new inputs, MB-052): the null button is pressed (keep, no, Cancel / pass) | forfeit | human | "same answer N times to a re-shown question without effect; pressed ..." |

### Options filtered before asking (not actions, but they shape what the agent sees)

| Filter | Bridge | Why |
|---|---|---|
| Priority offers only cards with something playable and affordable now (Forge's `canPlay`, `canPlayLand`, `ComputerUtilCost.canPayCost`; on the human bridge a "no" from that probe is checked against a rules-only estimate, `Playability.affordable`, since the probe is Forge's AI deciding whether it would pay: it won't use Black Lotus for a cheap spell, MB-058) | both | A human may try anything; offering unpayable spells cost ~3x the decisions with no information gain. Cards with convoke, improvise or delve are always offered (their affordability can't be probed without asking the controller). |
| A card whose cast just failed is withheld until the game state changes | both | Prevents a deterministic agent re-picking a failed cast forever. Each withholding is counted as policy ("card withheld ...") on the human bridge. |
| Cards the affordability probe filters out are counted, once per card per turn, as policy "card not offered: the affordability probe says its cost can't be paid now"; cards whose every playable ability has a required target without a legal candidate, as "card not offered: a required target has no legal candidate" | human | Makes the filter's reach visible: a card the probe wrongly calls unaffordable is a choice the agent never saw. For convoke, improvise and delve spells the probe is an estimate (available mana plus untapped creatures / untapped artifacts / graveyard cards, colours unchecked), since Forge's own probe would ask the controller; a wrong "affordable" shows up as "cost can't be paid". |
| A card's abilities (cast, alternative costs such as evoke, suspend, activated abilities) and optional costs (kicker, buyback...) are offered only if the affordability probe says they can be paid (and, for abilities, their required targets have a legal candidate); each one kept off is counted as policy "ability not offered ..." / "optional cost not offered ..." | human (optional costs: both) | Same rule as priority, one level down: the card is offered when any of its abilities is affordable, so its unaffordable alternatives would only lead to a cancelled cast. |
| Forge's helper buttons are never offered: "End Turn" / "Undo" at priority and on a revealed hand, "Auto" on the London mulligan (the agent picks the cards), "Alpha Strike" / "Call Back" when attacking | human | Each hands a choice to Forge without asking: "End Turn" makes Forge pass every later priority of the turn and skip the attack, "Auto" lets Forge pick the bottom cards. |
| Spells and abilities whose mandatory targets have no legal candidate are not offered (a counterspell on an empty stack, removal with nothing to target, Animate Dead with no creature card in a graveyard). Targets on the stack are counted from the stack itself: Forge's `hasCandidates` answers yes for any stack target, so before MB-055 counterspells were offered on an empty stack on both bridges. Optional costs are offered only if affordable | both | Forge cancels such casts anyway (after the agent picked the spell, counted against it). A spell whose only legal targets are the caster's own permanents is still offered: that judgement is the agent's (target options say "your ..." / "opponent's ..."). |
| A mana payment offers only sources that can make a type of mana still owed (any source while generic mana is owed); the minimum asked for is the fewest sources that cover the amount owed, counting what each makes (MB-061) | human | Forge's payment input marks every source with a playable mana ability (a Forest when only {B} is owed); picking one changes nothing. |
| X in a mana cost is offered from Forge's minimum up to the largest X the seat can pay (Forge's AI payer or the rules-only estimate, colours included; at most 30 above the minimum), and the question says how much mana is available | human | Before MB-056 every X question listed 31 values regardless of mana; a value that can't be paid only leads to a cancelled cast. |

## How the human bridge asks, retries and forfeits

- **Null actions.** Priority: pass (OK). Mulligan: keep. A yes/no question (ids `yes`/`no`): no. Play/draw: play. A
  selection with Cancel available (a cast's targets or costs): Cancel, which rolls the cast back. A selection without
  Cancel (an edict, a forced discard): the harness's first legal choices, clicked like any answer; OK is never pressed
  while Forge shows it disabled (Forge's `selectButtonOK` doesn't check, and would accept too few picks).
- **Attacks and blocks** are one decision each. Before each ask the seat's earlier declarations are undone, so the
  answer is always the whole set; the driver clicks it and runs Forge's own validation (`CombatUtil.validateAttackers`
  / `validateBlocks`) before confirming. A rejected declaration is asked again with the reason, up to `maxRetries`
  re-asks per combat step; then the null action (no attack / no blocks, forfeit) or, if a requirement makes that
  illegal, Forge's AI (delegated).
- **Re-asks** of one step carry `attempt` (0, 1, 2...) on the decision request, so the harness can count them as one
  decision.
- **Messages** from Forge are split: rejections (an error dialog, an illegal click, an invalid cost payment) are shown
  as "Forge rejected your last choice: ..."; notifications and reveals (a chosen colour, a coin flip, revealed cards)
  are shown with the next decision as "Since your last decision: ...". Reveals are never questions. A cast the
  bridge cancels because its cost can't be paid is reported the same way ("Forge cancelled casting ...: ... was still
  owed and couldn't be paid (your untapped sources and floating mana make about N mana)").
- **Cost questions name what they're about.** A yes/no question about part of a cost ("Do you want to pay 3 life?",
  "Sacrifice Black Lotus?") starts with the spell or ability, its whole cost and what declining means ("You are casting
  Bitter Triumph (full cost: {1}{B}, Pay 3 life). ... if you don't pay it, Bitter Triumph isn't cast."); an optional
  effect's question names its card when Forge's text doesn't (MB-059).

## Games that reach the turn cap

A game still running after `event.maxGameTurns` turns (both players' turns counted) is ended as a draw by the bridge,
for every kind of seat, with the end reason "Draw (turn cap of N turns)". It isn't a decision and isn't attributed to
a seat.

## Games in an unbreakable loop

In the spirit of MTR 4.4 (a loop no player will stop is ended by a judge), the bridge ends a game as a draw for both
players when the same game state recurs at priority, with something on the stack, `LoopGuard.LOOP_REPEATS` (20) times
in one turn: end reason "Draw (unbreakable loop)". The state compared is public: turn, phase, who has priority, each
player's life, poison, zone sizes and floating mana, every permanent (tapped, counters, damage, power/toughness) and
the stack (sources by name, abilities, targets). The rule applies to every kind of seat and doesn't depend on any
bot's behaviour. It's recorded as policy for both seats (`game_end`), and report.md counts these draws per seat next
to turn-cap draws ("Unbreakable-loop draws"); in the ratings a drawn game counts half a win for each seat, as at the
turn cap. Found with rank-bot and Forge's AI copying Chain of Smog back and forth with empty hands (MB-046).

## Bot-only hints

Option `meta` and request `hints` (spell/land/pass type, "blocker survives", "incoming lethal"...) are read only by the
built-in bots (`rank-bot`, `random`). They are never rendered into LLM prompts (`src/agents/render.ts` prints labels
only), so they don't give LLM seats computed assessments.

## Adding a mechanism

Anything new that acts or chooses for a seat must call `ctx.auto(...)` / `AgentChannel.auto(...)` (forced, policy),
`delegated(...)` or `forfeited(...)`, and be added to the table above. A choice that isn't recorded doesn't exist as
far as the report is concerned, which is exactly what this document is meant to prevent.
