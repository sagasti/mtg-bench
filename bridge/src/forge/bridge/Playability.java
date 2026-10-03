package forge.bridge;

import java.util.ArrayList;
import java.util.List;

import forge.ai.ComputerUtilCost;
import forge.ai.ComputerUtilMana;
import forge.card.mana.ManaAtom;
import forge.card.mana.ManaCostShard;
import forge.game.card.Card;
import forge.game.card.CardLists;
import forge.game.card.CardPredicates;
import forge.game.cost.Cost;
import forge.game.cost.CostPart;
import forge.game.cost.CostSacrifice;
import forge.game.cost.CostPayment;
import forge.game.mana.Mana;
import forge.game.mana.ManaCostBeingPaid;
import forge.game.player.Player;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.TargetRestrictions;
import forge.game.zone.ZoneType;

/**
 * Whether a spell or ability can be played now, for the option filters of the human-controller bridge.
 *
 * Forge's affordability probe (ComputerUtilCost.canPayCost) is Forge's AI deciding whether IT would pay: it refuses
 * Black Lotus for spells under mana value 3-4, mana sources whose drawback it dislikes, planeswalker abilities that
 * would kill the walker (at random), and so on. A "no" from it is therefore checked against a rules-only estimate
 * (`estimatePayable`): the non-mana costs Forge says can be paid, and the mana cost matched shard by shard against
 * the mana each source could make. The estimate never asks the controller anything.
 */
final class Playability {
    private Playability() { }

    /**
     * Each targeting part of the ability (sub-abilities included) with a minimum of 1+ has at least one legal candidate.
     * Forge's hasCandidates answers yes for any target on the stack ("considered later"), so spells and abilities on the
     * stack are counted here (getNumCandidates), as Forge's targeting does when it lists them.
     */
    static boolean hasRequiredTargets(SpellAbility sa) {
        for (SpellAbility s = sa; s != null; s = s.getSubAbility()) {
            TargetRestrictions tr = s.getTargetRestrictions();
            if (!s.usesTargeting() || tr == null || s.getMinTargets() <= 0) continue;
            boolean any = tr.getZone().contains(ZoneType.Stack) ? tr.getNumCandidates(s) > 0 : tr.hasCandidates(s);
            if (!any) return false;
        }
        return true;
    }

    /** Forge's probe, or, when it says no, the rules-only estimate. */
    static boolean affordable(SpellAbility sa, Player p) {
        if (sa.getActivatingPlayer() == null) sa.setActivatingPlayer(p);
        if (ComputerUtilCost.canPayCost(sa, p, false)) return true;
        return estimatePayable(sa, p, 0);
    }

    /** Non-mana costs payable (Forge's own check) and the mana cost, with X = x, covered by the available mana. */
    static boolean estimatePayable(SpellAbility sa, Player p, int x) {
        Cost cost = sa.getPayCosts();
        if (cost == null) return true;
        if (!CostPayment.canPayAdditionalCosts(cost, sa, false)) return false;
        ManaCostBeingPaid mana = ComputerUtilMana.calculateManaCost(cost, sa, p, true, x, false);
        return covers(mana, sa, p);
    }

    /**
     * The largest X in [lo, hi] the seat can pay for this ability (Forge's AI payer or the estimate), or lo - 1 if none.
     * X costs are monotone, so the scan stops at the first unpayable value.
     */
    static int maxPayableX(SpellAbility sa, Player p, int lo, int hi) {
        int best = lo - 1;
        Integer announced = sa.getXManaCostPaid(); // a value left from an earlier attempt would count as X = 0's cost
        sa.setXManaCostPaid(null);
        try {
            for (int x = Math.max(0, lo); x <= hi; x++) {
                boolean ok;
                try {
                    ok = ComputerUtilMana.canPayManaCost(sa, p, x, false) || estimatePayable(sa, p, x);
                } catch (RuntimeException e) {
                    return hi; // can't probe it: don't bound it
                }
                if (!ok) break;
                best = x;
            }
        } finally {
            sa.setXManaCostPaid(announced);
        }
        return best;
    }

    /** One mana a source (or the pool) can make: the mana types it may be (ManaAtom bits, colourless included). */
    private record Unit(int types) { }

    /**
     * Mana the seat could make for `paidFor` right now: floating mana, plus each untapped source's best mana ability
     * without a mana cost of its own (its amount, any of the types its abilities make). Optimistic for sources that
     * make several mana of one chosen colour; filter lands (abilities with a mana cost) are left out.
     */
    private static List<Unit> units(SpellAbility paidFor, Player p) {
        List<Unit> out = new ArrayList<>();
        for (Mana m : p.getManaPool()) out.add(new Unit(m.getColor() == 0 ? ManaAtom.COLORLESS : m.getColor()));
        List<Card> cards = new ArrayList<>(p.getCardsIn(ZoneType.Battlefield));
        cards.addAll(p.getCardsIn(ZoneType.Hand)); // Elvish Spirit Guide and the like
        java.util.Set<Card> spent = spentByCost(paidFor, p);
        for (Card c : cards) {
            if (spent.contains(c)) continue;
            int amount = 0, types = 0;
            for (SpellAbility ma : c.getManaAbilities()) {
                try {
                    ma.setActivatingPlayer(p);
                    Cost mc = ma.getPayCosts();
                    if (mc != null && mc.hasManaCost()) continue;
                    if (!ma.canPlay() || (mc != null && !CostPayment.canPayAdditionalCosts(mc, ma, false))) continue;
                    int t = 0;
                    for (byte atom : ManaAtom.MANATYPES) if (paidFor == null || ma.isManaAbilityFor(paidFor, atom)) t |= atom;
                    int n = paidFor != null ? ma.totalAmountOfManaGenerated(paidFor, true) : ma.amountOfManaGenerated(true);
                    if (t == 0 || n <= 0) continue;
                    types |= t;
                    amount = Math.max(amount, n);
                } catch (RuntimeException e) {
                    // a mana ability that can't be probed out of context is left out
                }
            }
            for (int i = 0; i < amount; i++) out.add(new Unit(types));
        }
        return out;
    }

    /**
     * Whether some mana ability of this source (mana-costed ones included) can make a type of mana the payment still
     * needs: any type while generic mana is owed, else one of the coloured / colourless shards' types. Forge's payment
     * input marks every source with a playable mana ability, even a Forest when only {B} is owed.
     */
    static boolean helpsPay(Card c, ManaCostBeingPaid owing, SpellAbility paidFor, Player p) {
        int needed = 0;
        for (ManaCostShard s : owing.getDistinctShards()) {
            if (owing.getUnpaidShards(s) <= 0) continue;
            if (s.isGeneric() || s.isPhyrexian()) return true;
            int t = s.getShard() & (ManaAtom.ALL_MANA_COLORS | ManaAtom.COLORLESS);
            if (t == 0) return true;
            needed |= t;
        }
        if (needed == 0) return true;
        for (SpellAbility ma : c.getManaAbilities()) {
            try {
                ma.setActivatingPlayer(p);
                for (byte atom : ManaAtom.MANATYPES) if ((needed & atom) != 0 && ma.isManaAbilityFor(paidFor, atom)) return true;
            } catch (RuntimeException e) {
                return true; // can't probe it: offer it
            }
        }
        return false;
    }

    /**
     * Permanents the cost itself uses up, so they can't also make mana for it: the host of a spell (it's being cast),
     * the host of an ability whose cost taps or sacrifices it (Castle Vantress, a mana creature's {T} ability), and
     * permanents a sacrifice cost will take. For "sacrifice N of a type" the choice is the agent's: only as many of the
     * candidates that make mana as the cost can't take from the others are left out (the ones making least).
     */
    private static java.util.Set<Card> spentByCost(SpellAbility paidFor, Player p) {
        java.util.Set<Card> out = new java.util.HashSet<>();
        if (paidFor == null) return out;
        Card host = paidFor.getHostCard();
        if (host != null && paidFor.isSpell()) out.add(host);
        Cost cost = paidFor.getPayCosts();
        if (cost == null || host == null) return out;
        if (cost.hasTapCost()) out.add(host);
        for (CostPart part : cost.getCostParts()) {
            if (!(part instanceof CostSacrifice)) continue;
            if (part.payCostFromSource()) { out.add(host); continue; }
            try {
                int n = part.getAbilityAmount(paidFor);
                List<Card> candidates = new ArrayList<>(CardLists.getValidCards(
                        CardLists.filter(p.getCardsIn(ZoneType.Battlefield), CardPredicates.canBeSacrificedBy(paidFor, false)),
                        part.getType().split(";"), p, host, paidFor));
                candidates.removeAll(out);
                List<Card> makers = new ArrayList<>();
                for (Card c : candidates) if (!c.getManaAbilities().isEmpty()) makers.add(c);
                int forced = n - (candidates.size() - makers.size());
                makers.sort(java.util.Comparator.comparingInt(c -> manaFrom(c, paidFor, p)));
                for (int i = 0; i < forced && i < makers.size(); i++) out.add(makers.get(i));
            } catch (RuntimeException e) {
                // an unusual sacrifice type: counted as not taking a mana source
            }
        }
        return out;
    }

    /** Mana the seat could make right now, by the same count as the estimate. */
    static int availableMana(SpellAbility paidFor, Player p) {
        return units(paidFor, p).size();
    }

    /** Mana each source could make for this payment (the most of any one of its mana abilities), by card id. */
    static int manaFrom(Card c, SpellAbility paidFor, Player p) {
        int amount = 0;
        for (SpellAbility ma : c.getManaAbilities()) {
            try {
                ma.setActivatingPlayer(p);
                amount = Math.max(amount, paidFor != null ? ma.totalAmountOfManaGenerated(paidFor, true) : ma.amountOfManaGenerated(true));
            } catch (RuntimeException e) {
                // left out
            }
        }
        return Math.max(1, amount);
    }

    /**
     * Whether the available mana covers this cost: each coloured / colourless / hybrid shard matched to a mana that
     * can pay it (bipartite matching), generic shards to whatever is left. Phyrexian shards are left to life.
     */
    static boolean covers(ManaCostBeingPaid cost, SpellAbility paidFor, Player p) {
        List<Integer> restricted = new ArrayList<>();
        int generic = 0;
        for (ManaCostShard s : cost.getDistinctShards()) {
            int n = cost.getUnpaidShards(s);
            if (s.isPhyrexian()) continue;
            if (s.isGeneric()) { generic += n; continue; }
            int types = s.getShard() & (ManaAtom.ALL_MANA_COLORS | ManaAtom.COLORLESS);
            for (int i = 0; i < n; i++) if (types != 0) restricted.add(types); else generic++;
        }
        if (restricted.isEmpty() && generic == 0) return true;
        List<Unit> units = units(paidFor, p);
        if (units.size() < restricted.size() + generic) return false;
        int[] owner = new int[units.size()];
        java.util.Arrays.fill(owner, -1);
        for (int i = 0; i < restricted.size(); i++) {
            if (!augment(i, restricted, units, owner, new boolean[units.size()])) return false;
        }
        return true;
    }

    private static boolean augment(int shard, List<Integer> restricted, List<Unit> units, int[] owner, boolean[] seen) {
        for (int u = 0; u < units.size(); u++) {
            if (seen[u] || (units.get(u).types() & restricted.get(shard)) == 0) continue;
            seen[u] = true;
            if (owner[u] < 0 || augment(owner[u], restricted, units, owner, seen)) { owner[u] = shard; return true; }
        }
        return false;
    }
}
