package forge.bridge;

import forge.ai.AiCostDecision;
import forge.game.card.CardCollection;
import forge.game.card.CardCollectionView;
import forge.game.card.CardLists;
import forge.game.card.CardPredicates;
import forge.game.cost.CostDiscard;
import forge.game.cost.CostExile;
import forge.game.cost.CostPart;
import forge.game.cost.CostReturn;
import forge.game.cost.CostSacrifice;
import forge.game.cost.CostTapType;
import forge.game.cost.PaymentDecision;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.zone.ZoneType;

/**
 * Cost payment where the agent chooses WHICH cards pay a cost (sacrifice, discard,
 * exile, return, tap-an-untapped-X). Forge's AI first works out a legal payment,
 * which gives the number of cards; the agent then picks that many from all valid
 * candidates. Unusual cost variants keep the AI's payment and are reported as delegated.
 * Mana costs are paid through PlayerControllerExternal.payManaCost (agent picks lands).
 */
public class AgentCostDecision extends AiCostDecision {
    private final PlayerControllerExternal ctl;

    public AgentCostDecision(PlayerControllerExternal ctl, Player p, SpellAbility sa, boolean effect) {
        super(p, sa, effect);
        this.ctl = ctl;
    }

    private static boolean special(String type) {
        return type == null || type.contains("+With") || type.contains("+with") || type.contains("FromTop")
                || type.contains("sharesCreatureTypeWith") || type.equals("All") || type.equals("Hand")
                || type.equals("LastDrawn") || type.equals("Random") || type.equals("OriginalHost");
    }

    /** Let the agent choose which of `candidates` pays the cost; ai = the AI's legal payment. */
    private PaymentDecision choose(String what, CostPart cost, PaymentDecision ai, CardCollectionView candidates) {
        if (ctl.castCancelled()) return null; // an earlier step of this cast was forfeited: refuse, so Forge rolls the cast back
        if (ai == null || ai.cards.isEmpty() || cost.payCostFromSource()) return ai;
        int n = ai.cards.size();
        if (candidates.size() <= n) return ai; // no real choice
        if (!candidates.containsAll(ai.cards)) {
            ctl.delegated("cost:" + what, "candidate list did not match engine's legal payment");
            return ai;
        }
        String src = ability.getHostCard() != null ? ability.getHostCard().getName() : "this";
        CardCollection chosen = ctl.askCards("cost_choice",
                "To pay the cost of " + src + ", choose " + n + " card(s) to " + what + ".", candidates, n, n);
        if (ctl.castCancelled()) return null;
        if (chosen == null) {
            ctl.delegated("cost:" + what, "no valid answer");
            return ai;
        }
        return PaymentDecision.card(chosen);
    }

    @Override
    public PaymentDecision visit(CostSacrifice cost) {
        PaymentDecision ai = super.visit(cost);
        if (special(cost.getType()) || cost.getAmount().equals("All")) return ai;
        CardCollectionView list = CardLists.filter(player.getCardsIn(ZoneType.Battlefield), CardPredicates.canBeSacrificedBy(ability, isEffect()));
        list = CardLists.getValidCards(list, cost.getType().split(";"), player, source, ability);
        return choose("sacrifice", cost, ai, list);
    }

    @Override
    public PaymentDecision visit(CostDiscard cost) {
        PaymentDecision ai = super.visit(cost);
        if (special(cost.getType())) return ai;
        CardCollectionView list = CardLists.getValidCards(player.getCardsIn(ZoneType.Hand), cost.getType().split(";"), player, source, ability);
        return choose("discard", cost, ai, list);
    }

    @Override
    public PaymentDecision visit(CostExile cost) {
        PaymentDecision ai = super.visit(cost);
        if (special(cost.getType()) || cost.getFrom().size() != 1 || cost.getFrom().get(0) == ZoneType.Library) return ai;
        CardCollectionView list = CardLists.getValidCards(player.getCardsIn(cost.getFrom().get(0)), cost.getType().split(";"), player, source, ability);
        return choose("exile", cost, ai, list);
    }

    @Override
    public PaymentDecision visit(CostReturn cost) {
        PaymentDecision ai = super.visit(cost);
        if (special(cost.getType())) return ai;
        CardCollectionView list = CardLists.getValidCards(player.getCardsIn(ZoneType.Battlefield), cost.getType().split(";"), player, source, ability);
        return choose("return to hand", cost, ai, list);
    }

    @Override
    public PaymentDecision visit(CostTapType cost) {
        PaymentDecision ai = super.visit(cost);
        if (special(cost.getType())) return ai;
        CardCollection list = CardLists.getValidCards(player.getCardsIn(ZoneType.Battlefield), cost.getType().split(";"), player, source, ability);
        list = CardLists.filter(list, c -> !c.isTapped() && (cost.canTapSource || c != source));
        return choose("tap", cost, ai, list);
    }
}
