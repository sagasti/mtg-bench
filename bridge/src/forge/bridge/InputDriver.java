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

import forge.ai.AiAttackController;
import forge.ai.AiBlockController;
import forge.ai.ComputerUtilCost;
import forge.game.Game;
import forge.game.keyword.Keyword;
import forge.game.mana.ManaCostBeingPaid;
import forge.game.spellability.SpellAbility;
import forge.game.card.Card;
import forge.game.card.CardView;
import forge.game.combat.Combat;
import forge.game.combat.CombatUtil;
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
import forge.gamemodes.match.input.InputSelectManyBase;
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
    private Thread driverThread;
    /** Cards whose cast just failed with the game state unchanged: withheld from priority until the state changes. */
    private final java.util.Set<Integer> withheld = new java.util.HashSet<>();
    private String withheldKey = "";
    private Integer lastPriorityCard = null;
    private String lastPriorityKey = "";
    private static final int MAX_CLICKS_PER_INPUT = 120;
    private static final boolean TRACE = "1".equals(System.getenv("MTG_BRIDGE_TRACE"));
    private void trace(String msg) { if (TRACE) System.err.println("[driver " + ch.seat + "] " + msg); }

    InputDriver(PlayerControllerHuman ctl, AgentGuiGame gui, AgentChannel ch) {
        this.ctl = ctl;
        this.gui = gui;
        this.ch = ch;
        Thread t = new Thread(this, "agent-input-driver-" + ch.seat);
        driverThread = t;
        t.setDaemon(true);
        t.start();
    }

    @Override
    public void update(Observable o, Object arg) {
        Input in = ctl.getInputQueue().getInput();
        if (Thread.currentThread() == driverThread && in != null && !(in instanceof InputLockUI)) {
            // An input opened on the driver's own thread (e.g. an engine probe asking this controller a question):
            // nobody can click it, so take its null button now instead of deadlocking, and make it visible.
            ch.client.error("input opened on the driver thread (" + in.getClass().getSimpleName() + "); pressed its null button");
            ch.auto("policy", kindOf(in), "input opened during an engine probe: null button pressed");
            in.selectButtonOK();
            return;
        }
        if (in != null && in != lastQueued && !(in instanceof InputLockUI)) {
            lastQueued = in;
            seqAtQueue = gui.promptSeq;
            // Selection bounds come from setSelectables during the input's own message; reset so inputs that don't
            // announce them aren't read with a previous input's bounds (0..all then applies).
            gui.selMin = 0;
            gui.selMax = Integer.MAX_VALUE;
            pending.offer(in);
        }
    }

    @Override
    public void run() {
        while (true) {
            try {
                Input in = pending.poll(1, TimeUnit.SECONDS);
                if (in == null) {
                    // Never leave an open input unattended: pick it up again if no event announced it.
                    Input open = ctl.getInputQueue().getInput();
                    if (open != null && !(open instanceof InputLockUI) && !ch.player.getGame().isGameOver()) in = open;
                }
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
     * Wait until Forge has shown this input's message. InputProxy posts showMessageInitial to the event thread when the
     * input is set, before the game thread parks; two flushes of the event queue guarantee it has run (the second
     * covers a post made while the first flush was queued).
     */
    private void awaitMessage(Input in) throws Exception {
        onEdt(() -> { });
        Thread.sleep(2);
        onEdt(() -> { });
    }

    private String lastChoice = null;
    private int repeats = 0;
    private int click = 0;
    /** Clicks chosen in one decision but performed one per step (mana sources: each activation must finish first). */
    private final java.util.ArrayDeque<String> queued = new java.util.ArrayDeque<>();
    /** Attack/block declarations tried on the current input; Forge rejects illegal ones and the input stays open. */
    private int declarations = 0;
    /** Batched selections tried on the current input (targets, card lists, mana). */
    private int batches = 0;

    private void drive(Input in) throws Exception {
        trace("drive " + in.getClass().getSimpleName());
        lastChoice = null;
        repeats = 0;
        queued.clear();
        declarations = 0;
        batches = 0;
        for (click = 0; click < MAX_CLICKS_PER_INPUT && current(in); click++) {
            awaitMessage(in);
            // Forge activates a mana source asynchronously (on a game executor thread); wait for it like a human would
            // before the next click, or two activations touch the cost-payment stack at once.
            long activationDeadline = System.currentTimeMillis() + 30_000;
            while (in instanceof InputPayMana pm && pm.isActivatingManaAbility() && current(in)) {
                if (System.currentTimeMillis() > activationDeadline) {
                    // Never hang silently: a mana activation that doesn't finish ends the match as an error.
                    ch.client.error("input driver: mana activation still running after 30 s; prompt=" + StateView.clean(gui.prompt).replace('\n', ' '));
                    System.err.flush();
                    System.exit(3);
                }
                Thread.sleep(5);
            }
            if (!current(in)) return;
            // Every step (reading state, probes, the question, the clicks) runs on the event thread, as in Forge's own
            // UI: the game thread is parked on the input, so nothing else touches the game meanwhile.
            final boolean[] more = { true };
            onEdt(() -> more[0] = step(in));
            if (!more[0]) return;
            Thread.sleep(2);
        }
        if (current(in) && !ch.player.getGame().isGameOver()) {
            // Never hang silently: an input the driver can't complete ends the match as an error, visible in the report.
            ch.client.error("input driver: gave up on " + in.getClass().getSimpleName() + " after " + MAX_CLICKS_PER_INPUT + " steps; prompt="
                    + StateView.clean(gui.prompt).replace('\n', ' ') + " ok=" + gui.okEnabled + " cancel=" + gui.cancelEnabled + " choices=" + validChoices(in));
            System.err.flush();
            System.exit(3);
        }
    }

    /** min/max of an InputSelectManyBase (protected fields), or null. */
    private static int[] ownBounds(Input in) {
        if (!(in instanceof InputSelectManyBase)) return null;
        try {
            java.lang.reflect.Field fmin = InputSelectManyBase.class.getDeclaredField("min");
            java.lang.reflect.Field fmax = InputSelectManyBase.class.getDeclaredField("max");
            fmin.setAccessible(true);
            fmax.setAccessible(true);
            return new int[] { fmin.getInt(in), fmax.getInt(in) };
        } catch (ReflectiveOperationException | RuntimeException e) {
            return null;
        }
    }

    /** A collection field of a list-selection input ("validChoices", "selected"); null for other inputs. */
    private static java.util.Collection<?> entityList(Input in, String field) {
        if (!(in instanceof InputSelectEntitiesFromList)) return null;
        try {
            java.lang.reflect.Field f = InputSelectEntitiesFromList.class.getDeclaredField(field);
            f.setAccessible(true);
            Object v = f.get(in);
            return v instanceof java.util.Collection<?> c ? c : null;
        } catch (ReflectiveOperationException | RuntimeException e) {
            return null;
        }
    }

    /** The input's own list of valid choices, for diagnostics (reflection: private field). */
    private static String validChoices(Input in) {
        try {
            if (in instanceof InputSelectEntitiesFromList) {
                java.lang.reflect.Field f = InputSelectEntitiesFromList.class.getDeclaredField("validChoices");
                f.setAccessible(true);
                return String.valueOf(f.get(in));
            }
        } catch (ReflectiveOperationException | RuntimeException e) { return "?"; }
        return "n/a";
    }

    /** One step of an input: build the options, maybe ask the agent, click. Returns false to stop driving this input. */
    private boolean step(Input in) {
        trace("step " + in.getClass().getSimpleName() + " current=" + current(in) + " ok=" + gui.okEnabled + ":" + gui.okLabel + " cancel=" + gui.cancelEnabled + ":" + gui.cancelLabel + " prompt=" + StateView.clean(gui.prompt).replace('\n', ' '));
        Game game = ch.player.getGame();
        if (game.isGameOver()) return false;
        if (!queued.isEmpty()) {
            String next = queued.poll();
            if (!next.equals("ok") || gui.okEnabled) click(next, game);
            return true;
        }
        if (in instanceof InputPassPriority) {
            // A cast that failed (cancelled, unpayable) leaves the state unchanged: don't offer it again until it changes.
            String key = stateKey(game);
            if (!key.equals(withheldKey)) { withheld.clear(); withheldKey = key; }
            if (lastPriorityCard != null && key.equals(lastPriorityKey) && withheld.add(lastPriorityCard))
                ch.auto("policy", "priority", "card withheld: its cast just failed and the state is unchanged");
            lastPriorityCard = null;
        }

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
        java.util.Collection<?> listChoices = entityList(in, "validChoices");
        if (listChoices != null) {
            // "Choose from a list" inputs: offer exactly the input's own valid choices (hover text can be empty for them).
            cards.clear();
            for (Object o : listChoices) if (o instanceof Card lc) cards.add(lc);
        }
        for (Card c : cards) {
            String act;
            try { act = listChoices != null ? "select card" : in.getActivateAction(c); } catch (RuntimeException e) { act = null; }
            if (act == null) continue;
            if (in instanceof InputPassPriority && !playableNow(c)) continue; // offered by the human UI even when unaffordable
            if (in instanceof InputPassPriority && withheld.contains(c.getId())) continue;
            String who = c.getController().equals(ch.player) ? "your " : "opponent's ";
            String zone = c.getZone() != null && c.getZone().getZoneType() != ZoneType.Battlefield ? " [" + c.getZone().getZoneType() + "]" : "";
            opts.add(new PlayerControllerExternal.Opt(StateView.id(c), act + ": " + who + c.getName() + (c.isCreature() ? " " + c.getNetPower() + "/" + c.getNetToughness() : "")
                    + (c.isTapped() ? " (tapped)" : "") + zone, c.getName(), botTags(in, c)));
        }
        if (in instanceof InputSelectTargets || in instanceof InputSelectEntitiesFromList || in instanceof InputAttack) {
            for (Player p : game.getPlayers()) if (!(in instanceof InputAttack && p.equals(ch.player)) && (listChoices != null ? listChoices.contains(p) : playerSelectable(in, p))) {
                JsonObject meta = new JsonObject();
                meta.addProperty("hostile", !p.equals(ch.player));
                opts.add(new PlayerControllerExternal.Opt("player:" + p.getId(), "Select player: " + (p.equals(ch.player) ? "you" : "opponent"), null, meta));
            }
        }
        boolean castingStep = in instanceof InputSelectTargets || in instanceof InputPayMana;
        if (gui.okEnabled) opts.add(new PlayerControllerExternal.Opt("ok", "Button: " + gui.okLabel, null, castingStep ? null : passMeta()));
        if (gui.cancelEnabled) opts.add(new PlayerControllerExternal.Opt("cancel", "Button: " + gui.cancelLabel, null, castingStep ? passMeta() : null));
        if (opts.isEmpty()) {
            if (click == 5) ch.client.error("input driver: nothing to offer on " + in.getClass().getSimpleName() + "; prompt=" + StateView.clean(gui.prompt).replace('\n', ' ') + " choices=" + validChoices(in));
            return true; // nothing selectable yet: the driver loop waits and retries
        }
        if (click == MAX_CLICKS_PER_INPUT - 1) {
            ch.client.error("input driver: no progress on " + in.getClass().getSimpleName() + " after " + MAX_CLICKS_PER_INPUT
                    + " clicks; prompt=" + StateView.clean(gui.prompt).replace('\n', ' ') + " ok=" + gui.okEnabled + ":" + gui.okLabel
                    + " cancel=" + gui.cancelEnabled + ":" + gui.cancelLabel + " options=" + opts.size() + " lastError=" + gui.lastError);
        }

        // Meaningful stops only (same rule as the AI-controller bridge): pass without asking when the agent's own
        // spell or ability is on top of the stack, or when nothing at all can be done.
        if (in instanceof InputPassPriority && ch.ctx.smartStops && gui.okEnabled) {
            boolean anyCard = false;
            for (PlayerControllerExternal.Opt o : opts) if (o.id.matches("c\\d+")) anyCard = true;
            boolean ownTop = !game.getStack().isEmpty() && game.getStack().peekAbility() != null
                    && ch.player.equals(game.getStack().peekAbility().getActivatingPlayer());
            if (ownTop || !anyCard) {
                ch.auto("policy", "priority", ownTop ? "own spell or ability on top of the stack" : "nothing playable and affordable");
                click("ok", game);
                return true;
            }
        }

        String err = gui.lastError;
        gui.lastError = null;
        String prompt = StateView.clean(gui.prompt) + (err != null ? "\n(Forge rejected your last choice: " + StateView.clean(err) + ")" : "");

        // Attacks and mana payment are one decision each: choose every attacker / every source at once; the
        // driver clicks them in order (then confirms the attack). Everything else is one click per decision.
        if ((in instanceof InputAttack || in instanceof InputBlock) && game.getCombat() != null && ++declarations > ch.ctx.maxRetries + 1) {
            // Forge kept rejecting the agent's declarations (menace, "must attack/block" requirements...).
            // First the null action (no attack / no blocks, counted as a forfeit); if even that is illegal, Forge's AI
            // declares a legal set (counted as delegated). Both are reported.
            Combat combat = game.getCombat();
            String what = in instanceof InputAttack ? "attackers" : "blockers";
            if (declarations == ch.ctx.maxRetries + 2) {
                if (in instanceof InputAttack) { for (Card c : new ArrayList<>(combat.getAttackers())) if (c.getController().equals(ch.player)) combat.removeFromCombat(c); }
                else for (Card c : ch.player.getCreaturesInPlay()) if (combat.isBlocking(c)) combat.removeFromCombat(c);
                ch.forfeited(what, "declaration rejected " + (ch.ctx.maxRetries + 1) + " times; null action: " + (in instanceof InputAttack ? "no attack" : "no blocks"));
            } else {
                if (in instanceof InputAttack) new AiAttackController(ch.player).declareAttackers(combat);
                else new AiBlockController(ch.player, false).assignBlockersForCombat(combat);
                ch.delegated(what, "declaration rejected and the null action is illegal (a requirement applies); Forge's AI declared");
            }
            click("ok", game);
            if (current(in) && declarations > ch.ctx.maxRetries + 3)
                ch.client.error("input driver: " + what + " still open after the AI's declaration; lastError=" + gui.lastError);
            return true;
        }
        if (in instanceof InputAttack) {
            List<PlayerControllerExternal.Opt> attackers = new ArrayList<>();
            for (PlayerControllerExternal.Opt o : opts) if (o.id.matches("c\\d+")) attackers.add(o);
            JsonObject hints = new JsonObject();
            int oppMaxPower = 0;
            for (Player o : ch.player.getOpponents()) for (Card b : o.getCreaturesInPlay()) if (!b.isTapped()) oppMaxPower = Math.max(oppMaxPower, b.getNetPower());
            hints.addProperty("opponentMaxUntappedPower", oppMaxPower);
            List<String> r = ch.ask("attackers", prompt + "\nChoose all your attacking creatures at once (none = no attack).", attackers, 0, attackers.size(), hints);
            for (String id : r == null ? List.<String>of() : r) { final String pick = id; click(pick, game); }
            if (current(in)) click("ok", game);
            return true;
        }
        if (in instanceof InputBlock && game.getCombat() != null) {
            // One decision: every "blocker blocks attacker" pair at once; the driver clicks attacker then blocker
            // for each pair, then confirms. Forge validates the blocks (menace, requirements) as for a human.
            Combat combat = game.getCombat();
            List<PlayerControllerExternal.Opt> pairs = new ArrayList<>();
            java.util.Map<String, Card[]> byId = new java.util.HashMap<>();
            int incoming = 0;
            for (Card a : combat.getAttackers()) if (combat.getDefenderByAttacker(a) == ch.player) incoming += a.getNetCombatDamage();
            for (Card b : ch.player.getCreaturesInPlay()) {
                if (!CombatUtil.canBlock(b, combat)) continue;
                for (Card a : combat.getAttackers()) {
                    if (!CombatUtil.canBlock(a, b, combat)) continue;
                    String id = StateView.id(b) + "->" + StateView.id(a);
                    JsonObject meta = new JsonObject();
                    meta.addProperty("attackerPower", a.getNetPower());
                    meta.addProperty("blockerSurvives", a.getNetPower() < b.getNetToughness() - b.getDamage() && !a.hasKeyword("Deathtouch"));
                    meta.addProperty("killsAttacker", b.getNetPower() >= a.getNetToughness() - a.getDamage() || (b.hasKeyword("Deathtouch") && b.getNetPower() > 0));
                    pairs.add(new PlayerControllerExternal.Opt(id, b.getName() + " " + b.getNetPower() + "/" + b.getNetToughness() + " (" + StateView.id(b) + ") blocks "
                            + a.getName() + " " + a.getNetPower() + "/" + a.getNetToughness() + " (" + StateView.id(a) + ")", b.getName(), meta));
                    byId.put(id, new Card[]{b, a});
                }
            }
            if (pairs.isEmpty()) { ch.auto("forced", "blockers", "no creature can block"); click("ok", game); return true; }
            JsonObject hints = new JsonObject();
            hints.addProperty("incomingLethal", incoming >= ch.player.getLife());
            trace("blocks: pairs=" + pairs.size() + " lastError=" + gui.lastError);
            List<String> r = ch.ask("blockers", prompt + "\nChoose all your blocks at once: each of your creatures blocks at most one attacker; several may block the same attacker. None = no blocks.",
                    pairs, 0, ch.player.getCreaturesInPlay().size(), hints);
            for (String id : r == null ? List.<String>of() : r) {
                Card[] ba = byId.get(id);
                if (!current(in)) break;
                click(StateView.id(ba[1]), game); // choose the attacker
                click(StateView.id(ba[0]), game); // then the blocker
            }
            if (current(in)) click("ok", game);
            return true;
        }
        if (in instanceof InputSelectTargets || in instanceof InputSelectManyBase) {
            // One decision: all the targets / cards at once, within Forge's own min/max, then OK. A forfeit or no
            // answer presses the null button (Cancel during a cast, which rolls it back).
            List<PlayerControllerExternal.Opt> picks = new ArrayList<>();
            for (PlayerControllerExternal.Opt o : opts) if (!o.id.equals("ok") && !o.id.equals("cancel")) picks.add(o);
            // Bounds: the input's own min/max for list selections (not every one announces them), else setSelectables'.
            int[] own = ownBounds(in);
            int max = Math.max(1, Math.min(own != null ? own[1] : gui.selMax, picks.size()));
            int min = Math.max(0, Math.min(own != null ? own[0] : gui.selMin, max));
            if (picks.isEmpty()) { click(gui.okEnabled ? "ok" : "cancel", game); return true; }
            if (++batches > ch.ctx.maxRetries + 1) {
                // The agent's selections never completed this step: forfeit with the null action, i.e. the null button
                // if there is one, else the first legal choices in engine order.
                if (gui.cancelEnabled || gui.okEnabled) {
                    ch.forfeited(kindOf(in), "selection didn't complete the step in " + (ch.ctx.maxRetries + 1) + " tries; pressed " + (gui.cancelEnabled ? gui.cancelLabel : gui.okLabel));
                    click(gui.cancelEnabled ? "cancel" : "ok", game);
                } else if (batches == ch.ctx.maxRetries + 2) {
                    ch.forfeited(kindOf(in), "selection didn't complete the step in " + (ch.ctx.maxRetries + 1) + " tries; first legal choices");
                    java.util.Collection<?> already = entityList(in, "selected");
                    java.util.Set<String> have = new java.util.HashSet<>();
                    if (already != null) for (Object o : already) have.add(o instanceof Card ac ? StateView.id(ac) : o instanceof Player ap ? "player:" + ap.getId() : "");
                    java.util.Set<String> want = new java.util.HashSet<>();
                    for (int i = 0; i < Math.max(1, min) && i < picks.size(); i++) want.add(picks.get(i).id);
                    for (String id : have) if (!want.contains(id) && !id.isEmpty()) queued.add(id);
                    for (String id : want) if (!have.contains(id)) queued.add(id);
                    queued.add("ok");
                } else {
                    ch.client.error("input driver: " + in.getClass().getSimpleName() + " still open after the null action; prompt=" + StateView.clean(gui.prompt).replace('\n', ' '));
                }
                return true;
            }
            List<String> r = ch.ask(kindOf(in), prompt + "\nChoose " + (min == max ? String.valueOf(min) : min + " to " + max) + " at once.", picks, min, max, null);
            if (r == null || ch.lastAnswerForfeit) {
                click(gui.cancelEnabled ? "cancel" : "ok", game);
                return true;
            }
            // Clicking toggles a selection, so click only the differences from what is already selected.
            java.util.Collection<?> already = entityList(in, "selected");
            java.util.Set<String> want = new java.util.HashSet<>(r), have = new java.util.HashSet<>();
            if (already != null) for (Object o : already) have.add(o instanceof Card ac ? StateView.id(ac) : o instanceof Player ap ? "player:" + ap.getId() : "");
            for (String id : have) if (!want.contains(id) && !id.isEmpty()) queued.add(id);   // deselect
            for (String id : r) if (!have.contains(id)) queued.add(id);                     // select
            queued.add("ok"); // confirm once the picks are made (ignored if the input already finished)
            return true;
        }
        if (in instanceof InputPayMana) {
            List<PlayerControllerExternal.Opt> sources = new ArrayList<>();
            java.util.Set<String> kinds = new java.util.HashSet<>();
            boolean interchangeable = true;
            for (PlayerControllerExternal.Opt o : opts) if (o.id.matches("c\\d+")) {
                sources.add(o);
                kinds.add(o.card);
                Card src = game.findById(Integer.parseInt(o.id.substring(1)));
                if (src == null || !interchangeableSource(src)) interchangeable = false;
            }
            int need = remainingMana(in);
            // Forge enables Auto only when the cost can be paid. Unpayable: cancel (the cast rolls back).
            // Every legal payment taps the same kind of source: let Auto pay. Otherwise the agent picks the sources.
            if (!gui.okEnabled) {
                ch.auto("forced", "mana_payment", "cost can't be paid: cast cancelled");
                click(gui.cancelEnabled ? "cancel" : "ok", game);
                return true;
            }
            if (sources.size() <= need || (kinds.size() <= 1 && interchangeable)) {
                if (sources.size() <= need) ch.auto("forced", "mana_payment", "exactly enough sources");
                else ch.auto("policy", "mana_payment", "interchangeable sources: same-name lands, nothing attached, no counters (Forge's Auto pays)");
                click("ok", game);
                return true;
            }
            if (++batches > ch.ctx.maxRetries + 1) {
                ch.forfeited("mana_payment", "chosen sources never completed the payment in " + (ch.ctx.maxRetries + 1) + " tries; cast cancelled");
                click(gui.cancelEnabled ? "cancel" : "ok", game);
                return true;
            }
            List<String> r = ch.ask("mana_payment", prompt + "\nChoose the mana sources to tap for this cost: " + need
                    + " mana in total, so pick at least " + need + " source(s).", sources, Math.min(need, sources.size()), sources.size(), null);
            if (r != null) queued.addAll(r); // clicked one per step, each after the previous activation finishes
            return true;
        }

        List<String> r = ch.ask(kindOf(in), prompt, opts, 1, 1, null);
        trace("asked " + kindOf(in) + " opts=" + opts.size() + " -> " + r);
        String choice = r == null || r.isEmpty() ? (gui.cancelEnabled ? "cancel" : gui.okEnabled ? "ok" : null) : r.get(0);
        if (choice == null) return false;

        // A click that changes nothing, repeated past the retry budget, is a forfeit: take the null button.
        repeats = choice.equals(lastChoice) ? repeats + 1 : 0;
        lastChoice = choice;
        if (repeats > ch.ctx.maxRetries && !choice.equals("ok") && !choice.equals("cancel")) {
            ch.forfeited(kindOf(in), "same click " + (repeats) + " times without effect; pressed " + (gui.cancelEnabled ? gui.cancelLabel : gui.okLabel));
            choice = gui.cancelEnabled ? "cancel" : "ok";
        }
        final String pick = choice;
        if (in instanceof InputPassPriority && pick.matches("c\\d+")) { lastPriorityCard = Integer.parseInt(pick.substring(1)); lastPriorityKey = stateKey(game); }
        click(pick, game);
        return true;
    }

    /** Whether a player is actually among this input's valid choices (reflection: the fields are private). */
    private static boolean playerSelectable(Input in, Player p) {
        try {
            if (in instanceof InputSelectEntitiesFromList) {
                java.lang.reflect.Field f = InputSelectEntitiesFromList.class.getDeclaredField("validChoices");
                f.setAccessible(true);
                Object v = f.get(in);
                return v instanceof java.util.Collection<?> c && c.contains(p);
            }
            if (in instanceof InputSelectTargets) {
                java.lang.reflect.Field f = InputSelectTargets.class.getDeclaredField("sa");
                f.setAccessible(true);
                Object sa = f.get(in);
                return !(sa instanceof SpellAbility a) || a.canTarget(p);
            }
        } catch (ReflectiveOperationException | RuntimeException e) {
            return true; // can't tell: offer it and let Forge decide (the retry budget bounds a wrong click)
        }
        return true;
    }

    /** Option tags for the built-in bots (rank-bot reads them); LLM prompts show only the label. */
    private JsonObject botTags(Input in, Card c) {
        JsonObject m = new JsonObject();
        if (in instanceof InputPassPriority) {
            boolean land = c.isLand() && c.isInZone(ZoneType.Hand);
            m.addProperty("type", land ? "land" : c.isInZone(ZoneType.Battlefield) ? "ability" : "spell");
            m.addProperty("cmc", c.getCMC());
        } else if (in instanceof InputAttack) {
            m.addProperty("power", c.getNetPower());
            m.addProperty("toughness", c.getNetToughness());
            m.addProperty("evasive", c.hasKeyword("Flying"));
        } else if (in instanceof InputSelectTargets) {
            m.addProperty("hostile", !c.getController().equals(ch.player));
        }
        return m;
    }

    /** Something on this card can be done right now: a land drop, or a non-mana ability that is playable and affordable. */
    private boolean playableNow(Card c) {
        // Forge's affordability probe asks the player's controller to choose permanents for convoke/improvise/delve;
        // with the human controller that opens a real input. Offer those unfiltered and let Forge's payment decide.
        if (c.hasKeyword(Keyword.CONVOKE) || c.hasKeyword(Keyword.IMPROVISE) || c.hasKeyword(Keyword.DELVE)) return true;
        try {
            for (SpellAbility sa : c.getAllPossibleAbilities(ch.player, true)) {
                if (sa.isManaAbility()) continue;
                if (sa.isLandAbility()) { if (ch.player.canPlayLand(c, false, sa)) return true; continue; }
                if (ComputerUtilCost.canPayCost(sa, ch.player, false)) return true;
            }
        } catch (RuntimeException e) {
            return true; // can't probe it: offer it and let Forge decide
        }
        return false;
    }

    private String stateKey(Game g) {
        return g.getPhaseHandler().getTurn() + "|" + g.getPhaseHandler().getPhase() + "|" + g.getStack().size()
                + "|" + g.getCardsIn(ZoneType.Battlefield).size() + "|" + ch.player.getCardsIn(ZoneType.Hand).size()
                + "|" + ch.player.getManaPool().totalMana();
    }

    /** A source whose choice can't matter beyond its name: a land with nothing attached and no counters. */
    static boolean interchangeableSource(Card c) {
        return c.isLand() && !c.isCreature() && c.getAttachedCards().isEmpty() && (c.getCounters() == null || c.getCounters().isEmpty());
    }

    /** Mana still owed by this payment input (InputPayMana.manaCost is protected). */
    private static int remainingMana(Input in) {
        try {
            java.lang.reflect.Field f = InputPayMana.class.getDeclaredField("manaCost");
            f.setAccessible(true);
            ManaCostBeingPaid m = (ManaCostBeingPaid) f.get(in);
            return m == null ? 1 : Math.max(1, m.getConvertedManaCost());
        } catch (ReflectiveOperationException | RuntimeException e) {
            return 1;
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
