package forge.bridge;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

import org.apache.commons.lang3.tuple.ImmutablePair;

import com.google.gson.JsonObject;

import forge.LobbyPlayer;
import forge.game.Game;
import forge.game.GameActionUtil;
import forge.game.ability.ApiType;
import forge.game.card.Card;
import forge.game.card.CardCollection;
import forge.game.card.CardCollectionView;
import forge.game.cost.Cost;
import forge.game.cost.CostPart;
import forge.game.keyword.Keyword;
import forge.game.player.Player;
import forge.game.player.PlayerActionConfirmMode;
import forge.game.player.PlayerController;
import forge.game.spellability.OptionalCostValue;
import forge.game.spellability.SpellAbility;
import forge.player.PlayerControllerHuman;
import forge.util.ITriggerEvent;
import forge.util.collect.FCollectionView;

/**
 * Forge's human controller, unchanged except that it names the decision kind of questions whose input doesn't tell
 * (a discard and a "choose cards" effect both open the same list input), so decisions are labelled with the finer
 * kinds of src/types.ts.
 */
public class AgentControllerHuman extends PlayerControllerHuman {
    private final AgentChannel ch;

    AgentControllerHuman(Game game, Player player, LobbyPlayer lobby, AgentChannel ch) {
        super(game, player, lobby);
        this.ch = ch;
    }

    private <T> T as(String kind, Supplier<T> question) {
        String before = ch.kindHint;
        ch.kindHint = kind;
        try {
            return question.get();
        } finally {
            ch.kindHint = before;
        }
    }

    /**
     * Whether the affordability probe says this spell or ability can be paid now. Cards with convoke, improvise or delve
     * aren't probed (Forge's probe would ask this controller to choose permanents, opening a real input).
     */
    private boolean affordable(SpellAbility sa) {
        Card c = sa.getHostCard();
        if (c != null && (c.hasKeyword(Keyword.CONVOKE) || c.hasKeyword(Keyword.IMPROVISE) || c.hasKeyword(Keyword.DELVE))) return true;
        try {
            return Playability.affordable(sa, getPlayer());
        } catch (RuntimeException e) {
            return true; // can't probe it: offer it and let Forge's payment decide
        }
    }

    private static boolean hasTargets(SpellAbility sa) {
        try {
            return Playability.hasRequiredTargets(sa);
        } catch (RuntimeException e) {
            return true;
        }
    }

    /** Which of a card's abilities to play: the same target and affordability filters as priority apply to each ability. */
    @Override
    public SpellAbility getAbilityToPlay(Card hostCard, List<SpellAbility> abilities, ITriggerEvent triggerEvent) {
        List<SpellAbility> offered = new ArrayList<>();
        List<String> dropped = new ArrayList<>();
        for (SpellAbility sa : abilities) {
            if (sa.isManaAbility() || sa.isLandAbility()) offered.add(sa);
            else if (!hasTargets(sa)) dropped.add("ability not offered: a required target has no legal candidate");
            else if (!affordable(sa)) dropped.add("ability not offered: the affordability probe says its cost can't be paid now");
            else offered.add(sa);
        }
        if (offered.isEmpty()) return super.getAbilityToPlay(hostCard, abilities, triggerEvent); // nothing passes: let Forge decide
        for (String why : dropped) ch.auto("policy", "choose_ability", why);
        return super.getAbilityToPlay(hostCard, offered, triggerEvent);
    }

    /**
     * X in a mana cost: offered only up to what the seat can pay (Forge's AI payer or the rules-only estimate, colours
     * included), with the mana available stated. Forge's own bound for X in other costs still applies (super).
     */
    @Override
    public Integer announceRequirements(SpellAbility ability, int min, int max, String announce) {
        Cost cost = ability.getPayCosts();
        boolean manaX = "X".equals(announce) && cost != null && cost.getCostMana() != null && cost.getCostMana().getAmountOfX() > 0;
        if (!manaX) return super.announceRequirements(ability, min, max, announce);
        // Forge's own bound for an X that also appears in a non-mana cost part (Bond of Agony's "pay X life"), as super applies.
        Integer nonManaMax = cost.getMaxForNonManaX(ability, getPlayer(), false);
        if (nonManaMax != null && !getPlayer().getController().isFullControl(PlayerController.FullControlFlag.AllowPaymentStartWithMissingResources)) max = Math.min(max, nonManaMax);
        if (min > max) return null;
        int hi = (int) Math.min(max, (long) min + 30);
        int payable;
        int available;
        try {
            payable = Playability.maxPayableX(ability, getPlayer(), min, hi);
            available = Playability.availableMana(ability, getPlayer());
        } catch (RuntimeException e) {
            return super.announceRequirements(ability, min, max, announce);
        }
        if (payable <= min) {
            // Only the smallest X can be paid, or not even that (Forge's payment then cancels the cast, and says why).
            ch.auto("forced", "choose_number", "X: only the smallest value can be paid");
            return min;
        }
        String name = ability.getHostCard() != null ? ability.getHostCard().getName() : "this";
        String costText = cost.getTotalMana() != null ? cost.getTotalMana().toString() : "";
        String msg = "Choose X for " + name + (costText.isEmpty() ? "" : " (mana cost " + costText + ")") + ". Your untapped sources and floating mana"
                + " make about " + available + " mana, so X can be at most " + payable + ".";
        Integer x = getGui().getInteger(msg, min, payable, payable);
        if (x == null && cost.isMandatory()) return min;
        return x;
    }

    /** Optional costs (kicker, buyback...): only the affordable ones are offered, as on the AI-controller bridge. */
    @Override
    public List<OptionalCostValue> chooseOptionalCosts(SpellAbility chosen, List<OptionalCostValue> optionalCost) {
        List<OptionalCostValue> offered = new ArrayList<>();
        for (OptionalCostValue ocv : optionalCost)
            if (affordable(GameActionUtil.addOptionalCosts(chosen, Collections.singletonList(ocv)))) offered.add(ocv);
        for (int i = offered.size(); i < optionalCost.size(); i++)
            ch.auto("policy", "optional_costs", "optional cost not offered: the affordability probe says it can't be paid now");
        if (offered.isEmpty()) return new ArrayList<>();
        return as("optional_costs", () -> super.chooseOptionalCosts(chosen, offered));
    }

    /**
     * A yes/no question about an optional effect: bot-only tags for it (rank-bot reads them; LLM prompts show labels
     * only). "api" is the effect; for a copy of a spell, "copies" is the copied spell's effect (Chain of Smog: Discard).
     */
    @Override
    public boolean confirmAction(SpellAbility sa, PlayerActionConfirmMode mode, String message, List<String> options, Card cardToShow, Map<String, Object> params) {
        JsonObject tags = new JsonObject();
        if (sa != null && sa.getApi() != null) {
            tags.addProperty("api", sa.getApi().name());
            SpellAbility root = sa.getRootAbility();
            if (sa.getApi() == ApiType.CopySpellAbility && root != sa && root.getApi() != null) tags.addProperty("copies", root.getApi().name());
        }
        JsonObject before = ch.confirmHints;
        ch.confirmHints = tags;
        try {
            // Name the card when Forge's text doesn't ("Search your library?").
            Card host = sa != null ? sa.getHostCard() : null;
            String named = host != null && message != null && !message.contains(host.getName())
                    ? (getPlayer().equals(host.getController()) ? "Your " : "Your opponent's ") + host.getName() + ": " + message : message;
            return super.confirmAction(sa, mode, named, options, cardToShow, params);
        } finally {
            ch.confirmHints = before;
        }
    }

    /**
     * A cost question ("Do you want to pay 3 life?", "Sacrifice Black Lotus?") names the spell or ability it is part of
     * and its whole cost; Forge's own text names only the cost part.
     */
    @Override
    public boolean confirmPayment(CostPart costPart, String question, SpellAbility sa) {
        String about = costContext(sa);
        return super.confirmPayment(costPart, about == null ? question : about + "\n" + question, sa);
    }

    private String costContext(SpellAbility sa) {
        if (sa == null || sa.getHostCard() == null) return null;
        Card host = sa.getHostCard();
        String name = host.getName();
        String whose = getPlayer().equals(host.getController()) ? "your " : "your opponent's ";
        if ("pay_or_else".equals(ch.kindHint) || (!sa.isManaAbility() && getGame().getStack().isResolving(host)))
            return "This is about " + whose + name + ", which is resolving and asks whether you pay a cost.";
        String cost = sa.getPayCosts() != null ? sa.getPayCosts().toSimpleString().replace("CARDNAME", name).replace("NICKNAME", name) : "";
        String full = cost.isEmpty() ? "" : " (full cost: " + cost + ")";
        if (sa.isTrigger()) return "This is about the cost of a triggered ability of " + whose + name + full + ".";
        String what = sa.isManaAbility() ? "activating a mana ability of " : sa.isSpell() ? "casting " : "activating an ability of ";
        String no = sa.isSpell() ? name + " isn't cast" : "the ability isn't activated";
        return "You are " + what + name + full + ". This question is about paying part of that cost: if you don't pay it, " + no + ".";
    }

    @Override
    public Player chooseStartingPlayer(boolean isFirstGame) {
        return as("play_draw", () -> super.chooseStartingPlayer(isFirstGame));
    }

    @Override
    public CardCollectionView tuckCardsViaMulligan(CardCollectionView hand, int cardsToReturn) {
        return as("london_bottom", () -> super.tuckCardsViaMulligan(hand, cardsToReturn));
    }

    @Override
    public CardCollectionView chooseCardsToDiscardFrom(Player p, SpellAbility sa, CardCollection valid, int min, int max, CardCollectionView visibleToChooser) {
        return as("discard", () -> super.chooseCardsToDiscardFrom(p, sa, valid, min, max, visibleToChooser));
    }

    @Override
    public CardCollectionView chooseCardsToDiscardUnlessType(int num, CardCollectionView hand, String[] uTypes, SpellAbility sa) {
        return as("discard", () -> super.chooseCardsToDiscardUnlessType(num, hand, uTypes, sa));
    }

    @Override
    public CardCollectionView chooseCardsToDiscardToMaximumHandSize(int nDiscard) {
        return as("discard", () -> super.chooseCardsToDiscardToMaximumHandSize(nDiscard));
    }

    @Override
    public CardCollectionView chooseCardsToDelve(int genericAmount, CardCollection grave) {
        return as("cost_choice", () -> super.chooseCardsToDelve(genericAmount, grave));
    }

    @Override
    public boolean payCostToPreventEffect(Cost cost, SpellAbility sa, boolean alreadyPaid, FCollectionView<Player> allPayers) {
        return as("pay_or_else", () -> super.payCostToPreventEffect(cost, sa, alreadyPaid, allPayers));
    }

    @Override
    public ImmutablePair<CardCollection, CardCollection> arrangeForScry(CardCollection topN) {
        return as("scry", () -> super.arrangeForScry(topN));
    }

    @Override
    public ImmutablePair<CardCollection, CardCollection> arrangeForSurveil(CardCollection topN) {
        return as("surveil", () -> super.arrangeForSurveil(topN));
    }
}
