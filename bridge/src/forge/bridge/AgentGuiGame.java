package forge.bridge;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import forge.LobbyPlayer;
import forge.deck.CardPool;
import forge.game.GameEntityView;
import forge.game.GameState;
import forge.game.card.CardView;
import forge.game.phase.PhaseType;
import forge.game.player.DelayedReveal;
import forge.game.player.IHasIcon;
import forge.game.player.PlayerView;
import forge.game.spellability.SpellAbilityView;
import forge.gamemodes.match.AbstractGuiGame;
import forge.item.PaperCard;
import forge.localinstance.skin.FSkinProp;
import forge.trackable.TrackableCollection;
import forge.util.FSerializableFunction;
import forge.util.ITriggerEvent;

/**
 * Headless stand-in for Forge's match screen, for an agent playing through Forge's human controller.
 * Dialog questions (choose one/many, confirm, order, numbers, ability to play) become decisions over the
 * agent channel, worded by Forge. Prompt text, button labels and error flashes are recorded for InputDriver,
 * which handles the interactive inputs (priority, targets, mana, attacks, blocks, mulligans).
 */
public class AgentGuiGame extends AbstractGuiGame {
    private final AgentChannel ch;

    volatile String prompt = "";
    /** Bumped on every prompt message, so InputDriver can wait for an input's own message before reading it. */
    volatile long promptSeq = 0;
    volatile String okLabel = "OK", cancelLabel = "Cancel";
    volatile boolean okEnabled = false, cancelEnabled = false;
    /** Set when Forge rejects the last click (flashIncorrectAction / error dialog); InputDriver passes it to the agent. */
    volatile String lastError = null;

    AgentGuiGame(AgentChannel ch) {
        this.ch = ch;
    }

    // ------------------------------------------------------------------ recorded by InputDriver

    @Override public void showPromptMessage(PlayerView playerView, String message, CardView card) {
        // Forge's "waiting for opponent" timer (AbstractGuiGame.awaitNextInput, final) rewrites the prompt and buttons
        // 250 ms after an input ends, possibly after the next input set its own. Headless: ignore that message and its buttons.
        if (message != null && isWaitingMessage(message)) { ignoreNextButtons = true; return; }
        prompt = message == null ? "" : message;
        promptSeq++;
    }

    private volatile boolean ignoreNextButtons = false;

    private static boolean isWaitingMessage(String message) {
        forge.util.Localizer l = forge.util.Localizer.getInstance();
        String opp = l.getMessage("lblWaitingForOpponent");
        String player = l.getMessage("lblWaitingForPlayer", "\u0001");
        String playerPrefix = player.substring(0, Math.max(0, player.indexOf('\u0001')));
        return message.contains(opp) || (!playerPrefix.isEmpty() && message.contains(playerPrefix));
    }
    @Override public void updateButtons(PlayerView owner, String label1, String label2, boolean enable1, boolean enable2, boolean focus1) {
        if (ignoreNextButtons) { ignoreNextButtons = false; return; }
        okLabel = label1; cancelLabel = label2; okEnabled = enable1; cancelEnabled = enable2;
    }
    /** How many selectable objects the current selection input wants (Forge's own min/max). */
    volatile int selMin = 0, selMax = 1;
    @Override public void setSelectables(Iterable<CardView> cards, int min, int max) { super.setSelectables(cards, min, max); selMin = min; selMax = max; }

    @Override public void flashIncorrectAction() { lastError = "That action isn't allowed right now."; }
    @Override public void showErrorDialog(String message, String title) { lastError = message; }
    /**
     * Forge's message dialog carries both notifications (a chosen colour, a coin flip, "no cards in hand") and a few
     * rejections, told apart by their title. Rejections go to the agent as "Forge rejected your last choice";
     * everything else is information, shown with the next decision.
     */
    @Override public void message(String message, String title) {
        forge.util.Localizer l = forge.util.Localizer.getInstance();
        if (title != null && (title.equals(l.getMessage("lblCostPaymentInvalid")) || title.equals(l.getMessage("lblError")))) lastError = message;
        else ch.notice(message);
    }

    /** Reveals are information, not questions: Forge's default asks "choose 0 to N" and ignores the answer. */
    @Override public <T> void reveal(String message, List<T> items) {
        List<String> names = new ArrayList<>();
        for (T t : items) names.add(label(t));
        ch.notice((message == null ? "Revealed" : message) + ": " + String.join(", ", names));
    }

    /** Cards revealed for the current prompt (an opponent's hand); InputDriver acknowledges the prompt itself. */
    @Override public void showRevealedCards(Iterable<CardView> cards) {
        List<String> names = new ArrayList<>();
        for (CardView c : cards) names.add(label(c));
        ch.notice("Revealed: " + String.join(", ", names));
    }

    /** Skipped phases: same "meaningful stops" as the AI-controller bridge (MatchContext.smartStops). */
    private final java.util.Set<String> skippedStops = new java.util.HashSet<>();

    @Override
    public boolean isUiSetToSkipPhase(PlayerView playerTurn, PhaseType phase) {
        if (!ch.ctx.smartStops || phase == null) return false;
        boolean myTurn = ch.player != null && ch.player.getView().equals(playerTurn);
        boolean skip = myTurn ? !(phase.isMain() || phase == PhaseType.COMBAT_DECLARE_BLOCKERS)
                : !(phase == PhaseType.COMBAT_DECLARE_ATTACKERS || phase == PhaseType.COMBAT_DECLARE_BLOCKERS
                    || phase == PhaseType.END_OF_TURN || phase == PhaseType.UPKEEP);
        // Count each skipped stop once per turn and phase (Forge may ask more than once).
        if (skip && ch.player != null && skippedStops.add(ch.player.getGame().getPhaseHandler().getTurn() + ":" + phase))
            ch.auto("policy", "priority", "phase is not a meaningful stop");
        return skip;
    }

    // ------------------------------------------------------------------ dialog questions -> decisions

    private int chooseIndex(String kind, String prompt, List<String> labels, boolean optional) {
        List<PlayerControllerExternal.Opt> opts = new ArrayList<>();
        // A yes/no question answers with ids "yes"/"no", so the harness's forfeit (null action) declines it.
        boolean yesNo = isYesNo(labels);
        for (int i = 0; i < labels.size(); i++) opts.add(new PlayerControllerExternal.Opt(yesNo ? (i == 0 ? "yes" : "no") : "o" + (i + 1), labels.get(i), null));
        List<String> r = ch.ask(kind, prompt, opts, optional ? 0 : 1, 1, null);
        if (r == null || r.isEmpty()) return -1;
        if (yesNo) return r.get(0).equals("yes") ? 0 : 1;
        return Integer.parseInt(r.get(0).substring(1)) - 1;
    }

    static boolean isYesNo(List<String> labels) {
        forge.util.Localizer l = forge.util.Localizer.getInstance();
        return labels.size() == 2 && labels.get(0).equals(l.getMessage("lblYes")) && labels.get(1).equals(l.getMessage("lblNo"));
    }

    private static String label(Object o) {
        if (o instanceof CardView cv) return cv.getName() + " (c" + cv.getId() + ")";
        if (o instanceof PlayerView pv) return pv.getName();
        return String.valueOf(o);
    }

    @Override
    public boolean confirm(CardView c, String question, boolean defaultIsYes, List<String> options) {
        List<String> labels = options == null || options.size() < 2 ? List.of("Yes", "No") : options;
        String q = (c != null ? c.getName() + ": " : "") + question;
        int i = chooseIndex("confirm", q, labels, false);
        return i < 0 ? defaultIsYes : i == 0;
    }

    @Override
    public boolean showConfirmDialog(String message, String title, String yesButtonText, String noButtonText, boolean defaultYes) {
        int i = chooseIndex("confirm", message, List.of(yesButtonText, noButtonText), false);
        return i < 0 ? defaultYes : i == 0;
    }

    @Override
    public int showOptionDialog(String message, String title, FSkinProp icon, List<String> options, int defaultOption) {
        int i = chooseIndex("choose_option", message, options, false);
        return i < 0 ? defaultOption : i;
    }

    @Override
    public String showInputDialog(String message, String title, FSkinProp icon, String initialInput, List<String> inputOptions, boolean isNumeric) {
        if (inputOptions != null && !inputOptions.isEmpty()) {
            int i = chooseIndex(isNumeric ? "choose_number" : "choose_option", message, inputOptions, false);
            return i < 0 ? initialInput : inputOptions.get(i);
        }
        ch.delegated("free_text", "free-text input (e.g. naming a card) not offered in the spike");
        // A free number: Forge re-asks until it gets one, so the (non-numeric) initial input would loop forever. Cancel.
        return isNumeric ? null : initialInput;
    }

    /**
     * Forge lists min..cutoff plus "Other...", which opens a free-number input. One bounded list instead (at most 31
     * values, like the AI-controller bridge's announce_x); none chosen cancels, as in Forge.
     */
    @Override
    public Integer getInteger(String message, int min, int max, int cutoff) {
        if (max <= min || cutoff < min) return min;
        int hi = (int) Math.min(max, (long) min + 30);
        List<String> labels = new ArrayList<>();
        for (int v = min; v <= hi; v++) labels.add(String.valueOf(v));
        int i = chooseIndex("choose_number", message, labels, true);
        return i < 0 ? null : min + i;
    }

    @Override
    public <T> List<T> getChoices(String message, int min, int max, List<T> choices, List<T> selected, FSerializableFunction<T, String> display) {
        List<PlayerControllerExternal.Opt> opts = new ArrayList<>();
        for (int i = 0; i < choices.size(); i++) {
            T t = choices.get(i);
            opts.add(new PlayerControllerExternal.Opt("o" + (i + 1), display != null ? display.apply(t) : label(t), t instanceof CardView cv ? cv.getName() : null));
        }
        String kind = ch.kindHint != null ? ch.kindHint : min <= 1 && max == 1 ? "choose_entity" : "choose_cards";
        List<String> r = ch.ask(kind, message, opts, Math.max(0, min), max < 0 ? choices.size() : max, null);
        List<T> out = new ArrayList<>();
        if (r == null) {
            for (int i = 0; i < Math.max(0, min) && i < choices.size(); i++) out.add(choices.get(i));
            return out;
        }
        for (String id : r) out.add(choices.get(Integer.parseInt(id.substring(1)) - 1));
        return out;
    }

    @Override
    public GameEntityView chooseSingleEntityForEffect(String title, List<? extends GameEntityView> optionList, DelayedReveal delayedReveal, boolean isOptional) {
        List<String> labels = new ArrayList<>();
        for (GameEntityView e : optionList) labels.add(label(e));
        int i = chooseIndex("choose_entity", title, labels, isOptional);
        if (i < 0) return isOptional || optionList.isEmpty() ? null : optionList.get(0);
        return optionList.get(i);
    }

    @Override
    public List<GameEntityView> chooseEntitiesForEffect(String title, List<? extends GameEntityView> optionList, int min, int max, DelayedReveal delayedReveal) {
        return new ArrayList<>(getChoices(title, min, max, new ArrayList<GameEntityView>(optionList), null, null));
    }

    @Override
    public SpellAbilityView getAbilityToPlay(CardView hostCard, List<SpellAbilityView> abilities, ITriggerEvent triggerEvent) {
        if (abilities.size() == 1) return abilities.get(0);
        List<String> labels = new ArrayList<>();
        for (SpellAbilityView sa : abilities) labels.add(StateView.clean(sa.toString()));
        int i = chooseIndex("choose_ability", "Choose what to do with " + hostCard.getName() + ".", labels, true);
        return i < 0 ? null : abilities.get(i);
    }

    @Override
    public <T> OrderResult<T> order(String title, String top, int remainingObjectsMin, int remainingObjectsMax, List<T> sourceChoices,
                                    List<T> destChoices, CardView referenceCard, boolean sideboardingMode, boolean showRemember) {
        // One pick at a time: "which comes first?"
        List<T> remaining = new ArrayList<>(sourceChoices);
        List<T> ordered = new ArrayList<>();
        while (remaining.size() > 1) {
            List<String> labels = new ArrayList<>();
            for (T t : remaining) labels.add(label(t));
            String kind = "scry".equals(ch.kindHint) ? "scry_order" : "surveil".equals(ch.kindHint) ? "surveil_order" : "order_triggers";
            int i = chooseIndex(kind, title + " (" + (top != null ? top : "first") + ": pick the next one)", labels, false);
            ordered.add(remaining.remove(Math.max(0, i)));
        }
        ordered.addAll(remaining);
        return new OrderResult<>(ordered, false);
    }

    private static final int MAX_ENUMERATED_SPLITS = 60;

    /** Every way to split `total` into parts within [lo[i], hi[i]], or null if there are more than `cap`. */
    private static List<int[]> splits(int total, int[] lo, int[] hi, int cap) {
        List<int[]> out = new ArrayList<>();
        int[] cur = new int[lo.length];
        if (!fill(0, total, lo, hi, cur, out, cap)) return null;
        return out;
    }

    private static boolean fill(int i, int left, int[] lo, int[] hi, int[] cur, List<int[]> out, int cap) {
        if (i == lo.length - 1) {
            if (left < lo[i] || left > hi[i]) return true;
            cur[i] = left;
            out.add(cur.clone());
            return out.size() <= cap;
        }
        for (int v = lo[i]; v <= Math.min(hi[i], left); v++) {
            cur[i] = v;
            if (!fill(i + 1, left - v, lo, hi, cur, out, cap)) return false;
        }
        return true;
    }

    @Override
    public Map<CardView, Integer> assignCombatDamage(CardView attacker, List<CardView> blockers, int damage, GameEntityView defender, boolean overrideOrder, boolean maySkip) {
        // Current rules: divide freely among blockers; with trample the player gets damage only after every blocker
        // has lethal. The default (lethal to each blocker in order, rest to the player or the last blocker) is first.
        int n = blockers.size() + (defender != null ? 1 : 0);
        int[] lo = new int[n], hi = new int[n];
        for (int i = 0; i < n; i++) hi[i] = damage;
        int[] def = new int[n];
        int left = damage;
        for (int i = 0; i < blockers.size(); i++) { def[i] = Math.min(left, Math.max(0, blockers.get(i).getLethalDamage())); left -= def[i]; }
        if (left > 0) def[defender != null ? n - 1 : Math.max(0, blockers.size() - 1)] += left;
        List<int[]> all = splits(damage, lo, hi, MAX_ENUMERATED_SPLITS * 4);
        List<int[]> legal = new ArrayList<>();
        legal.add(def);
        if (all != null) for (int[] sp : all) {
            if (java.util.Arrays.equals(sp, def)) continue;
            if (defender != null && sp[n - 1] > 0) {
                boolean lethalAll = true;
                for (int i = 0; i < blockers.size(); i++) if (sp[i] < blockers.get(i).getLethalDamage()) lethalAll = false;
                if (!lethalAll) continue;
            }
            legal.add(sp);
        }
        if (all == null || legal.size() > MAX_ENUMERATED_SPLITS || legal.size() == 1) {
            if (legal.size() == 1) ch.auto("forced", "assign_damage", "only one legal split");
            else ch.delegated("assign_damage", "too many possible splits; default used (lethal to each blocker in order)");
            return toDamageMap(blockers, defender, def);
        }
        List<String> labels = new ArrayList<>();
        for (int[] sp : legal) {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < blockers.size(); i++) sb.append(i > 0 ? ", " : "").append(label(blockers.get(i))).append(": ").append(sp[i]);
            if (defender != null) sb.append(", defending ").append(label(defender)).append(": ").append(sp[n - 1]);
            labels.add(sb.toString());
        }
        int i = chooseIndex("assign_damage", "Assign " + damage + " combat damage from " + label(attacker) + " among its blockers"
                + (defender != null ? " (trample: the player gets damage only after each blocker has lethal)" : "") + ".", labels, false);
        return toDamageMap(blockers, defender, legal.get(Math.max(0, i)));
    }

    private static Map<CardView, Integer> toDamageMap(List<CardView> blockers, GameEntityView defender, int[] sp) {
        Map<CardView, Integer> out = new HashMap<>();
        for (int i = 0; i < blockers.size(); i++) out.put(blockers.get(i), sp[i]);
        if (defender != null && sp[blockers.size()] > 0) out.put(null, sp[blockers.size()]);
        return out;
    }

    @Override
    public Map<Object, Integer> assignGenericAmount(CardView effectSource, Map<Object, Integer> target, int amount, boolean atLeastOne, String amountLabel) {
        List<Object> keys = new ArrayList<>(target.keySet());
        int n = keys.size();
        int[] lo = new int[n], hi = new int[n];
        for (int i = 0; i < n; i++) { lo[i] = atLeastOne ? 1 : 0; hi[i] = Math.max(lo[i], target.get(keys.get(i))); }
        List<int[]> all = splits(amount, lo, hi, MAX_ENUMERATED_SPLITS);
        if (all == null || all.isEmpty()) {
            ch.delegated("divide", all == null ? "too many ways to divide; even split used" : "no legal split found; even split used");
            Map<Object, Integer> out = new HashMap<>();
            for (int i = 0; i < n; i++) out.put(keys.get(i), amount / n + (i < amount % n ? 1 : 0));
            return out;
        }
        if (all.size() == 1) ch.auto("forced", "divide", "only one legal split");
        int pick = 0;
        if (all.size() > 1) {
            List<String> labels = new ArrayList<>();
            for (int[] sp : all) {
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < n; i++) sb.append(i > 0 ? ", " : "").append(label(keys.get(i))).append(": ").append(sp[i]);
                labels.add(sb.toString());
            }
            pick = Math.max(0, chooseIndex("divide", "Divide " + amount + " " + (amountLabel != null ? amountLabel : "") + " from "
                    + (effectSource != null ? label(effectSource) : "this effect") + " among the targets.", labels, false));
        }
        Map<Object, Integer> out = new HashMap<>();
        for (int i = 0; i < n; i++) out.put(keys.get(i), all.get(pick)[i]);
        return out;
    }

    @Override
    public List<CardView> manipulateCardList(String title, Iterable<CardView> cards, Iterable<CardView> manipulable, boolean toTop, boolean toBottom, boolean toAnywhere) {
        List<CardView> all = new ArrayList<>(), manip = new ArrayList<>();
        for (CardView c : cards) all.add(c);
        for (CardView c : manipulable) manip.add(c);
        if (toAnywhere || manip.isEmpty()) {
            if (toAnywhere) ch.delegated("manipulate_cards", "arbitrary positions not offered yet; order unchanged");
            return all;
        }
        // Which cards go to the bottom (when both top and bottom are allowed), then the order of the top cards.
        List<CardView> bottom = new ArrayList<>();
        if (toTop && toBottom) bottom.addAll(getChoices(title + " Choose the cards to put on the bottom (none = keep all on top).", 0, manip.size(), manip, null, null));
        else if (toBottom) bottom.addAll(manip);
        List<CardView> top = new ArrayList<>(manip);
        top.removeAll(bottom);
        if (top.size() > 1) top = order(title + " Order the cards staying on top", "top card", 0, 0, top, null, null, false, false).ordered();
        if (bottom.size() > 1) ch.auto("policy", "scry", "order of cards put on the bottom unchanged");
        List<CardView> out = new ArrayList<>(top);
        for (CardView c : all) if (!manip.contains(c)) out.add(c);
        out.addAll(bottom);
        return out;
    }

    @Override public List<PaperCard> sideboard(CardPool sideboard, CardPool main, String message) {
        ch.auto("policy", "sideboard", "no sideboarding (not implemented)");
        return null;
    }

    // ------------------------------------------------------------------ display-only: nothing to show headless

    @Override protected void updateCurrentPlayer(PlayerView player) { }
    @Override public GameState getGamestate() { return null; }
    @Override public void alertUser() { }
    @Override public void finishGame() { }
    @Override public void openView(TrackableCollection<PlayerView> myPlayers) { }
    @Override public void setCard(CardView card) { }
    @Override public void setPanelSelection(CardView hostCard) { }
    @Override public void setPlayerAvatar(LobbyPlayer player, IHasIcon ihi) { }
    @Override public void showCombat() { }
}
