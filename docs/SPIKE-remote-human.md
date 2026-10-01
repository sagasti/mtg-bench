# Spike: agents through Forge's human controller ("remote human" bridge)

Branch `spike/remote-human`, 2026-10-01. Switch: `engine.controller: human` (default `ai` = PlayerControllerExternal).

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

## Recommendation
Go, conditionally: the approach works and removes the hand-written rules layer, but at about 3x the decisions and
cost. Implement mitigations 1 and 2 and re-measure; switch the default only if decisions/game come within roughly
1.5x of the old path. Then implement item 3 properly, rebuild bot tags (item 4), and remove PlayerControllerExternal
and AgentCostDecision.
