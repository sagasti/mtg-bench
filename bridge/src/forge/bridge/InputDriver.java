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
import forge.gamemodes.match.input.InputConfirm;
import forge.gamemodes.match.input.InputConfirmMulligan;
import forge.gamemodes.match.input.InputLockUI;
import forge.gamemodes.match.input.InputLondonMulligan;
import forge.gamemodes.match.input.InputPassPriority;
import forge.gamemodes.match.input.InputPayMana;
import forge.gamemodes.match.input.InputSelectEntitiesFromList;
import forge.gamemodes.match.input.InputSelectManyBase;
import forge.gamemodes.match.input.InputSelectTargets;
import forge.player.PlayerControllerHuman;
import forge.util.Localizer;

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
    /** Cards the affordability filter kept off a priority question, by "turn:card" (each counted once per turn). */
    private final java.util.Set<String> filtered = new java.util.HashSet<>();
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

    /** Consecutive exceptions while driving the same input; a repeatable one would otherwise re-drive it forever. */
    private Input failedInput = null;
    private int failures = 0;
    private static final int MAX_FAILURES_PER_INPUT = 3;

    @Override
    public void run() {
        while (true) {
            Input in = null;
            try {
                in = pending.poll(1, TimeUnit.SECONDS);
                if (in == null) {
                    // Never leave an open input unattended: pick it up again if no event announced it.
                    Input open = ctl.getInputQueue().getInput();
                    if (open != null && !(open instanceof InputLockUI) && !ch.player.getGame().isGameOver()) in = open;
                }
                if (in != null) { drive(in); failedInput = null; failures = 0; }
            } catch (InterruptedException e) {
                return;
            } catch (Throwable t) {
                t.printStackTrace();
                ch.client.error("input driver: " + t);
                failures = in != null && in == failedInput ? failures + 1 : 1;
                failedInput = in;
                if (failures >= MAX_FAILURES_PER_INPUT) {
                    // Never loop silently: the same input failing again and again ends the match as an error.
                    ch.client.error("input driver: " + failures + " consecutive failures on " + (in != null ? in.getClass().getSimpleName() : "?") + "; aborting");
                    dumpThreads();
                    System.exit(3);
                }
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
    /**
     * Attack/block declarations tried in the current combat step. Counted per turn and step, not per input: Forge
     * answers a rejected attack with a fresh InputAttack on the same combat.
     */
    private int declarations = 0;
    private String declarationKey = "";
    /** Batched selections tried on the current input (targets, card lists, mana). */
    private int batches = 0;
    /** Single-click questions asked on the current input. */
    private int asks = 0;
    /** What the current payment still owed when Auto was pressed (null: not pressed since), and whether Auto failed on it. */
    private String owedAtAuto = null;
    private boolean autoFailed = false;
    /** Whether the last Auto press was seen starting its payment task, and presses Forge ignored on this payment. */
    private boolean autoStarted = false;
    private int autoIgnored = 0;
    /** Every source of the current payment was tapped without asking (they were all needed). */
    private boolean tappedAll = false;

    private void drive(Input in) throws Exception {
        trace("drive " + in.getClass().getSimpleName());
        lastChoice = null;
        repeats = 0;
        queued.clear();
        Game g = ch.player.getGame();
        String key = in instanceof InputAttack || in instanceof InputBlock
                ? g.getPhaseHandler().getTurn() + ":" + g.getPhaseHandler().getPhase() + ":" + in.getClass().getSimpleName() + ":" + System.identityHashCode(g.getCombat()) : "";
        if (key.isEmpty() || !key.equals(declarationKey)) declarations = 0;
        declarationKey = key;
        batches = 0;
        asks = 0;
        owedAtAuto = null;
        autoFailed = false;
        autoStarted = false;
        autoIgnored = 0;
        tappedAll = false;
        // The game thread posts the input's first message to the event thread after announcing the input, so the
        // flushes in awaitMessage can run before it is even posted; until it has run, the prompt and buttons are the
        // previous input's (and InputAttack has no defender yet). Wait for this input's own message, briefly.
        long shown = System.currentTimeMillis() + 2_000;
        while (in == lastQueued && gui.promptSeq == seqAtQueue && current(in) && System.currentTimeMillis() < shown) Thread.sleep(2);
        for (click = 0; click < MAX_CLICKS_PER_INPUT && current(in); click++) {
            awaitMessage(in);
            // Forge activates a mana source asynchronously (on a game executor thread); wait for it like a human would
            // before the next click, or two activations touch the cost-payment stack at once.
            long activationDeadline = System.currentTimeMillis() + 30_000;
            boolean heldOpen = false;
            while (in instanceof InputPayMana pm && (pm.isActivatingManaAbility() || manaTask() > 0) && current(in)) {
                if (!pm.isActivatingManaAbility() && !heldOpen) { heldOpen = true; System.err.println("[driver " + ch.seat + "] payment unlocked while its activation still runs: waiting"); }
                if (manaTask() == 2) activationDeadline = System.currentTimeMillis() + 30_000; // the agent is answering
                if (System.currentTimeMillis() > activationDeadline) {
                    // Never hang silently: a mana activation that doesn't finish ends the match as an error.
                    ch.client.error("input driver: mana activation still running after 30 s; prompt=" + StateView.clean(gui.prompt).replace('\n', ' '));
                    dumpThreads();
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
            dumpThreads();
            System.exit(3);
        }
    }

    /**
     * The input's own min/max, or null: an InputSelectManyBase's fields; for targets, the ability's (or the input's
     * fixed numTargets) less the targets already chosen; for the London mulligan, the cards still to put on the bottom.
     * (setSelectables can't be relied on: InputSelectTargets calls it in its constructor, before the input is queued.)
     */
    private int[] ownBounds(Input in) {
        if (in instanceof InputSelectTargets) {
            SpellAbility sa = targetingAbility(in);
            if (sa == null) return null;
            try {
                java.lang.reflect.Field fn = InputSelectTargets.class.getDeclaredField("numTargets");
                fn.setAccessible(true);
                Integer num = (Integer) fn.get(in);
                int chosen = sa.getTargets().size();
                int lo = num != null ? num : sa.getMinTargets(), hi = num != null ? num : sa.getMaxTargets();
                return new int[] { Math.max(0, lo - chosen), Math.max(0, hi - chosen) };
            } catch (ReflectiveOperationException | RuntimeException e) {
                return null;
            }
        }
        if (in instanceof InputLondonMulligan) {
            try {
                java.lang.reflect.Field f = InputLondonMulligan.class.getDeclaredField("toReturn");
                f.setAccessible(true);
                int n = f.getInt(in);
                return new int[] { n, n };
            } catch (ReflectiveOperationException | RuntimeException e) {
                return null;
            }
        }
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

    /** The spell or ability a targeting input chooses targets for (reflection: private field), or null. */
    private static SpellAbility targetingAbility(Input in) {
        if (!(in instanceof InputSelectTargets)) return null;
        try {
            java.lang.reflect.Field f = InputSelectTargets.class.getDeclaredField("sa");
            f.setAccessible(true);
            return f.get(in) instanceof SpellAbility sa ? sa : null;
        } catch (ReflectiveOperationException | RuntimeException e) {
            return null;
        }
    }

    /** The cards a targeting input accepts (reflection: private field "choices"), or null for other inputs. */
    @SuppressWarnings("unchecked")
    private static java.util.Collection<Card> targetChoices(Input in) {
        if (!(in instanceof InputSelectTargets)) return null;
        try {
            java.lang.reflect.Field f = InputSelectTargets.class.getDeclaredField("choices");
            f.setAccessible(true);
            return f.get(in) instanceof java.util.Collection<?> c ? (java.util.Collection<Card>) c : null;
        } catch (ReflectiveOperationException | RuntimeException e) {
            return null;
        }
    }

    /** Cards already chosen for the bottom in a London mulligan (reflection: private field). */
    private static java.util.Collection<?> londonSelected(Input in) {
        try {
            java.lang.reflect.Field f = InputLondonMulligan.class.getDeclaredField("selected");
            f.setAccessible(true);
            return f.get(in) instanceof java.util.Collection<?> c ? c : null;
        } catch (ReflectiveOperationException | RuntimeException e) {
            return null;
        }
    }

    /**
     * 1 while one of Forge's payment tasks (InputPayMana's activation or Auto, run on a game pool thread) is still
     * working rather than parked on an input. Forge clears the payment's lock when the payment is re-shown after a
     * nested input closes (Prophetic Prism's {1}), before the activation that opened it has finished; acting then runs
     * two controller swaps at once, and Forge's controller map isn't thread-safe. 2 while that task is waiting for the
     * agent (a colour choice), 0 when none is running.
     */
    private static int manaTask() {
        Thread self = Thread.currentThread();
        int state = 0;
        for (java.util.Map.Entry<Thread, StackTraceElement[]> e : Thread.getAllStackTraces().entrySet()) {
            if (e.getKey() == self) continue;
            boolean asking = false;
            for (StackTraceElement el : e.getValue()) {
                if (el.getClassName().startsWith("forge.gamemodes.match.input.InputSyncronizedBase")
                        && el.getMethodName().equals("awaitLatchRelease")) break; // parked on an input: the driver must act
                if (el.getClassName().equals(AgentChannel.class.getName())) asking = true;
                if (el.getClassName().equals("forge.gamemodes.match.input.InputPayMana")
                        && el.getMethodName().startsWith("lambda$")) { state = Math.max(state, asking ? 2 : 1); break; }
            }
        }
        return state;
    }

    /** Before aborting a match: every thread's stack to the match log, so the stall can be diagnosed afterwards. */
    private static void dumpThreads() {
        StringBuilder sb = new StringBuilder("=== thread dump at abort ===\n");
        for (java.util.Map.Entry<Thread, StackTraceElement[]> e : Thread.getAllStackTraces().entrySet()) {
            sb.append('"').append(e.getKey().getName()).append("\" ").append(e.getKey().getState()).append('\n');
            for (StackTraceElement el : e.getValue()) sb.append("    at ").append(el).append('\n');
        }
        System.err.println(sb);
        System.err.flush();
    }

    /** The input's own list of valid choices, for diagnostics (reflection: private field). */
    private static String validChoices(Input in) {
        try {
            if (in instanceof InputSelectEntitiesFromList) {
                java.lang.reflect.Field f = InputSelectEntitiesFromList.class.getDeclaredField("validChoices");
                f.setAccessible(true);
                return String.valueOf(f.get(in));
            }
            if (in instanceof InputSelectTargets) return String.valueOf(targetChoices(in));
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
        Localizer loc = Localizer.getInstance();
        if (in instanceof InputPassPriority) {
            if (gui.okLabel.equals(loc.getMessage("lblAccept")) && gui.cancelLabel.equals(loc.getMessage("lblDecline"))) {
                // Forge's yield suggestion ("pass until ..."): accepting would skip later priority without asking.
                ch.auto("policy", "priority", "Forge's auto-yield suggestion declined");
                click("cancel", game);
                return true;
            }
            // A cast that failed (cancelled, unpayable) leaves the state unchanged: don't offer it again until it changes.
            String key = stateKey(game);
            if (!key.equals(withheldKey)) { withheld.clear(); withheldKey = key; }
            if (filtered.size() > 1000) filtered.clear();
            if (lastPriorityCard != null && key.equals(lastPriorityKey) && withheld.add(lastPriorityCard))
                ch.auto("policy", "priority", "card withheld: its cast just failed and the state is unchanged");
            lastPriorityCard = null;
        }
        if (in instanceof InputConfirm && gui.cancelLabel.equals(loc.getMessage("lblEndTurn"))) {
            // An opponent's revealed hand: OK acknowledges it, "End Turn" would skip the rest of the turn. The cards go to
            // the agent as information with its next decision (AgentGuiGame.showRevealedCards).
            ch.auto("forced", "reveal", "revealed cards acknowledged");
            click("ok", game);
            return true;
        }
        if (in instanceof InputAttack && game.getCombat() != null) {
            // Every ask is a clean "choose the set": undo this seat's earlier declarations (a rejected attack comes back
            // as a new input with them still declared, and clicking one again would remove it).
            Combat combat = game.getCombat();
            for (Card c : new ArrayList<>(combat.getAttackers())) if (c.getController().equals(ch.player)) combat.removeFromCombat(c);
        }
        if (in instanceof InputBlock && game.getCombat() != null) {
            // Same for blocks: a creature already blocking can't be offered again, so a retry could only add blocks.
            for (Card c : ch.player.getCreaturesInPlay()) if (game.getCombat().isBlocking(c)) game.getCombat().undoBlockingAssignment(c);
        }

        List<PlayerControllerExternal.Opt> opts = new ArrayList<>();
        List<Card> cards = new ArrayList<>();
        java.util.Collection<?> listChoices = entityList(in, "validChoices");
        java.util.Collection<Card> targetChoices = targetChoices(in);
        if (listChoices != null) {
            // "Choose from a list" inputs: offer exactly the input's own valid choices (hover text can be empty for them).
            for (Object o : listChoices) if (o instanceof Card lc) cards.add(lc);
        } else if (targetChoices != null) {
            // Targets: the input's own valid cards, in whatever zone and under whoever's control (an opponent's
            // graveyard, exile...). Forge built the list for this seat, so it holds nothing the seat can't select.
            cards.addAll(targetChoices);
        } else if (in instanceof InputLondonMulligan) {
            // Forge's input offers no card actions (a human clicks the hand); the hand is the choice.
            cards.addAll(ch.player.getCardsIn(ZoneType.Hand));
        } else {
            for (Player p : game.getPlayers()) {
                cards.addAll(p.getCardsIn(ZoneType.Battlefield));
                if (p.equals(ch.player)) {
                    cards.addAll(p.getCardsIn(ZoneType.Hand));
                    cards.addAll(p.getCardsIn(ZoneType.Graveyard));
                    cards.addAll(p.getCardsIn(ZoneType.Exile));
                    cards.addAll(p.getCardsIn(ZoneType.Command));
                }
            }
        }
        for (Card c : cards) {
            String act;
            try { act = listChoices != null || in instanceof InputLondonMulligan ? "select card" : in.getActivateAction(c); } catch (RuntimeException e) { act = null; }
            if (act == null) continue;
            String why = in instanceof InputPassPriority ? whyNotPlayable(c) : null;
            if (why != null) {
                // Offered by the human UI even when unaffordable or without a legal target; counted once per card, turn
                // and reason, so the filter's reach (and any false negatives) is visible in the report.
                if (filtered.add(game.getPhaseHandler().getTurn() + ":" + c.getId() + ":" + why)) ch.auto("policy", "priority", why);
                continue;
            }
            if (in instanceof InputPassPriority && withheld.contains(c.getId())) continue;
            String who = c.getController().equals(ch.player) ? "your " : "opponent's ";
            String zone = c.getZone() != null && c.getZone().getZoneType() != ZoneType.Battlefield ? " [" + c.getZone().getZoneType() + "]" : "";
            // A face-down card the seat may not look at (a morph, a card exiled face down) is named as such.
            String name = c.isFaceDown() && !c.getView().canFaceDownBeShownTo(ch.player.getView()) ? "face-down card" : c.getName();
            opts.add(new PlayerControllerExternal.Opt(StateView.id(c), act + ": " + who + name + (c.isCreature() ? " " + c.getNetPower() + "/" + c.getNetToughness() : "")
                    + (c.isTapped() ? " (tapped)" : "") + zone, name, botTags(in, c)));
        }
        if (in instanceof InputSelectTargets || in instanceof InputSelectEntitiesFromList || in instanceof InputAttack) {
            for (Player p : game.getPlayers()) if (!(in instanceof InputAttack && p.equals(ch.player)) && (listChoices != null ? listChoices.contains(p) : playerSelectable(in, p))) {
                JsonObject meta = new JsonObject();
                meta.addProperty("hostile", !p.equals(ch.player));
                opts.add(new PlayerControllerExternal.Opt("player:" + p.getId(), "Select player: " + (p.equals(ch.player) ? "you" : "opponent"), null, meta));
            }
        }
        // Buttons. OK is the null action ("pass") only where it means pass or keep; Cancel only while casting (it rolls
        // the cast back). Helper buttons that hand the turn or a choice to Forge are never offered: "End Turn" / "Undo"
        // at priority (Forge would then pass every priority this turn without asking), "Auto" on the London mulligan, "Alpha Strike" / "Call Back" when attacking.
        boolean castingStep = in instanceof InputSelectTargets || in instanceof InputPayMana;
        boolean okIsPass = in instanceof InputPassPriority || in instanceof InputConfirmMulligan;
        boolean helperCancel = in instanceof InputPassPriority || in instanceof InputLondonMulligan || in instanceof InputAttack;
        if (gui.okEnabled) opts.add(new PlayerControllerExternal.Opt("ok", "Button: " + gui.okLabel, null, okIsPass ? passMeta() : null));
        if (gui.cancelEnabled && !helperCancel) opts.add(new PlayerControllerExternal.Opt("cancel", "Button: " + gui.cancelLabel, null, castingStep ? passMeta() : null));
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

        // Attacks and blocks are one decision each: the whole set at once. The driver clicks it, then checks it with
        // Forge's own validation before confirming, so a rejection comes back to the agent at once, with the reason.
        if ((in instanceof InputAttack || in instanceof InputBlock) && game.getCombat() != null && ++declarations > ch.ctx.maxRetries + 1) {
            // Forge kept rejecting the agent's declarations (menace, "must attack/block" requirements...).
            // First the null action (no attack / no blocks, counted as a forfeit); if even that is illegal, Forge's AI
            // declares a legal set (counted as delegated). Both are reported. The seat's declarations were undone above.
            Combat combat = game.getCombat();
            boolean attack = in instanceof InputAttack;
            String what = attack ? "attackers" : "blockers";
            if (attack ? CombatUtil.validateAttackers(combat) : CombatUtil.validateBlocks(combat, ch.player) == null) {
                ch.forfeited(what, "declaration rejected " + (ch.ctx.maxRetries + 1) + " times; null action: " + (attack ? "no attack" : "no blocks"));
            } else {
                if (attack) new AiAttackController(ch.player).declareAttackers(combat);
                else new AiBlockController(ch.player, false).assignBlockersForCombat(combat);
                ch.delegated(what, "declaration rejected and the null action is illegal (a requirement applies); Forge's AI declared");
            }
            click("ok", game);
            if (current(in) && declarations > ch.ctx.maxRetries + 2)
                ch.client.error("input driver: " + what + " still open after the null action / the AI's declaration; lastError=" + gui.lastError);
            return true;
        }
        if (in instanceof InputAttack && game.getCombat() != null) {
            Combat combat = game.getCombat();
            List<PlayerControllerExternal.Opt> attackers = new ArrayList<>();
            for (PlayerControllerExternal.Opt o : opts) if (o.id.matches("c\\d+")) attackers.add(o);
            JsonObject hints = new JsonObject();
            int oppMaxPower = 0;
            for (Player o : ch.player.getOpponents()) for (Card b : o.getCreaturesInPlay()) if (!b.isTapped()) oppMaxPower = Math.max(oppMaxPower, b.getNetPower());
            hints.addProperty("opponentMaxUntappedPower", oppMaxPower);
            ch.attempt = declarations - 1;
            List<String> r = ch.ask("attackers", prompt + "\nChoose all your attacking creatures at once (none = no attack).", attackers, 0, attackers.size(), hints);
            for (String id : r == null ? List.<String>of() : r) { final String pick = id; click(pick, game); }
            String why = gui.lastError;
            if (why == null && !CombatUtil.validateAttackers(combat))
                why = "that attack breaks a requirement or restriction (for example a creature that must attack, or one that can't attack alone)";
            if (why != null) { gui.lastError = why; return true; } // asked again (the input stays open), within the budget above
            if (current(in)) click("ok", game);
            return true;
        }
        if (in instanceof InputBlock && game.getCombat() != null) {
            // One decision: every "blocker blocks attacker" pair at once; the driver clicks attacker then blocker
            // for each pair, then confirms.
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
            trace("blocks: pairs=" + pairs.size() + " lastError=" + err);
            ch.attempt = declarations - 1;
            List<String> r = ch.ask("blockers", prompt + "\nChoose all your blocks at once: each of your creatures blocks at most one attacker; several may block the same attacker. None = no blocks.",
                    pairs, 0, ch.player.getCreaturesInPlay().size(), hints);
            for (String id : r == null ? List.<String>of() : r) {
                Card[] ba = byId.get(id);
                if (!current(in)) break;
                click(StateView.id(ba[1]), game); // choose the attacker
                click(StateView.id(ba[0]), game); // then the blocker
            }
            String why = gui.lastError;
            if (why == null) why = CombatUtil.validateBlocks(combat, ch.player); // what InputBlock.onOk would reject, but asynchronously
            if (why != null) { gui.lastError = why; return true; } // asked again (the input stays open), within the budget above
            if (current(in)) click("ok", game);
            return true;
        }
        if (in instanceof InputSelectTargets || in instanceof InputSelectManyBase || in instanceof InputLondonMulligan) {
            // One decision: all the targets / cards at once, within Forge's own min/max, then OK. A forfeit presses the
            // null button if there is one (Cancel during a cast, which rolls it back), else applies the harness's
            // null action (the first legal choices) like any answer.
            List<PlayerControllerExternal.Opt> picks = new ArrayList<>();
            for (PlayerControllerExternal.Opt o : opts) if (!o.id.equals("ok") && !o.id.equals("cancel")) picks.add(o);
            int[] own = ownBounds(in);
            int max = Math.max(1, Math.min(own != null ? own[1] : gui.selMax, picks.size()));
            int min = Math.max(0, Math.min(own != null ? own[0] : gui.selMin, max));
            boolean cancel = gui.cancelEnabled && !helperCancel;
            if (picks.isEmpty()) {
                if (gui.okEnabled || cancel) click(gui.okEnabled ? "ok" : "cancel", game);
                return true;
            }
            if (++batches > ch.ctx.maxRetries + 1) {
                // The agent's selections never completed this step: forfeit with the null action, i.e. the null button
                // if there is one, else the first legal choices in engine order.
                if (cancel || gui.okEnabled) {
                    ch.forfeited(kindOf(in), "selection didn't complete the step in " + (ch.ctx.maxRetries + 1) + " tries; pressed " + (cancel ? gui.cancelLabel : gui.okLabel));
                    click(cancel ? "cancel" : "ok", game);
                } else if (batches == ch.ctx.maxRetries + 2) {
                    ch.forfeited(kindOf(in), "selection didn't complete the step in " + (ch.ctx.maxRetries + 1) + " tries; first legal choices");
                    List<String> first = new ArrayList<>();
                    for (int i = 0; i < Math.max(1, min) && i < picks.size(); i++) first.add(picks.get(i).id);
                    select(in, first);
                } else {
                    ch.client.error("input driver: " + in.getClass().getSimpleName() + " still open after the null action; prompt=" + StateView.clean(gui.prompt).replace('\n', ' '));
                }
                return true;
            }
            String cast = castingContext(in);
            ch.attempt = batches - 1;
            List<String> r = ch.ask(kindOf(in), (cast != null ? cast + "\n" : "") + prompt + "\nChoose " + (min == max ? String.valueOf(min) : min + " to " + max) + " at once.", picks, min, max, null);
            if (ch.lastAnswerForfeit && cancel) { click("cancel", game); return true; }
            if (r == null) {
                // No usable answer (the harness always sends one; defensive): the null button, else ask again.
                if (cancel || gui.okEnabled) click(cancel ? "cancel" : "ok", game);
                return true;
            }
            select(in, r);
            return true;
        }
        if (in instanceof InputPayMana) {
            List<PlayerControllerExternal.Opt> sources = new ArrayList<>();
            java.util.Set<String> kinds = new java.util.HashSet<>();
            boolean interchangeable = true;
            SpellAbility paidFor = paidFor(in);
            ManaCostBeingPaid owing = owing(in);
            for (PlayerControllerExternal.Opt o : opts) if (o.id.matches("c\\d+")) {
                Card offered = game.findById(Integer.parseInt(o.id.substring(1)));
                // Only sources that can make a type of mana still owed (Forge marks a Forest when only {B} is owed).
                if (offered != null && paidFor != null && owing != null && !Playability.helpsPay(offered, owing, paidFor, ch.player)) continue;
                sources.add(o);
                kinds.add(o.card);
                Card src = game.findById(Integer.parseInt(o.id.substring(1)));
                if (src == null || !interchangeableSource(src)) interchangeable = false;
            }
            int need = remainingMana(in);
            // Never compare or re-plan while a payment task may still run: its controller swap would race the plan's.
            // (drive() waits for it before each step; this keeps that true here.) Retried next step.
            if (((InputPayMana) in).isActivatingManaAbility() || manaTask() > 0) {
                trace("payment: a payment task is still running; waiting");
                return true;
            }
            // Auto pressed on this payment last step and nothing changed: Forge's AI payer couldn't pay. No more Auto here.
            // Only a press whose task was seen starting counts; a press Forge ignored is retried, at most twice.
            String owed = owedKey(in);
            if (owedAtAuto != null && owedAtAuto.equals(owed) && !autoFailed) {
                if (autoStarted || ++autoIgnored > 2) {
                    autoFailed = true;
                    trace("payment: Auto changed nothing (task " + (autoStarted ? "ran" : "never started") + "); asking for sources instead");
                } else {
                    trace("payment: Auto press ignored by Forge; pressing again");
                }
            }
            owedAtAuto = null;
            // Forge enables Auto from a plan it makes once per payment and keeps while plain sources are tapped, so the
            // button stays enabled after the sources it planned are gone (tapped for another part of the cost). Plan again
            // now: no plan means the cost can't be paid any more, whatever the button says.
            List<Card> plan = freshAutoPlan(in);
            // Forge's plan is its AI's: it won't sacrifice Black Lotus for a cheap spell, among other preferences. Without
            // one, the rules-only estimate decides whether the agent can still pay by hand.
            boolean autoPlan = gui.okEnabled && plan != null;
            boolean coverable = autoPlan || (paidFor != null && owing != null && Playability.covers(owing, paidFor, ch.player));
            // The fewest sources whose combined output covers what is owed (a source may make more than one mana).
            List<Integer> outputs = new ArrayList<>();
            for (PlayerControllerExternal.Opt o : sources) {
                Card src = game.findById(Integer.parseInt(o.id.substring(1)));
                outputs.add(src == null ? 1 : Playability.manaFrom(src, paidFor, ch.player));
            }
            int fewest = fewestSources(outputs, need);
            trace("payment: need=" + need + " sources=" + sources.stream().map(o -> o.id + ":" + o.card).toList() + " outputs=" + outputs
                    + " plan=" + plan + " coverable=" + coverable + " pool=" + ch.player.getManaPool().totalMana() + " autoFailed=" + autoFailed);
            // Unpayable: cancel (the cast rolls back), and say why with the next question. Every legal payment taps the
            // same kind of source: let Auto pay (unless manaPayment: always). Otherwise, or once Auto has failed on this
            // payment, the agent picks the sources.
            if (!coverable || ((autoFailed || !autoPlan) && sources.isEmpty())) {
                boolean decline = "pay_or_else".equals(ch.kindHint);
                ch.auto("forced", "mana_payment", decline ? "cost can't be paid: payment declined" : "cost can't be paid: cast cancelled");
                ch.notice(cancelNotice(paidFor, owing, decline));
                if (gui.cancelEnabled) click("cancel", game);
                return true;
            }
            boolean allNeeded = fewest >= sources.size();
            if (allNeeded && (!autoPlan || autoFailed) && !tappedAll) {
                // Every source has to be tapped and Forge's Auto won't: tap them, one per step (once: if that didn't pay
                // the cost, the estimate was wrong and the agent is asked like any other payment).
                tappedAll = true;
                ch.auto("forced", "mana_payment", "exactly enough sources");
                for (PlayerControllerExternal.Opt o : sources) queued.add(o.id);
                return true;
            }
            if (!autoFailed && autoPlan && (allNeeded || (!ch.ctx.alwaysAskMana && kinds.size() <= 1 && interchangeable))) {
                if (allNeeded) ch.auto("forced", "mana_payment", "exactly enough sources");
                else ch.auto("policy", "mana_payment", "interchangeable sources: same-name lands, nothing attached, no counters (Forge's Auto pays)");
                owedAtAuto = owed;
                click("ok", game);
                // InputPayMana.onOk locks the payment before handing Auto to a game thread, and drive() waits for the
                // lock and the task before the next step; a press it ignored leaves both clear.
                autoStarted = ((InputPayMana) in).isActivatingManaAbility() || manaTask() > 0;
                trace("payment: Auto pressed; task " + (autoStarted ? "started" : "not started"));
                return true;
            }
            if (++batches > ch.ctx.maxRetries + 1) {
                ch.forfeited("mana_payment", "chosen sources never completed the payment in " + (ch.ctx.maxRetries + 1) + " tries; cast cancelled");
                click(gui.cancelEnabled ? "cancel" : "ok", game);
                return true;
            }
            ch.attempt = batches - 1;
            List<PlayerControllerExternal.Opt> labelled = new ArrayList<>();
            for (int i = 0; i < sources.size(); i++) {
                PlayerControllerExternal.Opt o = sources.get(i);
                labelled.add(outputs.get(i) > 1 ? new PlayerControllerExternal.Opt(o.id, o.label + " (makes " + outputs.get(i) + " mana)", o.card, o.meta) : o);
            }
            List<String> r = ch.ask("mana_payment", prompt + "\nChoose the mana sources to tap for this cost: " + need + " mana still owed, so choose sources that"
                    + " together make at least " + need + " mana (at least " + fewest + " source(s)). Sources are tapped in the order you list them,"
                    + " and tapping stops once the cost is paid.", labelled, Math.min(fewest, sources.size()), sources.size(), null);
            if (r != null) queued.addAll(r); // clicked one per step, each after the previous activation finishes
            return true;
        }
        if (in instanceof InputConfirmMulligan) {
            // Keep (OK) or mulligan (Cancel), with the tags rank-bot reads. Forge asks at any hand size, but a mulligan
            // from an empty hand does nothing (AbstractMulligan.mulligan returns at once): there, keeping is forced.
            if (ch.player.getCardsIn(ZoneType.Hand).isEmpty()) {
                ch.auto("forced", "mulligan", "keep: no smaller hand possible (the hand is empty)");
                click("ok", game);
                return true;
            }
            List<PlayerControllerExternal.Opt> two = new ArrayList<>();
            JsonObject keep = passMeta(), mull = new JsonObject();
            keep.addProperty("keep", true);
            mull.addProperty("keep", false);
            two.add(new PlayerControllerExternal.Opt("ok", "Button: " + gui.okLabel, null, keep));
            two.add(new PlayerControllerExternal.Opt("cancel", "Button: " + gui.cancelLabel, null, mull));
            int lands = 0;
            for (Card c : ch.player.getCardsIn(ZoneType.Hand)) if (c.isLand()) lands++;
            JsonObject hints = new JsonObject();
            hints.addProperty("handLands", lands);
            // Forge's London mulligan puts the cards on the bottom before asking, so the hand is already its kept size.
            hints.addProperty("handSize", ch.player.getCardsIn(ZoneType.Hand).size());
            List<String> r = ch.ask("mulligan", prompt, two, 1, 1, hints);
            String pick = r == null || r.isEmpty() ? "ok" : r.get(0);
            if (!pick.equals("ok") && noEffectRepeat("mulligan", prompt, two, pick, game)) {
                ch.forfeited("mulligan", noEffectReason(gui.okLabel));
                pick = "ok";
            }
            click(pick, game);
            return true;
        }
        if (in instanceof InputConfirm) {
            // A two-button question. Yes/No answers with ids "yes"/"no" (the harness's null action declines); play/draw
            // with "play"/"draw".
            String kind = kindOf(in);
            boolean yesNo = AgentGuiGame.isYesNo(List.of(gui.okLabel, gui.cancelLabel));
            String yes = kind.equals("play_draw") ? "play" : yesNo ? "yes" : "ok", no = kind.equals("play_draw") ? "draw" : yesNo ? "no" : "cancel";
            List<PlayerControllerExternal.Opt> two = new ArrayList<>();
            if (gui.okEnabled) two.add(new PlayerControllerExternal.Opt(yes, "Button: " + gui.okLabel, null));
            if (gui.cancelEnabled) two.add(new PlayerControllerExternal.Opt(no, "Button: " + gui.cancelLabel, null));
            List<String> r = ch.ask(kind, prompt, two, 1, 1, yesNo ? ch.confirmHints : null);
            String nullPick = gui.cancelEnabled ? no : yes;
            String pick = r == null || r.isEmpty() ? nullPick : r.get(0);
            if (!pick.equals(nullPick) && noEffectRepeat(kind, prompt, two, pick, game)) {
                ch.forfeited(kind, noEffectReason(pick.equals(yes) ? gui.cancelLabel : gui.okLabel));
                pick = nullPick;
            }
            click(pick.equals(yes) ? "ok" : "cancel", game);
            return true;
        }

        ch.attempt = asks++; // the same input still open after a click: a re-ask of this step
        List<String> r = ch.ask(kindOf(in), prompt, opts, 1, 1, null);
        trace("asked " + kindOf(in) + " opts=" + opts.size() + " -> " + r);
        String choice = r == null || r.isEmpty() ? (gui.cancelEnabled && !helperCancel ? "cancel" : gui.okEnabled ? "ok" : null) : r.get(0);
        if (choice == null) return false;

        // A click that changes nothing, repeated past the retry budget, is a forfeit: take the null button.
        repeats = choice.equals(lastChoice) ? repeats + 1 : 0;
        lastChoice = choice;
        if (repeats > ch.ctx.maxRetries && !choice.equals("ok") && !choice.equals("cancel")) {
            String button = gui.cancelEnabled && !helperCancel ? "cancel" : gui.okEnabled ? "ok" : null;
            if (button != null) {
                ch.forfeited(kindOf(in), "same click " + (repeats) + " times without effect; pressed " + (button.equals("cancel") ? gui.cancelLabel : gui.okLabel));
                choice = button;
            }
        }
        String nullButton = gui.cancelEnabled && !helperCancel ? "cancel" : gui.okEnabled ? "ok" : null;
        if (nullButton != null && !choice.equals(nullButton) && noEffectRepeat(kindOf(in), prompt, opts, choice, game)) {
            ch.forfeited(kindOf(in), noEffectReason(nullButton.equals("cancel") ? gui.cancelLabel : gui.okLabel));
            choice = nullButton;
        }
        final String pick = choice;
        if (in instanceof InputPassPriority && pick.matches("c\\d+")) { lastPriorityCard = Integer.parseInt(pick.substring(1)); lastPriorityKey = stateKey(game); }
        click(pick, game);
        return true;
    }

    /** The question last answered and the game's log length then; how often it came back unchanged with the same answer. */
    private String noEffectKey = null;
    private int noEffectRepeats = 0;

    /**
     * Per step, not per input: true once the same question (kind, prompt, options) has come back with the same answer
     * and nothing in the game changed (log length and state key) more than the retry budget allows. Forge may re-show a
     * question as a new input after a click that did nothing (a mulligan from an empty hand), which the per-input count
     * never sees.
     */
    private boolean noEffectRepeat(String kind, String prompt, List<PlayerControllerExternal.Opt> opts, String choice, Game game) {
        StringBuilder key = new StringBuilder(kind).append('|').append(prompt).append('|');
        for (PlayerControllerExternal.Opt o : opts) key.append(o.id).append(',');
        int log;
        try { log = game.getGameLog().getLogEntries(null).size(); } catch (RuntimeException e) { log = -1; }
        key.append('|').append(choice).append('|').append(log).append('|').append(stateKey(game));
        String k = key.toString();
        noEffectRepeats = k.equals(noEffectKey) ? noEffectRepeats + 1 : 0;
        noEffectKey = k;
        return noEffectRepeats > ch.ctx.maxRetries;
    }

    private String noEffectReason(String pressed) {
        return "same answer " + (noEffectRepeats + 1) + " times to a re-shown question without effect; pressed " + pressed;
    }

    /** Click a selection: toggle only the differences from what is already selected, then OK once it is enabled. */
    private void select(Input in, List<String> picks) {
        java.util.Collection<?> already = in instanceof InputLondonMulligan ? londonSelected(in) : entityList(in, "selected");
        java.util.Set<String> want = new java.util.HashSet<>(picks), have = new java.util.HashSet<>();
        if (already != null) for (Object o : already) have.add(o instanceof Card ac ? StateView.id(ac) : o instanceof Player ap ? "player:" + ap.getId() : "");
        for (String id : have) if (!want.contains(id) && !id.isEmpty()) queued.add(id);   // deselect
        for (String id : picks) if (!have.contains(id)) queued.add(id);                  // select
        queued.add("ok"); // confirm once the picks are made (skipped while OK is disabled; ignored if the input already finished)
    }

    /** "You are casting X" for a targeting prompt (Forge's own text names the card but not whose spell it is). */
    private String castingContext(Input in) {
        SpellAbility sa = targetingAbility(in);
        if (sa == null || sa.getHostCard() == null) return null;
        boolean mine = ch.player.equals(sa.getActivatingPlayer());
        String what = sa.isSpell() ? "casting" : sa.isTrigger() ? "putting a triggered ability on the stack from" : "activating an ability of";
        return (mine ? "You are " : "Your opponent is ") + what + " " + sa.getHostCard().getName() + "; choose its targets.";
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
            // A sorcery could be cast now: the seat's own main phase with an empty stack.
            Game g = ch.player.getGame();
            m.addProperty("sorcerySpeedOk", g.getPhaseHandler().isPlayerTurn(ch.player) && g.getPhaseHandler().getPhase() != null
                    && g.getPhaseHandler().getPhase().isMain() && g.getStack().isEmpty());
        } else if (in instanceof InputAttack) {
            m.addProperty("power", c.getNetPower());
            m.addProperty("toughness", c.getNetToughness());
            m.addProperty("evasive", c.hasKeyword("Flying"));
        } else if (in instanceof InputSelectTargets || in instanceof InputSelectManyBase) {
            m.addProperty("hostile", !c.getController().equals(ch.player));
        }
        return m;
    }

    static final String NOT_AFFORDABLE = "card not offered: the affordability probe says its cost can't be paid now";
    static final String NO_TARGET = "card not offered: a required target has no legal candidate";

    /**
     * Null when something on this card can be done right now (a land drop, or a non-mana ability that is playable,
     * whose required targets all have a legal candidate, and that is affordable); else why not (NOT_AFFORDABLE / NO_TARGET).
     */
    private String whyNotPlayable(Card c) {
        // Forge's affordability probe asks the player's controller to choose permanents for convoke/improvise/delve;
        // with the human controller that opens a real input. For those spells, estimate instead (helpedAffordable).
        boolean helped = c.hasKeyword(Keyword.CONVOKE) || c.hasKeyword(Keyword.IMPROVISE) || c.hasKeyword(Keyword.DELVE);
        boolean noTarget = false;
        try {
            for (SpellAbility sa : c.getAllPossibleAbilities(ch.player, true)) {
                if (sa.isManaAbility()) continue;
                if (sa.isLandAbility()) { if (ch.player.canPlayLand(c, false, sa)) return null; continue; }
                if (!Playability.hasRequiredTargets(sa)) { noTarget = true; continue; }
                if (helped && sa.isSpell()) { if (helpedAffordable(c, sa)) return null; continue; }
                if (Playability.affordable(sa, ch.player)) return null;
            }
        } catch (RuntimeException e) {
            return null; // can't probe it: offer it and let Forge decide
        }
        return noTarget ? NO_TARGET : NOT_AFFORDABLE;
    }

    /**
     * Mana value coverable by available mana plus what convoke (untapped creatures), improvise (untapped artifacts,
     * generic only) or delve (graveyard cards, generic only) could pay. Colours aren't checked, so Forge's payment
     * may still fail (recorded as "cost can't be paid"); the estimate never asks the controller anything.
     */
    private boolean helpedAffordable(Card c, SpellAbility sa) {
        forge.card.mana.ManaCost cost = sa.getPayCosts() != null ? sa.getPayCosts().getTotalMana() : null;
        if (cost == null) return true;
        int help = 0;
        if (c.hasKeyword(Keyword.CONVOKE)) for (Card k : ch.player.getCreaturesInPlay()) if (!k.isTapped()) help++;
        int generic = cost.getGenericCost(), genericHelp = 0;
        if (c.hasKeyword(Keyword.IMPROVISE)) for (Card k : ch.player.getCardsIn(ZoneType.Battlefield)) if (k.isArtifact() && !k.isTapped()) genericHelp++;
        if (c.hasKeyword(Keyword.DELVE)) for (Card k : ch.player.getCardsIn(ZoneType.Graveyard)) if (!k.equals(c)) genericHelp++;
        help += Math.min(generic, genericHelp);
        return forge.ai.ComputerUtilMana.getAvailableManaEstimate(ch.player, true) + help >= cost.getCMC();
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

    /**
     * The sources Forge's Auto button would tap, planned afresh (InputPayMana caches its plan; the methods and field are
     * private), or null when Forge's AI payer finds no way to pay what is still owed.
     */
    @SuppressWarnings("unchecked")
    private static List<Card> freshAutoPlan(Input in) {
        try {
            java.lang.reflect.Method invalidate = InputPayMana.class.getDeclaredMethod("invalidateAutoPayManaSources");
            java.lang.reflect.Method ensure = InputPayMana.class.getDeclaredMethod("ensureAutoPayManaSources");
            java.lang.reflect.Field f = InputPayMana.class.getDeclaredField("autoPayManaSources");
            invalidate.setAccessible(true);
            ensure.setAccessible(true);
            f.setAccessible(true);
            invalidate.invoke(in);
            ensure.invoke(in);
            return f.get(in) instanceof java.util.Collection<?> c ? new ArrayList<>((java.util.Collection<Card>) c) : null;
        } catch (ReflectiveOperationException | RuntimeException e) {
            return List.of(); // can't plan: trust Forge's button (the Auto budget still applies)
        }
    }

    /** What a payment input still owes, and the mana floating in the pool: both unchanged after Auto means Auto failed. */
    private String owedKey(Input in) {
        try {
            java.lang.reflect.Field f = InputPayMana.class.getDeclaredField("manaCost");
            f.setAccessible(true);
            return f.get(in) + "|" + ch.player.getManaPool().totalMana();
        } catch (ReflectiveOperationException | RuntimeException e) {
            return "?";
        }
    }

    /** What a payment input still owes (InputPayMana.manaCost is protected), or null. */
    private static ManaCostBeingPaid owing(Input in) {
        try {
            java.lang.reflect.Field f = InputPayMana.class.getDeclaredField("manaCost");
            f.setAccessible(true);
            return (ManaCostBeingPaid) f.get(in);
        } catch (ReflectiveOperationException | RuntimeException e) {
            return null;
        }
    }

    /** The spell or ability a payment input pays for (InputPayMana.saPaidFor is protected), or null. */
    private static SpellAbility paidFor(Input in) {
        try {
            java.lang.reflect.Field f = InputPayMana.class.getDeclaredField("saPaidFor");
            f.setAccessible(true);
            return f.get(in) instanceof SpellAbility sa ? sa : null;
        } catch (ReflectiveOperationException | RuntimeException e) {
            return null;
        }
    }

    /** The fewest sources, largest outputs first, that make at least `need` mana (all of them if even that falls short). */
    static int fewestSources(List<Integer> outputs, int need) {
        List<Integer> sorted = new ArrayList<>(outputs);
        sorted.sort(java.util.Collections.reverseOrder());
        int sum = 0;
        for (int i = 0; i < sorted.size(); i++) {
            sum += sorted.get(i);
            if (sum >= need) return i + 1;
        }
        return sorted.size();
    }

    /** Why Forge's cast was cancelled (or a payment declined), for the agent's next question. */
    private String cancelNotice(SpellAbility sa, ManaCostBeingPaid owing, boolean decline) {
        String name = sa != null && sa.getHostCard() != null ? sa.getHostCard().getName() : "the spell";
        String owed = owing != null ? owing.toString() : "its mana cost";
        int available;
        try { available = Playability.availableMana(sa, ch.player); } catch (RuntimeException e) { available = -1; }
        String have = available >= 0 ? " (your untapped sources and floating mana make about " + available + " mana)" : "";
        if (decline) return "you couldn't pay " + owed + " for " + name + have + ", so it wasn't paid";
        Integer x = sa != null ? sa.getXManaCostPaid() : null;
        boolean hasX = sa != null && sa.getPayCosts() != null && sa.getPayCosts().getCostMana() != null && sa.getPayCosts().getCostMana().getAmountOfX() > 0;
        String what = sa != null && !sa.isSpell() ? "activating an ability of " : "casting ";
        return "Forge cancelled " + what + name + (hasX && x != null ? " with X=" + x : "") + ": " + owed + " was still owed and couldn't be paid" + have;
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
        if (id.equals("ok")) {
            // Forge's selectButtonOK doesn't check the button state (InputSelectManyBase.onOk would accept too few picks).
            if (gui.okEnabled) ctl.getInputProxy().selectButtonOK();
            else trace("OK is disabled: not pressed");
            return;
        }
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

    /** The decision kind (src/types.ts DecisionKind) of an input; list inputs take the kind AgentControllerHuman named. */
    private String kindOf(Input in) {
        if (in instanceof InputPassPriority) return "priority";
        if (in instanceof InputSelectTargets) return "targets";
        if (in instanceof InputPayMana) return "mana_payment";
        if (in instanceof InputAttack) return "attackers";
        if (in instanceof InputBlock) return "blockers";
        if (in instanceof InputConfirmMulligan) return "mulligan";
        if (in instanceof InputLondonMulligan) return "london_bottom";
        String hint = ch.kindHint;
        if (in instanceof InputConfirm) {
            if (List.of("play_draw", "scry", "surveil", "pay_or_else").contains(String.valueOf(hint))) return hint;
            if (AgentGuiGame.isYesNo(List.of(gui.okLabel, gui.cancelLabel))) return "confirm";
            java.util.Set<String> colours = new java.util.HashSet<>();
            for (forge.card.MagicColor.Color col : forge.card.MagicColor.Color.values()) colours.add(col.getTranslatedName());
            if (colours.contains(gui.okLabel) && colours.contains(gui.cancelLabel)) return "choose_color";
            return "choose_option";
        }
        if (hint != null && !hint.equals("play_draw")) return hint;
        return "choose_cards";
    }
}
