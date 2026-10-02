# Spike: agents through Forge's human controller ("remote human" bridge)

Written on branch `spike/remote-human`, 2026-10-01; merged to master the same day and made the default (`engine.controller: human`; `ai` keeps the old PlayerControllerExternal path for comparison).

## What was built
- `AgentGuiGame` (extends Forge's `AbstractGuiGame`): headless match screen. Forge's human controller asks its
  dialog questions here (choose one/many, confirm, option dialogs, order, ability to play, entities); each becomes a
  decision with Forge's wording. Prompt text, button labels and error flashes are recorded for the driver.
- `InputDriver`: plays Forge's interactive inputs generically. Every input exposes `getActivateAction(card)` (the
  hover text for "what clicking this card does now"), its prompt and its OK/Cancel buttons; the driver offers those
  as options, performs the click, and repeats until the input finishes. Attacks and mana payment are one
  multi-select decision each. Priority auto-passes when the agent's own object is on top of the stack or nothing
  can be clicked (the old "meaningful stops").
- `LobbyPlayerAgentHuman` wires `PlayerControllerHuman` + `AgentGuiGame` + `InputDriver`; `AgentChannel` is the
  shared decision channel.

## Results (DeepSeek V4 Flash vs Forge AI, same decks/opponent as the old-path runs)
| | Old path (AI controller) | Human path (final spike) |
|---|---|---|
| Decisions / game | 48 | 165 (8.3/turn vs 2.5) |
| Cost / game | $0.008 | $0.025 |
| Minutes / game | 6 | 17 |
| Invalid answers / 100 decisions | 2.5 | 4.2 |
| Delegations | 0 | 0 (plus spike defaults below) |
| Errors / exceptions | 0 | 0 |
DeepSeek won 3 of 4 human-path games. A random bot also completes games on this path.

## What worked
- One generic driver covered every input met (priority, targets, mana, attacks, blocks, mulligans, confirms,
  card selection) with no per-input adapters beyond attack/mana batching and the priority stop rule.
- Forge validates everything as for a human: no hand-written legality filters, cancel paths or retries.
- Prompts are Forge's own ("Select creatures to attack P2 ...", "Pay Mana Cost: {2}", "Thunderous Wrath deals 5
  damage to any target. Select any target"). Forge's Auto mana button is offered. Alternative costs (e.g. Surge)
  appear as for a human, which the AI-controller path never offered.

## What's not good enough yet
1. **Priority passes dominate.** 122 of 192 priority decisions were "OK" (pass). The human flow lists every spell
   whose timing allows it, affordable or not, so the agent is stopped with nothing it can actually do, and it
   sometimes tries to cast and then cancels at the payment screen. Mitigation: auto-pass when nothing listed is
   castable per Forge's own check (`canPlay` + mana affordability), as the old path did.
2. **Mana payment is still piecemeal.** 86 decisions; 46 chose a single land although the prompt asks for all
   sources at once, so the driver asks again. Mitigation: ask only when the choice matters (the old path's
   "meaningful" rule; otherwise Forge's Auto pay), and require enough sources to cover the cost.
3. **Spike defaults that must become real decisions:** combat damage assignment (lethal in order), dividing damage
   (even split), rearranging cards (scry/surveil order unchanged), free-text input such as naming a card, and
   sideboarding. They are reported as delegations.
4. **Bots:** `rank-bot` reads option tags (spell/land/pass, blocker survives...) that this path doesn't produce;
   they would need recomputing here. `random` works.

## Update: mitigations 1 and 2 implemented (same day)
- **Priority** offers a card only if something on it is playable and affordable right now (Forge's `canPlay`,
  `canPlayLand`, `ComputerUtilCost.canPayCost`); with nothing playable, the existing auto-pass applies.
- **Mana**: unpayable cost (Forge disables Auto) -> cancel, so the cast rolls back; every legal payment taps the same
  kind of source -> Forge's Auto pays; otherwise the agent picks sources, at least as many as the remaining cost
  (`InputPayMana.manaCost`, read by reflection).

| | Old path | Human path, first spike | Human path, mitigated |
|---|---|---|---|
| Decisions / game | 48 | 165 | **49** |
| Cost / game | $0.0075 | $0.025 | **$0.0071** |
| Minutes / game | 5.7 | 17.2 | **5.1** |
| Invalid answers / 100 | 2.5 | 4.2 | **1.0** |
Two DeepSeek games (both won), 0 invalid mana answers, delegations only the 2 placeholder damage assignments.
The random bot now casts spells on this path (it never did before the mitigations). Small sample.

## Recommendation
Go. With mitigations 1 and 2 the human path matches the old path on decisions, cost and time per game, with
fewer invalid answers, no hand-written legality layer, and Forge's own prompts. Remaining before it becomes the
default: replace the spike defaults with real decisions (item 3), rebuild bot tags (item 4), validate on a larger
sample (a full bots event plus several DeepSeek matches), then remove PlayerControllerExternal and AgentCostDecision.

## Update 2026-10-02: bridge review fixes (MB-002, MB-005, MB-007, MB-009, MB-013, MB-030..MB-038)
- **Helper buttons are never offered.** "End Turn" / "Undo" at priority (Forge then passed every later priority of
  the turn and skipped the attack, unrecorded), "End Turn" on an opponent's revealed hand (now acknowledged as
  forced), "Auto" on the London mulligan (the agent now picks the bottom cards) and "Alpha Strike" / "Call Back".
- **Item 4 done: bot tags rebuilt.** `InputDriver.botTags` and the mulligan input produce what `rank-bot` reads:
  `type`/`cmc`/`sorcerySpeedOk` at priority, `keep` + `handLands`/`handSize` for mulligans, `hostile` on targets and
  card lists, plus the existing attack/block tags. Targeting prompts carry the ability's real bounds.
- **Attacks and blocks** undo the seat's earlier declarations before each ask and are checked with Forge's own
  validation before OK; retries are counted per combat step. **Forfeits** never press a disabled OK.
- **Turn cap** enforced for every seat (draw, "Draw (turn cap of N turns)"). Notifications and reveals are shown
  as information, not as rejections or questions. Decision kinds on this path now follow `src/types.ts`
  (play_draw, london_bottom, discard, scry, cost_choice, pay_or_else, confirm, choose_color...).
See docs/DECISION-PROVENANCE.md for the recorded reasons.
