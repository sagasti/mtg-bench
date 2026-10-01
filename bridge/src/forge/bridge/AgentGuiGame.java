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

    @Override public void showPromptMessage(PlayerView playerView, String message, CardView card) { prompt = message == null ? "" : message; promptSeq++; }
    @Override public void updateButtons(PlayerView owner, String label1, String label2, boolean enable1, boolean enable2, boolean focus1) {
        okLabel = label1; cancelLabel = label2; okEnabled = enable1; cancelEnabled = enable2;
    }
    @Override public void flashIncorrectAction() { lastError = "That action isn't allowed right now."; }
    @Override public void showErrorDialog(String message, String title) { lastError = message; }
    @Override public void message(String message, String title) { lastError = message; }

    /** Skipped phases: same "meaningful stops" as the AI-controller bridge (MatchContext.smartStops). */
    @Override
    public boolean isUiSetToSkipPhase(PlayerView playerTurn, PhaseType phase) {
        if (!ch.ctx.smartStops || phase == null) return false;
        boolean myTurn = ch.player != null && ch.player.getView().equals(playerTurn);
        if (myTurn) return !(phase.isMain() || phase == PhaseType.COMBAT_DECLARE_BLOCKERS);
        return !(phase == PhaseType.COMBAT_DECLARE_ATTACKERS || phase == PhaseType.COMBAT_DECLARE_BLOCKERS
                || phase == PhaseType.END_OF_TURN || phase == PhaseType.UPKEEP);
    }

    // ------------------------------------------------------------------ dialog questions -> decisions

    private int chooseIndex(String kind, String prompt, List<String> labels, boolean optional) {
        List<PlayerControllerExternal.Opt> opts = new ArrayList<>();
        for (int i = 0; i < labels.size(); i++) opts.add(new PlayerControllerExternal.Opt("o" + (i + 1), labels.get(i), null));
        List<String> r = ch.ask(kind, prompt, opts, optional ? 0 : 1, 1, null);
        if (r == null || r.isEmpty()) return -1;
        return Integer.parseInt(r.get(0).substring(1)) - 1;
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
        return initialInput;
    }

    @Override
    public <T> List<T> getChoices(String message, int min, int max, List<T> choices, List<T> selected, FSerializableFunction<T, String> display) {
        List<PlayerControllerExternal.Opt> opts = new ArrayList<>();
        for (int i = 0; i < choices.size(); i++) {
            T t = choices.get(i);
            opts.add(new PlayerControllerExternal.Opt("o" + (i + 1), display != null ? display.apply(t) : label(t), t instanceof CardView cv ? cv.getName() : null));
        }
        List<String> r = ch.ask(min <= 1 && max == 1 ? "choose_entity" : "choose_cards", message, opts, Math.max(0, min), max < 0 ? choices.size() : max, null);
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
            int i = chooseIndex("order_triggers", title + " (" + (top != null ? top : "first") + ": pick the next one)", labels, false);
            ordered.add(remaining.remove(Math.max(0, i)));
        }
        ordered.addAll(remaining);
        return new OrderResult<>(ordered, false);
    }

    @Override
    public Map<CardView, Integer> assignCombatDamage(CardView attacker, List<CardView> blockers, int damage, GameEntityView defender, boolean overrideOrder, boolean maySkip) {
        // Spike: lethal damage to each blocker in order, the rest to the defender (trample) or the last blocker.
        ch.delegated("assign_damage", "spike default: lethal to each blocker in order");
        Map<CardView, Integer> out = new HashMap<>();
        int left = damage;
        for (CardView b : blockers) {
            int d = Math.min(left, Math.max(0, b.getLethalDamage()));
            out.put(b, d);
            left -= d;
        }
        if (left > 0) {
            if (defender != null) out.put(null, left);
            else if (!blockers.isEmpty()) out.merge(blockers.get(blockers.size() - 1), left, Integer::sum);
        }
        return out;
    }

    @Override
    public Map<Object, Integer> assignGenericAmount(CardView effectSource, Map<Object, Integer> target, int amount, boolean atLeastOne, String amountLabel) {
        ch.delegated("divide", "spike default: even split");
        Map<Object, Integer> out = new HashMap<>();
        List<Object> keys = new ArrayList<>(target.keySet());
        for (int i = 0; i < keys.size(); i++) out.put(keys.get(i), amount / keys.size() + (i < amount % keys.size() ? 1 : 0));
        return out;
    }

    @Override
    public List<CardView> manipulateCardList(String title, Iterable<CardView> cards, Iterable<CardView> manipulable, boolean toTop, boolean toBottom, boolean toAnywhere) {
        ch.delegated("manipulate_cards", "spike: card order unchanged");
        List<CardView> out = new ArrayList<>();
        for (CardView c : cards) out.add(c);
        return out;
    }

    @Override public List<PaperCard> sideboard(CardPool sideboard, CardPool main, String message) { return null; }

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
