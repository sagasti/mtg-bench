package forge.bridge;

import java.awt.EventQueue;
import java.util.ArrayList;
import java.util.List;
import java.util.Observable;
import java.util.Observer;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import com.google.gson.JsonObject;

import forge.game.Game;
import forge.game.card.Card;
import forge.game.card.CardView;
import forge.game.player.Player;
import forge.game.zone.ZoneType;
import forge.gamemodes.match.input.Input;
import forge.gamemodes.match.input.InputAttack;
import forge.gamemodes.match.input.InputBlock;
import forge.gamemodes.match.input.InputConfirmMulligan;
import forge.gamemodes.match.input.InputLockUI;
import forge.gamemodes.match.input.InputLondonMulligan;
import forge.gamemodes.match.input.InputPassPriority;
import forge.gamemodes.match.input.InputPayMana;
import forge.gamemodes.match.input.InputSelectEntitiesFromList;
import forge.gamemodes.match.input.InputSelectTargets;
import forge.player.PlayerControllerHuman;

/**
 * Plays Forge's interactive inputs for an agent, generically: every input exposes what clicking a card would do
 * (Input.getActivateAction), Forge's prompt text and its OK/Cancel buttons. Each step becomes one decision
 * ("click this card / player / button"); the driver performs the click and repeats until the input finishes.
 * Forge validates every click exactly as for a human player.
 */
final class InputDriver implements Observer, Runnable {
    private final PlayerControllerHuman ctl;
    private final AgentGuiGame gui;
    private final AgentChannel ch;
    private final BlockingQueue<Input> pending = new LinkedBlockingQueue<>();
    private volatile Input lastQueued = null;
    private volatile long seqAtQueue = 0;
    private static final int MAX_CLICKS_PER_INPUT = 120;

    InputDriver(PlayerControllerHuman ctl, AgentGuiGame gui, AgentChannel ch) {
        this.ctl = ctl;
        this.gui = gui;
        this.ch = ch;
        Thread t = new Thread(this, "agent-input-driver-" + ch.seat);
        t.setDaemon(true);
        t.start();
    }

    @Override
    public void update(Observable o, Object arg) {
        Input in = ctl.getInputQueue().getInput();
        if (in != null && in != lastQueued && !(in instanceof InputLockUI)) {
            lastQueued = in;
            seqAtQueue = gui.promptSeq;
            pending.offer(in);
        }
    }

    @Override
    public void run() {
        while (true) {
            try {
                Input in = pending.poll(1, TimeUnit.SECONDS);
                if (in != null) drive(in);
            } catch (InterruptedException e) {
                return;
            } catch (Throwable t) {
                t.printStackTrace();
                ch.client.error("input driver: " + t);
            }
        }
    }

    private static void onEdt(Runnable r) throws Exception {
        if (EventQueue.isDispatchThread()) r.run(); else EventQueue.invokeAndWait(r);
    }

    private boolean current(Input in) {
        return ctl.getInputQueue().getInput() == in;
    }

    /**
     * Wait until Forge has shown this input's message (InputProxy posts showMessageInitial to the EDT, and
     * java.util.Observable notifies observers newest-first, so this driver hears about the input before that post).
     */
    private void awaitMessage(Input in, long seenSeq) throws Exception {
        long deadline = System.currentTimeMillis() + 2000;
        while (gui.promptSeq == seenSeq && current(in) && System.currentTimeMillis() < deadline) {
            onEdt(() -> { });
            if (gui.promptSeq == seenSeq) Thread.sleep(5);
        }
        onEdt(() -> { });
    }

    private void drive(Input in) throws Exception {
        String lastChoice = null;
        int repeats = 0;
        long seen = seqAtQueue;
        for (int click = 0; click < MAX_CLICKS_PER_INPUT && current(in); click++) {
            awaitMessage(in, seen);
            seen = gui.promptSeq;
            if (!current(in)) return;
            Game game = ch.player.getGame();
            if (game.isGameOver()) return;

            List<PlayerControllerExternal.Opt> opts = new ArrayList<>();
            List<Card> cards = new ArrayList<>();
            for (Player p : game.getPlayers()) {
                cards.addAll(p.getCardsIn(ZoneType.Battlefield));
                if (p.equals(ch.player)) {
                    cards.addAll(p.getCardsIn(ZoneType.Hand));
                    cards.addAll(p.getCardsIn(ZoneType.Graveyard));
                    cards.addAll(p.getCardsIn(ZoneType.Exile));
                    cards.addAll(p.getCardsIn(ZoneType.Command));
                }
            }
            for (Card c : cards) {
                String act;
                try { act = in.getActivateAction(c); } catch (RuntimeException e) { act = null; }
                if (act == null) continue;
                String who = c.getController().equals(ch.player) ? "your " : "opponent's ";
                String zone = c.getZone() != null && c.getZone().getZoneType() != ZoneType.Battlefield ? " [" + c.getZone().getZoneType() + "]" : "";
                opts.add(new PlayerControllerExternal.Opt(StateView.id(c), act + ": " + who + c.getName() + (c.isCreature() ? " " + c.getNetPower() + "/" + c.getNetToughness() : "")
                        + (c.isTapped() ? " (tapped)" : "") + zone, c.getName()));
            }
            if (in instanceof InputSelectTargets || in instanceof InputSelectEntitiesFromList || in instanceof InputAttack) {
                for (Player p : game.getPlayers()) if (!(in instanceof InputAttack && p.equals(ch.player))) opts.add(new PlayerControllerExternal.Opt("player:" + p.getId(),
                        "Select player: " + (p.equals(ch.player) ? "you" : "opponent"), null));
            }
            boolean castingStep = in instanceof InputSelectTargets || in instanceof InputPayMana;
            if (gui.okEnabled) opts.add(new PlayerControllerExternal.Opt("ok", "Button: " + gui.okLabel, null, castingStep ? null : passMeta()));
            if (gui.cancelEnabled) opts.add(new PlayerControllerExternal.Opt("cancel", "Button: " + gui.cancelLabel, null, castingStep ? passMeta() : null));
            if (opts.isEmpty()) { Thread.sleep(20); continue; }

            // Meaningful stops only (same rule as the AI-controller bridge): pass without asking when the agent's own
            // spell or ability is on top of the stack, or when nothing at all can be done.
            if (in instanceof InputPassPriority && ch.ctx.smartStops && gui.okEnabled) {
                boolean anyCard = false;
                for (PlayerControllerExternal.Opt o : opts) if (o.id.matches("c\\d+")) anyCard = true;
                boolean ownTop = !game.getStack().isEmpty() && game.getStack().peekAbility() != null
                        && ch.player.equals(game.getStack().peekAbility().getActivatingPlayer());
                if (ownTop || !anyCard) { onEdt(() -> click("ok", game)); continue; }
            }

            String err = gui.lastError;
            gui.lastError = null;
            String prompt = StateView.clean(gui.prompt) + (err != null ? "\n(Forge rejected your last choice: " + StateView.clean(err) + ")" : "");

            // Attacks and mana payment are one decision each: choose every attacker / every source at once; the
            // driver clicks them in order (then confirms the attack). Everything else is one click per decision.
            if (in instanceof InputAttack) {
                List<PlayerControllerExternal.Opt> attackers = new ArrayList<>();
                for (PlayerControllerExternal.Opt o : opts) if (o.id.matches("c\\d+")) attackers.add(o);
                List<String> r = ch.ask("attackers", prompt + "\nChoose all your attacking creatures at once (none = no attack).", attackers, 0, attackers.size(), null);
                for (String id : r == null ? List.<String>of() : r) { final String pick = id; onEdt(() -> click(pick, game)); }
                if (current(in)) onEdt(() -> click("ok", game));
                continue;
            }
            if (in instanceof InputPayMana) {
                List<String> r = ch.ask("mana_payment", prompt + "\nChoose every mana source to tap for this cost at once, or a button.", opts, 1, opts.size(), null);
                List<String> picks = r == null || r.isEmpty() ? List.of(gui.cancelEnabled ? "cancel" : "ok") : r;
                String button = null;
                for (String id : picks) {
                    if (id.equals("ok") || id.equals("cancel")) { button = id; continue; }
                    if (!current(in)) break;
                    final String pick = id;
                    onEdt(() -> click(pick, game));
                }
                if (button != null && current(in)) { final String b = button; onEdt(() -> click(b, game)); }
                continue;
            }

            List<String> r = ch.ask(kindOf(in), prompt, opts, 1, 1, null);
            String choice = r == null || r.isEmpty() ? (gui.cancelEnabled ? "cancel" : gui.okEnabled ? "ok" : null) : r.get(0);
            if (choice == null) return;

            // A click that changes nothing, repeated past the retry budget, is a forfeit: take the null button.
            repeats = choice.equals(lastChoice) ? repeats + 1 : 0;
            lastChoice = choice;
            if (repeats > ch.ctx.maxRetries && !choice.equals("ok") && !choice.equals("cancel")) {
                choice = gui.cancelEnabled ? "cancel" : "ok";
            }
            final String pick = choice;
            onEdt(() -> click(pick, game));
        }
    }

    private void click(String id, Game game) {
        if (id.equals("ok")) { ctl.getInputProxy().selectButtonOK(); return; }
        if (id.equals("cancel")) { ctl.getInputProxy().selectButtonCancel(); return; }
        if (id.startsWith("player:")) {
            int pid = Integer.parseInt(id.substring(7));
            for (Player p : game.getPlayers()) if (p.getId() == pid) ctl.getInputProxy().selectPlayer(p.getView(), null);
            return;
        }
        Card c = game.findById(Integer.parseInt(id.substring(1)));
        if (c != null) ctl.getInputProxy().selectCard(CardView.get(c), null, null);
    }

    private static JsonObject passMeta() {
        JsonObject m = new JsonObject();
        m.addProperty("type", "pass");
        return m;
    }

    private static String kindOf(Input in) {
        if (in instanceof InputPassPriority) return "priority";
        if (in instanceof InputSelectTargets) return "targets";
        if (in instanceof InputPayMana) return "mana_payment";
        if (in instanceof InputAttack) return "attackers";
        if (in instanceof InputBlock) return "blockers";
        if (in instanceof InputConfirmMulligan || in instanceof InputLondonMulligan) return "mulligan";
        return "choose_cards";
    }
}
