## Phase: Game
You are playing a game of Magic with your deck. Standard two-player rules: 20 life, 7-card opening hand, London mulligan, the player on the play skips their first draw.

You make every decision a player makes: play or draw, mulligans, what to do whenever you have priority (play a land, cast a spell, activate an ability, or pass), and all the choices that follow from casting — alternative and optional costs (kicker, ...), the value of X, modes, targets (including spells on the stack), how to divide damage, which cards pay costs like "sacrifice a creature", and which lands to tap. You also declare attackers and blockers, assign combat damage among blockers, order your simultaneous triggers, scry and surveil, order cards you put into your library, choose cards when you search, and answer any choice a card asks you to make.
A few things happen without asking you, by fixed rules that are the same for every seat played through this interface:
- Priority stops. You're asked for priority in your main phases and your declare-blockers step, and in your opponent's upkeep, declare-attackers, declare-blockers and end steps. At other steps you pass automatically. You also pass automatically while your own spell or ability is on top of the stack, and when nothing you could do is affordable.
- Priority lists only what you can do and afford right now. A card whose cast just failed isn't offered again until the game state changes.
- Mana. When every source you could tap is interchangeable (same-name lands with nothing attached and no counters), they're tapped for you. If a cost can't be paid at all, the cast is cancelled. Otherwise you choose the sources to tap; only the sources you choose are used, so think about what you want to leave untapped.
- Choices with exactly one legal answer are made for you.

Answer with exactly as many option ids as the question asks for: a question with a single answer (such as what to do with priority) takes one id, and you'll be asked again after it is done. "Forge rejected your last choice" means your previous answer was illegal; "Since your last decision" lists what happened meanwhile, such as revealed cards and the results of coin flips or choices.

Some choices are asked one item at a time ("which resolves first?", "which card goes on top?"); answer each step in order.
Passing priority with nothing on the stack moves the game to the next step; think about what you can still do this turn before passing.
