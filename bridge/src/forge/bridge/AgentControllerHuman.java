package forge.bridge;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.function.Supplier;

import org.apache.commons.lang3.tuple.ImmutablePair;

import forge.LobbyPlayer;
import forge.ai.ComputerUtilCost;
import forge.game.Game;
import forge.game.GameActionUtil;
import forge.game.card.Card;
import forge.game.card.CardCollection;
import forge.game.card.CardCollectionView;
import forge.game.cost.Cost;
import forge.game.keyword.Keyword;
import forge.game.player.Player;
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
            return ComputerUtilCost.canPayCost(sa, getPlayer(), false);
        } catch (RuntimeException e) {
            return true; // can't probe it: offer it and let Forge's payment decide
        }
    }

    /** Which of a card's abilities to play: the same affordability filter as priority applies to each ability. */
    @Override
    public SpellAbility getAbilityToPlay(Card hostCard, List<SpellAbility> abilities, ITriggerEvent triggerEvent) {
        List<SpellAbility> offered = new ArrayList<>();
        for (SpellAbility sa : abilities) if (sa.isManaAbility() || sa.isLandAbility() || affordable(sa)) offered.add(sa);
        if (offered.isEmpty()) offered = abilities; // nothing passes the probe: let Forge's payment decide
        for (int i = offered.size(); i < abilities.size(); i++)
            ch.auto("policy", "choose_ability", "ability not offered: the affordability probe says its cost can't be paid now");
        return super.getAbilityToPlay(hostCard, offered, triggerEvent);
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
