package forge.bridge;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;
import java.util.function.Supplier;

import org.apache.commons.lang3.tuple.ImmutablePair;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import forge.LobbyPlayer;
import forge.ai.AiCardMemory;
import forge.ai.ComputerUtilAbility;
import forge.ai.ComputerUtilCard;
import forge.ai.ComputerUtilCost;
import forge.ai.ComputerUtilMana;
import forge.ai.PlayerControllerAi;
import forge.card.ColorSet;
import forge.card.ICardFace;
import forge.card.MagicColor;
import forge.card.mana.ManaCost;
import forge.card.mana.ManaCostShard;
import forge.game.Game;
import forge.game.GameActionUtil;
import forge.game.GameEndReason;
import forge.game.GameEntity;
import forge.game.GameObject;
import forge.game.card.Card;
import forge.game.card.CardCollection;
import forge.game.card.CardCollectionView;
import forge.game.card.CounterType;
import forge.game.combat.Combat;
import forge.game.combat.CombatUtil;
import forge.game.cost.Cost;
import forge.game.cost.CostDecisionMakerBase;
import forge.game.cost.CostPart;
import forge.game.cost.CostPartMana;
import forge.game.cost.CostPayment;
import forge.game.mana.ManaConversionMatrix;
import forge.game.mana.ManaCostBeingPaid;
import forge.game.phase.PhaseHandler;
import forge.game.phase.PhaseType;
import forge.game.player.DelayedReveal;
import forge.game.player.PlaySpellAbility;
import forge.game.player.Player;
import forge.game.player.PlayerActionConfirmMode;
import forge.game.replacement.ReplacementEffect;
import forge.game.spellability.AbilitySub;
import forge.game.spellability.OptionalCostValue;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.SpellAbilityStackInstance;
import forge.game.spellability.TargetRestrictions;
import forge.game.trigger.WrappedAbility;
import forge.game.zone.ZoneType;
import forge.util.ITriggerEvent;
import forge.util.collect.FCollectionView;

/**
 * A Forge player whose decisions are made by an external agent.
 *
 * Spells and abilities the agent chooses are cast through Forge's generic
 * PlaySpellAbility path (the one human players use). That path asks the
 * controller for every sub-decision, and each is routed to the agent:
 * alternative/optional costs (kicker, ...), X, modes, targets (incl. spells on the
 * stack and divided damage), which cards pay sacrifice/discard/exile/tap costs,
 * and which mana sources to tap. Triggers (ordering, optional "may", targets),
 * combat (attacks, exert, blocks, damage assignment), scry/surveil, library
 * ordering, searches, edicts, "pay or else" costs, play/draw and generic choices
 * from effects are also the agent's.
 *
 * The class still extends Forge's AI controller: when the agent's answer is missing
 * or illegal, or for the few rare decision types at the bottom of this file, the AI
 * decides and a "delegated" message is sent so the harness can count it.
 */
public class PlayerControllerExternal extends PlayerControllerAi {
    private static final int MAX_ENUMERATED_OPTIONS = 60;

    private final BridgeClient client;
    private final MatchContext ctx;
    private final int seat;
    /** The spell ability the agent chose at the last priority. */
    private SpellAbility agentChosen;
    /** > 0 while Forge's AI is deciding on our behalf; nested choices then stay with the AI. */
    private int aiDepth = 0;
    /** Casts that rolled back, withheld from priority until the game state changes, so a bot can't re-pick them forever. */
    private final Set<String> failedCasts = new HashSet<>();
    /** The harness flagged the last answer as a forfeit (the agent failed the decision; this is the null action). */
    private boolean lastAnswerForfeit = false;
    /** True while an agent-chosen cast is being set up and paid for. */
    private boolean inAgentCast = false;
    /** A sub-decision of the current cast was forfeited: the next cancellable step cancels the cast. */
    private boolean castCancelled = false;
    private String failedCastsKey = "";

    public PlayerControllerExternal(Game game, Player p, LobbyPlayer lp, BridgeClient client, MatchContext ctx, int seat) {
        super(game, p, lp);
        this.client = client;
        this.ctx = ctx;
        this.seat = seat;
    }

    // ====================================================================== plumbing

    /** Run Forge-AI code for this player; any controller calls it makes stay with the AI. */
    private <T> T asAi(Supplier<T> f) {
        aiDepth++;
        try { return f.get(); } finally { aiDepth--; }
    }

    private void asAiRun(Runnable f) {
        aiDepth++;
        try { f.run(); } finally { aiDepth--; }
    }

    private boolean ai() {
        return aiDepth > 0;
    }

    /** Report a decision that Forge's AI made on the agent's behalf. */
    void delegated(String what, String reason) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "delegated");
        o.addProperty("seat", seat);
        o.addProperty("game", ctx.game);
        o.addProperty("what", what);
        o.addProperty("reason", reason);
        client.send(o);
    }

    /** The agent failed a decision in-game and got the null action; counted against the agent, unlike a delegation. */
    void forfeited(String what, String reason) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "forfeit");
        o.addProperty("seat", seat);
        o.addProperty("game", ctx.game);
        o.addProperty("what", what);
        o.addProperty("reason", reason);
        client.send(o);
    }

    /** A forfeited sub-decision during an agent cast: every later step of that cast refuses, so Forge rolls it back. */
    boolean castCancelled() {
        return inAgentCast && castCancelled;
    }

    /** Ask the agent; returns chosen ids, or null if there's no valid answer. */
    List<String> ask(String kind, String prompt, List<Opt> options, int min, int max, JsonObject extraState, JsonObject hints) {
        max = Math.min(max, options.size());
        if (options.isEmpty() || min > max) return null;
        JsonObject req = new JsonObject();
        req.addProperty("seat", seat);
        req.addProperty("game", ctx.game);
        req.addProperty("kind", kind);
        req.addProperty("prompt", prompt);
        JsonObject state = StateView.build(getGame(), player, ctx, seat);
        if (extraState != null) for (Map.Entry<String, JsonElement> e : extraState.entrySet()) state.add(e.getKey(), e.getValue());
        req.add("state", state);
        JsonArray opts = new JsonArray();
        for (Opt o : options) opts.add(o.toJson());
        req.add("options", opts);
        req.addProperty("min", min);
        req.addProperty("max", max);
        if (hints != null) req.add("hints", hints);
        JsonObject ans = client.request(req);
        lastAnswerForfeit = ans != null && ans.has("forfeit") && ans.get("forfeit").getAsBoolean();
        if (lastAnswerForfeit && inAgentCast) castCancelled = true;
        if (ans == null || !ans.has("choice")) return null;
        Set<String> valid = new HashSet<>();
        for (Opt o : options) valid.add(o.id);
        List<String> out = new ArrayList<>();
        for (JsonElement e : ans.getAsJsonArray("choice")) {
            String id = e.getAsString();
            if (!valid.contains(id) || out.contains(id)) return null;
            out.add(id);
        }
        return out.size() < min || out.size() > max ? null : out;
    }

    List<String> ask(String kind, String prompt, List<Opt> options, int min, int max) {
        return ask(kind, prompt, options, min, max, null, null);
    }

    /** Single choice among labels; returns the index or -1. */
    private int askIndex(String kind, String prompt, List<String> labels, List<String> cardNames) {
        List<Opt> opts = new ArrayList<>();
        for (int i = 0; i < labels.size(); i++) opts.add(new Opt("o" + (i + 1), labels.get(i), cardNames == null ? null : cardNames.get(i)));
        List<String> r = ask(kind, prompt, opts, 1, 1);
        return r == null ? -1 : Integer.parseInt(r.get(0).substring(1)) - 1;
    }

    private Boolean askYesNo(String kind, String prompt, String yes, String no) {
        List<String> r = ask(kind, prompt, List.of(new Opt("yes", yes, null), new Opt("no", no, null)), 1, 1);
        return r == null ? null : r.get(0).equals("yes");
    }

    CardCollection askCards(String kind, String prompt, Iterable<Card> cards, int min, int max) {
        List<String> r = ask(kind, prompt, cardOptions(cards), min, max);
        if (r == null) return null;
        CardCollection out = new CardCollection();
        for (String id : r) out.add(byId(cards, id));
        return out;
    }

    /** Agent orders items one pick at a time ("which comes first?"). Returns indices in chosen order, or null. */
    private List<Integer> askOrder(String kind, String prompt, List<String> labels, List<String> cardNames) {
        List<Integer> remaining = new ArrayList<>();
        for (int i = 0; i < labels.size(); i++) remaining.add(i);
        List<Integer> order = new ArrayList<>();
        while (remaining.size() > 1) {
            List<Opt> opts = new ArrayList<>();
            for (int i : remaining) opts.add(new Opt("o" + (i + 1), labels.get(i), cardNames == null ? null : cardNames.get(i)));
            JsonObject extra = new JsonObject();
            extra.addProperty("alreadyOrdered", order.size());
            List<String> r = ask(kind, prompt + (order.isEmpty() ? "" : " (" + order.size() + " already placed; choose the next one)"), opts, 1, 1, extra, null);
            if (r == null) return null;
            Integer pick = Integer.parseInt(r.get(0).substring(1)) - 1;
            order.add(pick);
            remaining.remove(pick);
        }
        order.addAll(remaining);
        return order;
    }

    private static String cardLabel(Card c) {
        StringBuilder sb = new StringBuilder(c.getName());
        if (c.isCreature()) sb.append(' ').append(c.getNetPower()).append('/').append(c.getNetToughness());
        if (c.isTapped()) sb.append(" (tapped)");
        return sb.toString();
    }

    private String owner(Card c) {
        return c.getController().equals(player) ? "yours" : "opponent's";
    }

    static String truncate(String s, int n) {
        if (s == null) return "";
        s = s.replace('\n', ' ');
        return s.length() <= n ? s : s.substring(0, n - 1) + "…";
    }

    private List<Opt> cardOptions(Iterable<Card> cards) {
        List<Opt> out = new ArrayList<>();
        for (Card c : cards) {
            String zone = c.getZone() != null ? String.valueOf(c.getZone().getZoneType()) : "?";
            out.add(new Opt(StateView.id(c), cardLabel(c) + " [" + zone + ", " + owner(c) + "]", c.getName()));
        }
        return out;
    }

    private static Card byId(Iterable<Card> cards, String id) {
        for (Card c : cards) if (StateView.id(c).equals(id)) return c;
        return null;
    }

    private static String src(SpellAbility sa) {
        return sa != null && sa.getHostCard() != null ? sa.getHostCard().getName() + ": " : "";
    }

    private static String describe(SpellAbility sa) {
        if (sa == null) return "?";
        String host = sa.getHostCard() != null ? sa.getHostCard().getName() : "?";
        String d = sa.getStackDescription();
        if (d == null || d.isEmpty()) d = sa.getDescription();
        return host + " — " + truncate(d, 200);
    }

    private boolean turnCapReached() {
        if (getGame().getPhaseHandler().getTurn() > ctx.maxTurns && !getGame().isGameOver()) {
            client.log("turn cap reached; declaring draw");
            getGame().setGameOver(GameEndReason.Draw);
            return true;
        }
        return getGame().isGameOver();
    }

    /** All ways to split `total` into `parts` parts (each >= minEach); null if more than `cap`. */
    static List<int[]> compositions(int total, int parts, int minEach, int cap) {
        List<int[]> out = new ArrayList<>();
        if (parts <= 0 || total < minEach * parts) return out;
        if (!compose(total - minEach * parts, 0, new int[parts], minEach, out, cap)) return null;
        return out;
    }

    private static boolean compose(int left, int i, int[] cur, int minEach, List<int[]> out, int cap) {
        if (i == cur.length - 1) {
            cur[i] = minEach + left;
            out.add(cur.clone());
            return out.size() <= cap;
        }
        for (int v = left; v >= 0; v--) {
            cur[i] = minEach + v;
            if (!compose(left - v, i + 1, cur, minEach, out, cap)) return false;
        }
        return true;
    }

    // ====================================================================== game start

    @Override
    public Player chooseStartingPlayer(boolean isFirstGame) {
        if (ai()) return super.chooseStartingPlayer(isFirstGame);
        Boolean play = askYesNo("play_draw", (isFirstGame ? "You won the die roll." : "You lost the previous game.") + " Do you want to play first or draw first?",
                "Play first", "Draw first");
        if (play == null) { delegated("play_draw", "no valid answer"); return super.chooseStartingPlayer(isFirstGame); }
        return play ? player : player.getOpponents().get(0);
    }

    @Override
    public boolean mulliganKeepHand(Player firstPlayer, int cardsToReturn) {
        CardCollectionView hand = player.getCardsIn(ZoneType.Hand);
        int lands = 0;
        for (Card c : hand) if (c.isLand()) lands++;
        JsonObject extra = new JsonObject();
        extra.addProperty("onThePlay", firstPlayer.equals(player));
        JsonObject hints = new JsonObject();
        hints.addProperty("handLands", lands);
        hints.addProperty("handSize", hand.size() - cardsToReturn);
        JsonObject keepMeta = new JsonObject(); keepMeta.addProperty("keep", true);
        JsonObject mullMeta = new JsonObject(); mullMeta.addProperty("keep", false);
        List<Opt> opts = List.of(
                new Opt("keep", cardsToReturn > 0 ? "Keep this hand (then put " + cardsToReturn + " card(s) on the bottom)" : "Keep this hand", null, keepMeta),
                new Opt("mulligan", "Mulligan (shuffle, draw 7, then bottom " + (cardsToReturn + 1) + ")", null, mullMeta));
        List<String> r = ask("mulligan", "Opening hand. Keep or mulligan?", opts, 1, 1, extra, hints);
        if (r == null) { delegated("mulligan", "no valid answer"); return asAi(() -> super.mulliganKeepHand(firstPlayer, cardsToReturn)); }
        return r.get(0).equals("keep");
    }

    @Override
    public CardCollectionView tuckCardsViaMulligan(CardCollectionView hand, int cardsToReturn) {
        CardCollection r = askCards("london_bottom", "Choose " + cardsToReturn + " card(s) to put on the bottom of your library.", hand, cardsToReturn, cardsToReturn);
        if (r == null) { delegated("london_bottom", "no valid answer"); return asAi(() -> super.tuckCardsViaMulligan(hand, cardsToReturn)); }
        return r;
    }

    // ====================================================================== priority

    private boolean shouldStop() {
        if (!ctx.smartStops) return true;
        Game g = getGame();
        PhaseHandler ph = g.getPhaseHandler();
        PhaseType phase = ph.getPhase();
        boolean myTurn = ph.isPlayerTurn(player);
        if (!g.getStack().isEmpty()) {
            SpellAbility top = g.getStack().peekAbility();
            return top == null || !player.equals(top.getActivatingPlayer());
        }
        if (phase == null) return false;
        if (myTurn) return phase.isMain() || phase == PhaseType.COMBAT_DECLARE_BLOCKERS;
        return phase == PhaseType.COMBAT_DECLARE_ATTACKERS || phase == PhaseType.COMBAT_DECLARE_BLOCKERS
                || phase == PhaseType.END_OF_TURN || phase == PhaseType.UPKEEP;
    }

    @Override
    public List<SpellAbility> chooseSpellAbilityToPlay() {
        agentChosen = null;
        if (turnCapReached()) return null;
        if (ai()) return super.chooseSpellAbilityToPlay();
        if (!shouldStop()) { ctx.auto(seat, "policy", "priority", "not a meaningful stop"); return null; }
        Game g = getGame();
        String stateKey = priorityStateKey(g);
        if (!stateKey.equals(failedCastsKey)) {
            failedCasts.clear();
            failedCastsKey = stateKey;
        }
        CardCollection cards = ComputerUtilCard.dedupeCards(ComputerUtilAbility.getAvailableCards(g, player));
        // Like the human UI: each ability plus its alternative costs (flashback, evoke, ...). Additional and optional
        // costs (kicker, buyback, ...) are chosen during casting by PlaySpellAbility, so they must not be pre-applied here.
        List<SpellAbility> all = new ArrayList<>();
        for (SpellAbility sa : ComputerUtilAbility.getSpellAbilities(cards, player)) {
            sa.setActivatingPlayer(player);
            all.add(sa);
            all.addAll(GameActionUtil.getAlternativeCosts(sa, player, false));
        }
        Map<String, SpellAbility> byId = new LinkedHashMap<>();
        List<Opt> opts = new ArrayList<>();
        JsonObject passMeta = new JsonObject(); passMeta.addProperty("type", "pass");
        opts.add(new Opt("pass", g.getStack().isEmpty() ? "Pass priority (move to the next step)" : "Pass priority (let the top of the stack resolve)", null, passMeta));
        int n = 0;
        for (SpellAbility sa : all) {
            try {
                if (sa.isManaAbility() || sa.isTrigger()) continue;
                sa.setActivatingPlayer(player);
                if (!sa.canPlay()) continue;
                Card host = sa.getHostCard();
                String label; JsonObject meta = new JsonObject();
                if (sa.isLandAbility()) {
                    if (!player.canPlayLand(host, false, sa)) continue;
                    label = "Play land " + host.getName();
                    meta.addProperty("type", "land");
                } else {
                    if (failedCasts.contains(castKey(sa))) continue;
                    if (!ComputerUtilCost.canPayCost(sa, player, false)) continue;
                    if (!hasRequiredTargets(sa)) continue;
                    String cost = sa.getPayCosts() != null ? sa.getPayCosts().toSimpleString() : "";
                    if (sa.isSpell()) {
                        label = "Cast " + host.getName() + (cost.isEmpty() ? "" : " (" + cost + ")");
                        String desc = sa.getDescription();
                        if (desc != null && !desc.isEmpty() && !desc.startsWith(host.getName())) label += " — " + truncate(desc, 120);
                        meta.addProperty("type", "spell");
                        meta.addProperty("cmc", host.getCMC());
                    } else {
                        label = "Activate " + host.getName() + ": " + truncate(sa.getDescription(), 160);
                        meta.addProperty("type", "ability");
                    }
                    String zone = host.getZone() != null ? String.valueOf(host.getZone().getZoneType()) : "";
                    if (!zone.equals("Hand") && !zone.equals("Battlefield")) label += " [from " + zone + "]";
                }
                String id = "sa" + (++n);
                byId.put(id, sa);
                opts.add(new Opt(id, label, host.getName(), meta));
            } catch (RuntimeException e) {
                // Some abilities throw when probed out of context; they are simply not offered.
            }
        }
        if (opts.size() == 1) { ctx.auto(seat, "policy", "priority", "nothing playable and affordable"); return null; }
        String prompt = g.getStack().isEmpty()
                ? "You have priority. Play a land, cast a spell, activate an ability, or pass."
                : "You have priority with objects on the stack. Respond, or pass to let the top object resolve.";
        List<String> r = ask("priority", prompt, opts, 1, 1, null, null);
        if (r == null) {
            delegated("priority", "no valid answer");
            return asAi(() -> super.chooseSpellAbilityToPlay());
        }
        if (r.get(0).equals("pass")) return null;
        agentChosen = byId.get(r.get(0));
        return Collections.singletonList(agentChosen);
    }

    @Override
    public boolean playChosenSpellAbility(SpellAbility sa) {
        if (sa.isLandAbility() || ai()) return super.playChosenSpellAbility(sa);
        if (sa != agentChosen) {
            // chosen by Forge AI as a fallback: let the AI play it the AI way
            return asAi(() -> super.playChosenSpellAbility(sa));
        }
        agentChosen = null;
        // Generic casting path: asks this controller for optional costs, X, modes, targets, cost choices and mana.
        inAgentCast = true;
        castCancelled = false;
        boolean cast;
        try {
            cast = PlaySpellAbility.playSpellAbility(this, player, sa);
        } finally {
            inAgentCast = false;
        }
        if (!cast) {
            client.log("cast of " + describe(sa) + (castCancelled ? " was forfeited (a decision failed); rolled back" : " was cancelled or could not be paid; rolled back"));
            failedCasts.add(castKey(sa));
        }
        castCancelled = false;
        return true;
    }

    /** Stable identity for a cast option: Forge builds fresh SpellAbility objects for alternative costs on every call. */
    private static String castKey(SpellAbility sa) {
        Card host = sa.getHostCard();
        return (host != null ? host.getId() : -1) + "|" + sa.getDescription() + "|" + (sa.getPayCosts() != null ? sa.getPayCosts().toSimpleString() : "");
    }

    /** Every ability in the chain that must target has at least one legal candidate (Forge's human UI cancels the cast otherwise). */
    private static boolean hasRequiredTargets(SpellAbility sa) {
        for (SpellAbility s = sa; s != null; s = s.getSubAbility()) {
            if (!s.usesTargeting()) continue;
            TargetRestrictions tgt = s.getTargetRestrictions();
            if (s.getMinTargets() > 0 && !tgt.hasCandidates(s)) return false;
        }
        return true;
    }

    /** Changes whenever anything that could make a rolled-back cast succeed changes. */
    private String priorityStateKey(Game g) {
        PhaseHandler ph = g.getPhaseHandler();
        return ph.getTurn() + "|" + ph.getPhase() + "|" + g.getStack().size()
                + "|" + g.getCardsIn(ZoneType.Battlefield).size()
                + "|" + player.getCardsIn(ZoneType.Hand).size()
                + "|" + player.getManaPool().totalMana();
    }

    // ====================================================================== casting sub-decisions

    @Override
    public SpellAbility getAbilityToPlay(Card hostCard, List<SpellAbility> abilities, ITriggerEvent triggerEvent) {
        if (ai() || abilities.size() <= 1) return super.getAbilityToPlay(hostCard, abilities, triggerEvent);
        List<String> labels = new ArrayList<>();
        for (SpellAbility a : abilities) labels.add(truncate(a.toUnsuppressedString(), 200));
        int i = askIndex("choose_ability", "Choose how to cast/activate " + hostCard.getName() + ".", labels, null);
        if (i < 0) { delegated("choose_ability", "no valid answer"); return asAi(() -> super.getAbilityToPlay(hostCard, abilities, triggerEvent)); }
        return abilities.get(i);
    }

    @Override
    public List<OptionalCostValue> chooseOptionalCosts(SpellAbility chosen, List<OptionalCostValue> optionalCostValues) {
        if (ai() || optionalCostValues.isEmpty()) return super.chooseOptionalCosts(chosen, optionalCostValues);
        // Only offer optional costs that are affordable on top of the spell's own cost.
        List<OptionalCostValue> affordable = new ArrayList<>();
        for (OptionalCostValue ocv : optionalCostValues) {
            try {
                if (ComputerUtilCost.canPayCost(GameActionUtil.addOptionalCosts(chosen, Collections.singletonList(ocv)), player, false)) affordable.add(ocv);
            } catch (RuntimeException e) {
                affordable.add(ocv); // can't probe it: offer it and let payment decide
            }
        }
        if (affordable.isEmpty()) return new ArrayList<>();
        List<Opt> opts = new ArrayList<>();
        for (int i = 0; i < affordable.size(); i++) opts.add(new Opt("c" + (i + 1), affordable.get(i).toString(), null));
        List<String> r = ask("optional_costs", "Choose any optional costs to pay for " + (chosen.getHostCard() != null ? chosen.getHostCard().getName() : "this spell")
                + " (e.g. kicker). Choose none to pay only the normal cost.", opts, 0, opts.size());
        if (r == null) { delegated("optional_costs", "no valid answer"); return asAi(() -> super.chooseOptionalCosts(chosen, optionalCostValues)); }
        List<OptionalCostValue> out = new ArrayList<>();
        for (String id : r) out.add(affordable.get(Integer.parseInt(id.substring(1)) - 1));
        return out;
    }

    @Override
    public Integer announceRequirements(SpellAbility ability, int min, int max, String announce) {
        if (ai()) return super.announceRequirements(ability, min, max, announce);
        if (castCancelled()) return null;
        int cap = max;
        Cost cost = ability.getPayCosts();
        if ("X".equalsIgnoreCase(announce) && cost != null && cost.hasXInAnyCostPart()) {
            int avail = ComputerUtilMana.getAvailableManaEstimate(player, false);
            ManaCost total = cost.getTotalMana();
            int xs = Math.max(1, total.countX());
            cap = Math.min(max, Math.max(min, (avail - total.getCMC()) / xs));
        }
        cap = Math.min(cap, min + 30);
        List<Opt> opts = new ArrayList<>();
        for (int v = min; v <= cap; v++) opts.add(new Opt("n" + v, announce + " = " + v, null));
        List<String> r = ask("announce_x", "Choose the value of " + announce + " for " + describe(ability) + ".", opts, 1, 1);
        if (castCancelled()) return null;
        if (r == null) { delegated("announce_x", "no valid answer"); return asAi(() -> super.announceRequirements(ability, min, max, announce)); }
        return Integer.parseInt(r.get(0).substring(1));
    }

    @Override
    public List<AbilitySub> chooseModeForAbility(SpellAbility sa, List<AbilitySub> possible, int min, int num, boolean allowRepeat) {
        if (ai() || possible.isEmpty()) return super.chooseModeForAbility(sa, possible, min, num, allowRepeat);
        if (allowRepeat) { delegated("choose_mode", "modes that may repeat"); return asAi(() -> super.chooseModeForAbility(sa, possible, min, num, allowRepeat)); }
        List<Opt> opts = new ArrayList<>();
        for (int i = 0; i < possible.size(); i++) opts.add(new Opt("m" + (i + 1), truncate(possible.get(i).getDescription(), 200), null));
        List<String> r = ask("choose_mode", "Choose " + (min == num ? String.valueOf(num) : min + " to " + num) + " mode(s) for " + describe(sa) + ".", opts, min, num);
        if (r == null) { delegated("choose_mode", "no valid answer"); return asAi(() -> super.chooseModeForAbility(sa, possible, min, num, allowRepeat)); }
        List<Integer> idx = new ArrayList<>();
        for (String id : r) idx.add(Integer.parseInt(id.substring(1)) - 1);
        Collections.sort(idx); // modes resolve in printed order
        List<AbilitySub> out = new ArrayList<>();
        for (int i : idx) out.add(possible.get(i));
        return out;
    }

    /** Targets for one level of an ability chain (Forge's setupTargets walks the chain). Includes divided damage. */
    @Override
    public boolean chooseTargetsFor(SpellAbility cur) {
        if (ai()) return super.chooseTargetsFor(cur);
        if (castCancelled()) return false;
        TargetRestrictions tr = cur.getTargetRestrictions();
        if (tr == null) return super.chooseTargetsFor(cur);
        Card host = cur.getHostCard();
        List<Opt> opts = new ArrayList<>();
        Map<String, GameObject> byId = new HashMap<>();
        for (GameEntity e : tr.getAllCandidates(cur, false)) {
            JsonObject meta = new JsonObject();
            if (e instanceof Player p) {
                String id = p.equals(player) ? "you" : "opponent";
                meta.addProperty("hostile", !p.equals(player));
                opts.add(new Opt(id, p.equals(player) ? "You (yourself)" : "Opponent", null, meta));
                byId.put(id, e);
            } else {
                Card c = (Card) e;
                meta.addProperty("hostile", !c.getController().equals(player));
                opts.add(new Opt(StateView.id(c), cardLabel(c) + " (" + owner(c) + ")", c.getName(), meta));
                byId.put(StateView.id(c), e);
            }
        }
        if (tr.getZone().contains(ZoneType.Stack)) {
            int k = 0;
            for (SpellAbilityStackInstance si : getGame().getStack()) {
                SpellAbility onStack = si.getSpellAbility();
                k++;
                if (onStack == null || onStack.getRootAbility() == cur.getRootAbility() || !cur.canTargetSpellAbility(onStack)) continue;
                Card s = onStack.getHostCard();
                boolean mine = player.equals(onStack.getActivatingPlayer());
                JsonObject meta = new JsonObject();
                meta.addProperty("hostile", !mine);
                String id = "stack" + k; // stack1 = top of the stack
                opts.add(new Opt(id, (k == 1 ? "[top of stack] " : "[stack #" + k + "] ") + (mine ? "your " : "opponent's ")
                        + (onStack.isSpell() ? "spell " : "ability ") + (s != null ? s.getName() : "?") + " — " + truncate(si.getStackDescription(), 160),
                        s != null ? s.getName() : null, meta));
                byId.put(id, onStack);
            }
        }
        int min = tr.getMinTargets(host, cur);
        int max = Math.min(tr.getMaxTargets(host, cur), opts.size());
        if (opts.isEmpty() || max <= 0) return min == 0;
        JsonObject extra = new JsonObject();
        extra.addProperty("casting", host != null ? host.getName() : "?");
        // Same wording Forge shows a human (InputSelectTargets): the ability, inheriting the parent's text for sub-abilities, then what to select.
        String abilityText = StateView.clean(cur.toString());
        if (abilityText.isEmpty()) abilityText = StateView.clean(cur.getRootAbility().toString());
        extra.addProperty("abilityText", truncate(abilityText, 300));
        List<String> r = ask("targets", "Choose target(s) for " + (host != null ? host.getName() : "this ability") + ": " + truncate(abilityText, 200)
                        + (tr.getVTSelection() != null && !tr.getVTSelection().isEmpty() ? " (" + tr.getVTSelection() + ")" : ""),
                opts, Math.min(min, max), max, extra, null);
        if (castCancelled()) return false;
        if (r == null) { delegated("targets", "no valid answer"); return asAi(() -> super.chooseTargetsFor(cur)); }
        cur.clearTargets();
        List<GameObject> chosen = new ArrayList<>();
        for (String id : r) { cur.getTargets().add(byId.get(id)); chosen.add(byId.get(id)); }
        if (cur.isDividedAsYouChoose() && !chosen.isEmpty()) divide(cur, chosen, opts, r);
        return cur.isTargetNumberValid();
    }

    /** "Divided as you choose" (Arc Lightning etc.): the agent picks the split; each target gets at least 1. */
    private void divide(SpellAbility cur, List<GameObject> chosen, List<Opt> opts, List<String> ids) {
        int total = cur.getStillToDivide();
        if (chosen.size() == 1) { cur.addDividedAllocation(chosen.get(0), total); return; }
        Map<String, String> labelOf = new HashMap<>();
        for (Opt o : opts) labelOf.put(o.id, o.label);
        List<int[]> splits = compositions(total, chosen.size(), 1, MAX_ENUMERATED_OPTIONS);
        int[] pick = null;
        if (splits != null && !splits.isEmpty()) {
            List<String> labels = new ArrayList<>();
            for (int[] s : splits) {
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < s.length; i++) sb.append(i > 0 ? ", " : "").append(s[i]).append(" to ").append(labelOf.get(ids.get(i)));
                labels.add(sb.toString());
            }
            int i = askIndex("divide", "Divide " + total + " among your targets.", labels, null);
            if (i >= 0) pick = splits.get(i);
        }
        if (pick == null) {
            delegated("divide", splits == null ? "too many ways to divide" : "no valid answer");
            pick = new int[chosen.size()]; // even split, remainder to the first targets
            for (int i = 0; i < pick.length; i++) pick[i] = total / pick.length + (i < total % pick.length ? 1 : 0);
        }
        for (int i = 0; i < pick.length; i++) cur.addDividedAllocation(chosen.get(i), pick[i]);
    }

    @Override
    public CostDecisionMakerBase getCostDecisionMaker(Player p, SpellAbility ability, boolean effect, String prompt) {
        if (ai()) return super.getCostDecisionMaker(p, ability, effect, prompt);
        return new AgentCostDecision(this, p, ability, effect);
    }

    /** The agent chooses which mana sources to tap; Forge assigns them to the cost (colours, hybrid, etc). */
    @Override
    public boolean payManaCost(ManaCost toPay, CostPartMana costPartMana, SpellAbility sa, String prompt, ManaConversionMatrix matrix, boolean effect) {
        if (ai()) return super.payManaCost(toPay, costPartMana, sa, prompt, matrix, effect);
        if (castCancelled()) return false;
        Cost cost = new Cost(toPay, effect);
        ManaCostBeingPaid need;
        CardCollection sources;
        try {
            need = ComputerUtilMana.calculateManaCost(cost, sa, player, true, 0, effect);
            sources = ComputerUtilMana.getAvailableManaSources(player, true);
        } catch (RuntimeException e) {
            delegated("mana_payment", "could not enumerate mana sources");
            return asAi(() -> super.payManaCost(toPay, costPartMana, sa, prompt, matrix, effect));
        }
        if (need == null || need.isPaid() || sources.isEmpty()) {
            ctx.auto(seat, "forced", "mana_payment", "nothing to choose");
            return asAi(() -> super.payManaCost(toPay, costPartMana, sa, prompt, matrix, effect));
        }
        Set<String> names = new HashSet<>();
        boolean interchangeable = true;
        for (Card c : sources) {
            names.add(c.getName());
            if (!InputDriver.interchangeableSource(c)) interchangeable = false;
        }
        boolean meaningful = sources.size() > need.getConvertedManaCost() && (names.size() > 1 || !interchangeable);
        if (!meaningful && !ctx.alwaysAskMana) {
            // Every legal payment taps the same kind of sources: nothing to decide.
            if (sources.size() <= need.getConvertedManaCost()) ctx.auto(seat, "forced", "mana_payment", "exactly enough sources");
            else ctx.auto(seat, "policy", "mana_payment", "interchangeable sources: same-name lands, nothing attached, no counters (engine pays)");
            return asAi(() -> super.payManaCost(toPay, costPartMana, sa, prompt, matrix, effect));
        }
        List<Opt> opts = new ArrayList<>();
        for (Card c : sources) {
            List<String> abil = new ArrayList<>();
            for (SpellAbility m : c.getManaAbilities()) abil.add(truncate(m.getDescription(), 80));
            opts.add(new Opt(StateView.id(c), cardLabel(c) + " — " + String.join(" / ", abil), c.getName()));
        }
        String what = describe(sa);
        String error = "";
        for (int attempt = 0; attempt <= ctx.maxRetries; attempt++) {
            int total = need.getConvertedManaCost();
            List<String> r = ask("mana_payment", error + "Pay " + need + " (" + total + " mana in total, generic and coloured together) for " + what
                    + ". Choose which mana sources to tap, enough to produce all " + total + " mana; only the sources you choose will be used "
                    + "(the engine assigns them to the cost). Sources you don't choose stay untapped.", opts, 1, opts.size(), null, null);
            if (lastAnswerForfeit) return false; // harness already counted the forfeit; the cast is cancelled
            if (r == null) break;
            Set<String> keep = new HashSet<>(r);
            List<Card> reserved = new ArrayList<>();
            for (Card c : sources) {
                if (!keep.contains(StateView.id(c)) && !AiCardMemory.isRememberedCard(player, c, AiCardMemory.MemorySet.HELD_MANA_SOURCES_FOR_NEXT_SPELL)) {
                    AiCardMemory.rememberCard(player, c, AiCardMemory.MemorySet.HELD_MANA_SOURCES_FOR_NEXT_SPELL);
                    reserved.add(c);
                }
            }
            try {
                AiCardMemory.clearMemorySet(player, AiCardMemory.MemorySet.HELD_MANA_SOURCES_FOR_MAIN2);
                AiCardMemory.clearMemorySet(player, AiCardMemory.MemorySet.HELD_MANA_SOURCES_FOR_DECLBLK);
                AiCardMemory.clearMemorySet(player, AiCardMemory.MemorySet.HELD_MANA_SOURCES_FOR_ENEMY_DECLBLK);
                ManaCostBeingPaid test = ComputerUtilMana.calculateManaCost(cost, sa, player, true, 0, effect);
                if (ComputerUtilMana.canPayManaCost(test, sa, player, effect)) {
                    return asAi(() -> super.payManaCost(toPay, costPartMana, sa, prompt, matrix, effect));
                }
            } finally {
                for (Card c : reserved) AiCardMemory.forgetCard(player, c, AiCardMemory.MemorySet.HELD_MANA_SOURCES_FOR_NEXT_SPELL);
            }
            error = "Your previous choice (" + r.size() + " source" + (r.size() == 1 ? "" : "s") + ") could not pay " + need + ", which needs " + total + " mana. ";
        }
        // The agent's sources never covered the cost: forfeit. During a cast that cancels the cast; for an effect, it goes unpaid.
        forfeited("mana_payment", "chosen sources could not pay " + need + " in " + (ctx.maxRetries + 1) + " attempts");
        if (inAgentCast) castCancelled = true;
        return false;
    }

    @Override
    public boolean payCostToPreventEffect(Cost cost, SpellAbility sa, boolean alreadyPaid, FCollectionView<Player> allPayers) {
        if (ai()) return super.payCostToPreventEffect(cost, sa, alreadyPaid, allPayers);
        if (!ComputerUtilCost.canPayCost(cost, sa, player, true)) return false;
        Boolean pay = askYesNo("pay_or_else", src(sa) + "pay " + cost.toSimpleString() + "? (" + describe(sa) + ")",
                "Pay " + cost.toSimpleString(), "Don't pay");
        if (pay == null) { delegated("pay_or_else", "no valid answer"); return asAi(() -> super.payCostToPreventEffect(cost, sa, alreadyPaid, allPayers)); }
        if (!pay) return false;
        return new CostPayment(cost, sa).payComputerCosts(new AgentCostDecision(this, player, sa, true));
    }

    @Override
    public boolean confirmPayment(CostPart costPart, String prompt, SpellAbility sa) {
        if (ai()) return super.confirmPayment(costPart, prompt, sa);
        Boolean r = askYesNo("confirm", src(sa) + (prompt == null ? "Pay " + costPart + "?" : prompt.replace("{0}", String.valueOf(costPart))), "Pay", "Don't pay");
        if (r == null) { delegated("confirm_payment", "no valid answer"); return asAi(() -> super.confirmPayment(costPart, prompt, sa)); }
        return r;
    }

    // ====================================================================== triggers and play effects

    @Override
    public boolean confirmTrigger(WrappedAbility wrapper) {
        if (ai() || wrapper.isMandatory()) return super.confirmTrigger(wrapper);
        Boolean r = askYesNo("confirm", "Optional triggered ability: " + describe(wrapper.getWrappedAbility()) + ". Use it?", "Yes, use it", "No");
        if (r == null) { delegated("confirm_trigger", "no valid answer"); return asAi(() -> super.confirmTrigger(wrapper)); }
        return r;
    }

    /** Returns the resolution order (first element resolves first), like the human controller. */
    @Override
    public List<SpellAbility> orderSimultaneousSa(List<SpellAbility> activePlayerSAs) {
        if (ai() || activePlayerSAs.size() <= 1) return super.orderSimultaneousSa(activePlayerSAs);
        List<String> labels = new ArrayList<>();
        List<String> names = new ArrayList<>();
        for (SpellAbility sa : activePlayerSAs) { labels.add(describe(sa)); names.add(sa.getHostCard() != null ? sa.getHostCard().getName() : null); }
        List<Integer> order = askOrder("order_triggers", "Several of your abilities trigger at once. Choose which one RESOLVES FIRST (it goes on the stack last).", labels, names);
        if (order == null) { delegated("order_triggers", "no valid answer"); return asAi(() -> super.orderSimultaneousSa(activePlayerSAs)); }
        List<SpellAbility> out = new ArrayList<>();
        for (int i : order) out.add(activePlayerSAs.get(i));
        return out;
    }

    @Override
    public void orderAndPlaySimultaneousSa(List<SpellAbility> activePlayerSAs) {
        if (ai()) { super.orderAndPlaySimultaneousSa(activePlayerSAs); return; }
        List<SpellAbility> ordered = orderSimultaneousSa(activePlayerSAs);
        for (int i = ordered.size() - 1; i >= 0; i--) {
            final SpellAbility next = ordered.get(i);
            if (next.isTrigger() && !next.isCopied()) {
                PlaySpellAbility.playSpellAbility(this, player, next);
            } else {
                if (next.isCopied()) {
                    if (next.isSpell()) {
                        if (!next.getHostCard().isInZone(ZoneType.Stack)) {
                            next.setHostCard(getGame().getAction().moveToStack(next.getHostCard(), next));
                        } else {
                            getGame().getStackZone().add(next.getHostCard());
                        }
                    }
                    if (next.isMayChooseNewTargets()) next.setupNewTargets(player);
                }
                getGame().getStack().add(next);
            }
        }
    }

    @Override
    public boolean playTrigger(Card host, WrappedAbility wrapperAbility, boolean isMandatory) {
        if (ai()) return super.playTrigger(host, wrapperAbility, isMandatory);
        return PlaySpellAbility.playSpellAbilityNoStack(this, player, wrapperAbility, false);
    }

    @Override
    public boolean playSaFromPlayEffect(SpellAbility tgtSA) {
        if (ai()) return super.playSaFromPlayEffect(tgtSA);
        if (!tgtSA.getPayCosts().isMandatory()) {
            Boolean r = askYesNo("confirm", "You may cast " + describe(tgtSA) + ". Cast it?", "Cast it", "Don't cast it");
            if (r == null) { delegated("play_from_effect", "no valid answer"); return asAi(() -> super.playSaFromPlayEffect(tgtSA)); }
            if (!r) return false;
        }
        return PlaySpellAbility.playSpellAbility(this, player, tgtSA);
    }

    // ====================================================================== combat

    @Override
    public void declareAttackers(Player attacker, Combat combat) {
        if (turnCapReached()) return;
        if (ai()) { super.declareAttackers(attacker, combat); return; }
        FCollectionView<GameEntity> defenders = combat.getDefenders();
        List<Opt> opts = new ArrayList<>();
        Map<String, Card> atkById = new HashMap<>();
        Map<String, GameEntity> defById = new HashMap<>();
        int oppMaxPower = 0;
        for (Player o : player.getOpponents())
            for (Card b : o.getCreaturesInPlay()) if (!b.isTapped()) oppMaxPower = Math.max(oppMaxPower, b.getNetPower());
        for (Card c : player.getCreaturesInPlay()) {
            if (!CombatUtil.canAttack(c)) continue;
            for (GameEntity d : defenders) {
                if (!CombatUtil.canAttack(c, d)) continue;
                String dname = d instanceof Player p ? (p.equals(player) ? "you" : "opponent") : ((Card) d).getName();
                String did = d instanceof Player ? "player" : StateView.id((Card) d);
                String id = defenders.size() == 1 ? StateView.id(c) : StateView.id(c) + "@" + did;
                JsonObject meta = new JsonObject();
                meta.addProperty("power", c.getNetPower());
                meta.addProperty("toughness", c.getNetToughness());
                meta.addProperty("evasive", c.hasKeyword("Flying"));
                opts.add(new Opt(id, "Attack " + dname + " with " + cardLabel(c), c.getName(), meta));
                atkById.put(id, c);
                defById.put(id, d);
            }
        }
        if (opts.isEmpty()) return;
        JsonObject hints = new JsonObject();
        hints.addProperty("opponentMaxUntappedPower", oppMaxPower);
        String error = "";
        for (int attempt = 0; attempt <= ctx.maxRetries; attempt++) {
            List<String> r = ask("attackers", error + "Declare attackers. Choose any number (none = no attack). Each creature may attack only one defender.",
                    opts, 0, opts.size(), null, hints);
            if (r == null) break;
            Set<Card> used = new HashSet<>();
            boolean ok = true;
            for (String id : r) {
                Card c = atkById.get(id);
                if (!used.add(c)) { ok = false; break; }
                combat.addAttacker(c, defById.get(id));
            }
            if (ok && CombatUtil.validateAttackers(combat)) return;
            for (Card c : new ArrayList<>(combat.getAttackers())) combat.removeFromCombat(c);
            if (lastAnswerForfeit) break;
            error = "Your previous attack was illegal: each creature attacks at most once, and some creatures must attack or can't attack in that combination. ";
        }
        // Null action: no attack, when that is legal. Only a forced attack ("attacks each combat if able") needs the engine's default.
        boolean counted = lastAnswerForfeit; // the harness already counted its own forfeit
        if (CombatUtil.validateAttackers(combat)) {
            if (!counted) forfeited("attackers", "no legal attack in " + (ctx.maxRetries + 1) + " attempts; no attack");
            return;
        }
        if (!counted) forfeited("attackers", "no legal attack in " + (ctx.maxRetries + 1) + " attempts; a required attack was declared by the engine");
        asAiRun(() -> super.declareAttackers(attacker, combat));
    }

    @Override
    public List<Card> exertAttackers(List<Card> attackers) {
        if (ai() || attackers.isEmpty()) return super.exertAttackers(attackers);
        CardCollection r = askCards("exert", "Choose which attacking creatures to exert (they won't untap during your next untap step).", attackers, 0, attackers.size());
        if (r == null) { delegated("exert", "no valid answer"); return asAi(() -> super.exertAttackers(attackers)); }
        return new ArrayList<>(r);
    }

    @Override
    public void declareBlockers(Player defender, Combat combat) {
        if (ai()) { super.declareBlockers(defender, combat); return; }
        List<Opt> opts = new ArrayList<>();
        Map<String, Card[]> pairs = new HashMap<>();
        int incoming = 0;
        for (Card a : combat.getAttackers()) if (combat.getDefenderByAttacker(a) == defender) incoming += a.getNetCombatDamage();
        for (Card b : defender.getCreaturesInPlay()) {
            if (!CombatUtil.canBlock(b, combat)) continue;
            for (Card a : combat.getAttackers()) {
                if (!CombatUtil.canBlock(a, b, combat)) continue;
                String id = StateView.id(b) + "->" + StateView.id(a);
                JsonObject meta = new JsonObject();
                meta.addProperty("attackerPower", a.getNetPower());
                meta.addProperty("blockerSurvives", a.getNetPower() < b.getNetToughness() - b.getDamage() && !a.hasKeyword("Deathtouch"));
                meta.addProperty("killsAttacker", b.getNetPower() >= a.getNetToughness() - a.getDamage() || (b.hasKeyword("Deathtouch") && b.getNetPower() > 0));
                opts.add(new Opt(id, cardLabel(b) + " blocks " + cardLabel(a), b.getName(), meta));
                pairs.put(id, new Card[]{b, a});
            }
        }
        if (opts.isEmpty()) return;
        JsonObject hints = new JsonObject();
        hints.addProperty("incomingLethal", incoming >= defender.getLife());
        String error = "";
        for (int attempt = 0; attempt <= ctx.maxRetries; attempt++) {
            List<String> r = ask("blockers", error + "Declare blockers. Each of your creatures can block one attacker; several can block the same attacker. Choose none to take the damage.",
                    opts, 0, defender.getCreaturesInPlay().size(), null, hints);
            if (r == null) break;
            Set<Card> used = new HashSet<>();
            List<Card> added = new ArrayList<>();
            boolean ok = true;
            for (String id : r) {
                Card[] p = pairs.get(id);
                if (!used.add(p[0])) { ok = false; break; }
                combat.addBlocker(p[1], p[0]);
                added.add(p[0]);
            }
            String why = ok ? CombatUtil.validateBlocks(combat, defender) : "a creature can block only one attacker";
            if (why == null) return;
            for (Card b : added) combat.removeFromCombat(b);
            if (lastAnswerForfeit) break;
            error = "Your previous blocks were illegal (" + why + "). ";
        }
        // Null action: no blocks, when that is legal; otherwise the engine's default satisfies the block requirement.
        boolean counted = lastAnswerForfeit;
        if (CombatUtil.validateBlocks(combat, defender) == null) {
            if (!counted) forfeited("blockers", "no legal blocks in " + (ctx.maxRetries + 1) + " attempts; no blocks");
            return;
        }
        if (!counted) forfeited("blockers", "no legal blocks in " + (ctx.maxRetries + 1) + " attempts; a required block was declared by the engine");
        asAiRun(() -> super.declareBlockers(defender, combat));
    }

    /** Divide an attacker's (or multi-blocking blocker's) combat damage. Null key = damage to the defending player/planeswalker. */
    @Override
    public Map<Card, Integer> assignCombatDamage(Card attacker, CardCollectionView blockers, CardCollectionView remaining, int damageDealt,
            GameEntity defender, boolean overrideOrder) {
        if (ai() || blockers.isEmpty() || damageDealt <= 0) return super.assignCombatDamage(attacker, blockers, remaining, damageDealt, defender, overrideOrder);
        if (!overrideOrder) {
            delegated("assign_damage", "legacy damage-assignment order rules");
            return asAi(() -> super.assignCombatDamage(attacker, blockers, remaining, damageDealt, defender, overrideOrder));
        }
        List<Card> bl = new ArrayList<>(blockers);
        boolean trample = defender != null && attacker.hasKeyword("Trample");
        boolean deathtouch = attacker.hasKeyword("Deathtouch");
        int parties = bl.size() + (trample ? 1 : 0);
        int[] lethal = new int[bl.size()];
        for (int i = 0; i < bl.size(); i++) {
            int l = Math.max(0, bl.get(i).getLethalDamage());
            lethal[i] = deathtouch ? Math.min(1, l) : l;
        }
        List<int[]> all = compositions(damageDealt, parties, 0, 5000);
        List<int[]> legal = new ArrayList<>();
        if (all != null) {
            for (int[] s : all) {
                if (trample && s[parties - 1] > 0) {
                    boolean ok = true;
                    for (int i = 0; i < bl.size(); i++) if (s[i] < lethal[i]) { ok = false; break; }
                    if (!ok) continue;
                }
                legal.add(s);
            }
        }
        if (legal.isEmpty() || legal.size() > MAX_ENUMERATED_OPTIONS) {
            delegated("assign_damage", legal.isEmpty() ? "no legal split found" : "too many possible splits (" + legal.size() + ")");
            return asAi(() -> super.assignCombatDamage(attacker, blockers, remaining, damageDealt, defender, overrideOrder));
        }
        int pick = 0;
        if (legal.size() > 1) {
            List<String> labels = new ArrayList<>();
            for (int[] s : legal) {
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < bl.size(); i++) sb.append(i > 0 ? ", " : "").append(s[i]).append(" to ").append(cardLabel(bl.get(i))).append(" (lethal ").append(lethal[i]).append(")");
                if (trample) sb.append(", ").append(s[parties - 1]).append(" to the defending player/planeswalker");
                labels.add(sb.toString());
            }
            pick = askIndex("assign_damage", "Assign " + damageDealt + " combat damage from " + cardLabel(attacker) + ".", labels, null);
            if (pick < 0) {
                delegated("assign_damage", "no valid answer");
                return asAi(() -> super.assignCombatDamage(attacker, blockers, remaining, damageDealt, defender, overrideOrder));
            }
        }
        int[] s = legal.get(pick);
        Map<Card, Integer> out = new HashMap<>();
        for (int i = 0; i < bl.size(); i++) if (s[i] > 0) out.put(bl.get(i), s[i]);
        if (trample && s[parties - 1] > 0) out.put(null, s[parties - 1]);
        return out;
    }

    // ====================================================================== library manipulation

    @Override
    public ImmutablePair<CardCollection, CardCollection> arrangeForScry(CardCollection topN) {
        if (ai() || topN.isEmpty()) return super.arrangeForScry(topN);
        CardCollection bottom = askCards("scry", "Scry " + topN.size() + ": choose the cards to put on the BOTTOM of your library (the rest stay on top).", topN, 0, topN.size());
        if (bottom == null) { delegated("scry", "no valid answer"); return asAi(() -> super.arrangeForScry(topN)); }
        CardCollection top = new CardCollection();
        for (Card c : topN) if (!bottom.contains(c)) top.add(c);
        return ImmutablePair.of(orderTop(top, "scry_order"), bottom);
    }

    @Override
    public ImmutablePair<CardCollection, CardCollection> arrangeForSurveil(CardCollection topN) {
        if (ai() || topN.isEmpty()) return super.arrangeForSurveil(topN);
        CardCollection grave = askCards("surveil", "Surveil " + topN.size() + ": choose the cards to put into your GRAVEYARD (the rest stay on top).", topN, 0, topN.size());
        if (grave == null) { delegated("surveil", "no valid answer"); return asAi(() -> super.arrangeForSurveil(topN)); }
        CardCollection top = new CardCollection();
        for (Card c : topN) if (!grave.contains(c)) top.add(c);
        return ImmutablePair.of(orderTop(top, "surveil_order"), grave);
    }

    /** Agent orders cards staying on top; element 0 = topmost. */
    private CardCollection orderTop(CardCollection top, String kind) {
        if (top.size() <= 1) return top;
        List<String> labels = new ArrayList<>();
        for (Card c : top) labels.add(c.getName());
        List<Integer> order = askOrder(kind, "Order the cards you keep on top of your library: choose the card to be on TOP.", labels, labels);
        if (order == null) { delegated(kind, "no valid answer"); return top; }
        CardCollection out = new CardCollection();
        for (int i : order) out.add(top.get(i));
        return out;
    }

    @Override
    public CardCollectionView orderMoveToZoneList(CardCollectionView cards, ZoneType destinationZone, SpellAbility source) {
        if (ai() || cards.size() <= 1 || destinationZone != ZoneType.Library) return super.orderMoveToZoneList(cards, destinationZone, source);
        boolean toTop = orderedMoveToTopOfLibrary(destinationZone, source);
        List<Card> list = new ArrayList<>(cards);
        List<String> labels = new ArrayList<>();
        for (Card c : list) labels.add(c.getName());
        List<Integer> order = askOrder("order_library", "Order the cards being put into your library: choose the card that will be "
                + (toTop ? "CLOSEST TO THE TOP." : "CLOSEST TO THE BOTTOM."), labels, labels);
        if (order == null) { delegated("order_library", "no valid answer"); return asAi(() -> super.orderMoveToZoneList(cards, destinationZone, source)); }
        CardCollection out = new CardCollection();
        for (int i : order) out.add(list.get(i));
        return out;
    }

    // ====================================================================== generic choices from effects

    @Override
    public <T extends GameEntity> T chooseSingleEntityForEffect(FCollectionView<T> optionList, DelayedReveal delayedReveal, SpellAbility sa,
            String title, boolean isOptional, Player targetedPlayer, Map<String, Object> params) {
        if (ai() || optionList.isEmpty()) return super.chooseSingleEntityForEffect(optionList, delayedReveal, sa, title, isOptional, targetedPlayer, params);
        List<T> r = entities(optionList, isOptional ? 0 : 1, 1, src(sa) + (title == null ? "Choose one." : title));
        if (r == null) {
            delegated("choose_entity", "no valid answer");
            return asAi(() -> super.chooseSingleEntityForEffect(optionList, delayedReveal, sa, title, isOptional, targetedPlayer, params));
        }
        return r.isEmpty() ? null : r.get(0);
    }

    @Override
    public <T extends GameEntity> List<T> chooseEntitiesForEffect(FCollectionView<T> optionList, int min, int max, DelayedReveal delayedReveal,
            SpellAbility sa, String title, Player targetedPlayer, Map<String, Object> params) {
        if (ai() || optionList.isEmpty()) return super.chooseEntitiesForEffect(optionList, min, max, delayedReveal, sa, title, targetedPlayer, params);
        List<T> r = entities(optionList, Math.min(min, optionList.size()), max, src(sa) + (title == null ? "Choose." : title));
        if (r == null) {
            delegated("choose_entities", "no valid answer");
            return asAi(() -> super.chooseEntitiesForEffect(optionList, min, max, delayedReveal, sa, title, targetedPlayer, params));
        }
        return r;
    }

    private <T extends GameEntity> List<T> entities(FCollectionView<T> optionList, int min, int max, String prompt) {
        List<Opt> opts = new ArrayList<>();
        Map<String, T> byId = new HashMap<>();
        for (T e : optionList) {
            String id; String label; String name = null;
            if (e instanceof Player p) { id = p.equals(player) ? "you" : "opponent"; label = p.equals(player) ? "You" : "Opponent"; }
            else { Card c = (Card) e; id = StateView.id(c); label = cardLabel(c) + " (" + owner(c) + ")"; name = c.getName(); }
            byId.put(id, e);
            opts.add(new Opt(id, label, name));
        }
        List<String> r = ask("choose_entity", prompt, opts, min, max);
        if (r == null) return null;
        List<T> out = new ArrayList<>();
        for (String id : r) out.add(byId.get(id));
        return out;
    }

    @Override
    public CardCollectionView chooseCardsForEffect(CardCollectionView sourceList, SpellAbility sa, String title, int min, int max,
            boolean isOptional, Map<String, Object> params) {
        if (ai() || sourceList.isEmpty()) return super.chooseCardsForEffect(sourceList, sa, title, min, max, isOptional, params);
        CardCollection r = askCards("choose_cards", src(sa) + (title == null ? "Choose cards." : title), sourceList,
                isOptional ? 0 : Math.min(min, sourceList.size()), Math.min(max, sourceList.size()));
        if (r == null) { delegated("choose_cards", "no valid answer"); return asAi(() -> super.chooseCardsForEffect(sourceList, sa, title, min, max, isOptional, params)); }
        return r;
    }

    @Override
    public CardCollectionView choosePermanentsToSacrifice(SpellAbility sa, int min, int max, CardCollectionView validTargets, String message) {
        if (ai() || validTargets.isEmpty()) return super.choosePermanentsToSacrifice(sa, min, max, validTargets, message);
        CardCollection r = askCards("choose_cards", src(sa) + "Choose " + (min == max ? String.valueOf(min) : min + "-" + max) + " permanent(s) to SACRIFICE.",
                validTargets, Math.min(min, validTargets.size()), Math.min(max, validTargets.size()));
        if (r == null) { delegated("sacrifice", "no valid answer"); return asAi(() -> super.choosePermanentsToSacrifice(sa, min, max, validTargets, message)); }
        return r;
    }

    @Override
    public CardCollectionView choosePermanentsToDestroy(SpellAbility sa, int min, int max, CardCollectionView validTargets, String message) {
        if (ai() || validTargets.isEmpty()) return super.choosePermanentsToDestroy(sa, min, max, validTargets, message);
        CardCollection r = askCards("choose_cards", src(sa) + "Choose " + (min == max ? String.valueOf(min) : min + "-" + max) + " permanent(s) to DESTROY.",
                validTargets, Math.min(min, validTargets.size()), Math.min(max, validTargets.size()));
        if (r == null) { delegated("destroy", "no valid answer"); return asAi(() -> super.choosePermanentsToDestroy(sa, min, max, validTargets, message)); }
        return r;
    }

    @Override
    public Card chooseSingleCardForZoneChange(ZoneType destination, List<ZoneType> origin, SpellAbility sa, CardCollection fetchList,
            DelayedReveal delayedReveal, String selectPrompt, boolean isOptional, Player decider) {
        if (ai() || fetchList.isEmpty()) return super.chooseSingleCardForZoneChange(destination, origin, sa, fetchList, delayedReveal, selectPrompt, isOptional, decider);
        CardCollection r = askCards("search", src(sa) + (selectPrompt == null ? "Choose a card" : selectPrompt) + " (from " + origin + " to " + destination + ").",
                fetchList, isOptional ? 0 : 1, 1);
        if (r == null) {
            delegated("search", "no valid answer");
            return asAi(() -> super.chooseSingleCardForZoneChange(destination, origin, sa, fetchList, delayedReveal, selectPrompt, isOptional, decider));
        }
        return r.isEmpty() ? null : r.get(0);
    }

    @Override
    public List<Card> chooseCardsForZoneChange(ZoneType destination, List<ZoneType> origin, SpellAbility sa, CardCollection fetchList, int min, int max,
            DelayedReveal delayedReveal, String selectPrompt, Player decider) {
        if (ai() || fetchList.isEmpty()) return super.chooseCardsForZoneChange(destination, origin, sa, fetchList, min, max, delayedReveal, selectPrompt, decider);
        CardCollection r = askCards("search", src(sa) + (selectPrompt == null ? "Choose cards" : selectPrompt) + " (from " + origin + " to " + destination + ").",
                fetchList, Math.min(min, fetchList.size()), Math.min(max, fetchList.size()));
        if (r == null) {
            delegated("search", "no valid answer");
            return asAi(() -> super.chooseCardsForZoneChange(destination, origin, sa, fetchList, min, max, delayedReveal, selectPrompt, decider));
        }
        return new ArrayList<>(r);
    }

    @Override
    public SpellAbility chooseSingleSpellForEffect(List<SpellAbility> spells, SpellAbility sa, String title, Map<String, Object> params) {
        if (ai() || spells.size() <= 1) return super.chooseSingleSpellForEffect(spells, sa, title, params);
        List<String> labels = new ArrayList<>();
        for (SpellAbility s : spells) labels.add(describe(s));
        int i = askIndex("choose_option", src(sa) + (title == null ? "Choose one." : title), labels, null);
        if (i < 0) { delegated("choose_spell", "no valid answer"); return asAi(() -> super.chooseSingleSpellForEffect(spells, sa, title, params)); }
        return spells.get(i);
    }

    @Override
    public boolean confirmAction(SpellAbility sa, PlayerActionConfirmMode mode, String message, List<String> options, Card cardToShow,
            Map<String, Object> params) {
        if (ai()) return super.confirmAction(sa, mode, message, options, cardToShow, params);
        String yes = options != null && options.size() == 2 ? options.get(0) : "Yes";
        String no = options != null && options.size() == 2 ? options.get(1) : "No";
        Boolean r = askYesNo("confirm", src(sa) + (message == null ? "Confirm?" : message), yes, no);
        if (r == null) { delegated("confirm", "no valid answer"); return asAi(() -> super.confirmAction(sa, mode, message, options, cardToShow, params)); }
        return r;
    }

    @Override
    public boolean confirmReplacementEffect(ReplacementEffect replacementEffect, SpellAbility effectSA, GameEntity affected, String question) {
        if (ai()) return super.confirmReplacementEffect(replacementEffect, effectSA, affected, question);
        Boolean r = askYesNo("confirm", question == null ? "Apply " + replacementEffect.getDescription() + "?" : question, "Yes", "No");
        if (r == null) { delegated("confirm_replacement", "no valid answer"); return asAi(() -> super.confirmReplacementEffect(replacementEffect, effectSA, affected, question)); }
        return r;
    }

    @Override
    public ReplacementEffect chooseSingleReplacementEffect(List<ReplacementEffect> possibleReplacers) {
        if (ai() || possibleReplacers.size() <= 1) return super.chooseSingleReplacementEffect(possibleReplacers);
        List<String> labels = new ArrayList<>();
        for (ReplacementEffect re : possibleReplacers) labels.add(truncate(re.getDescription(), 200));
        int i = askIndex("choose_option", "Several replacement effects apply. Choose which one applies first.", labels, null);
        if (i < 0) { delegated("choose_replacement", "no valid answer"); return asAi(() -> super.chooseSingleReplacementEffect(possibleReplacers)); }
        return possibleReplacers.get(i);
    }

    @Override
    public int chooseNumber(SpellAbility sa, String title, int min, int max) {
        if (ai()) return super.chooseNumber(sa, title, min, max);
        if (max - min > 40) { delegated("choose_number", "range too large (" + min + "-" + max + ")"); return asAi(() -> super.chooseNumber(sa, title, min, max)); }
        List<Integer> values = new ArrayList<>();
        for (int v = min; v <= max; v++) values.add(v);
        Integer r = askNumber(sa, title, values);
        if (r == null) { delegated("choose_number", "no valid answer"); return asAi(() -> super.chooseNumber(sa, title, min, max)); }
        return r;
    }

    @Override
    public int chooseNumber(SpellAbility sa, String title, List<Integer> values, Player relatedPlayer) {
        if (ai() || values.size() <= 1) return super.chooseNumber(sa, title, values, relatedPlayer);
        if (values.size() > 41) { delegated("choose_number", values.size() + " values"); return asAi(() -> super.chooseNumber(sa, title, values, relatedPlayer)); }
        Integer r = askNumber(sa, title, values);
        if (r == null) { delegated("choose_number", "no valid answer"); return asAi(() -> super.chooseNumber(sa, title, values, relatedPlayer)); }
        return r;
    }

    private Integer askNumber(SpellAbility sa, String title, List<Integer> values) {
        List<Opt> opts = new ArrayList<>();
        for (Integer v : values) opts.add(new Opt("n" + v, String.valueOf(v), null));
        List<String> r = ask("choose_number", src(sa) + (title == null ? "Choose a number." : title), opts, 1, 1);
        return r == null ? null : Integer.valueOf(r.get(0).substring(1));
    }

    @Override
    public boolean chooseBinary(SpellAbility sa, String question, BinaryChoiceType kindOfChoice, Boolean defaultVal) {
        if (ai()) return super.chooseBinary(sa, question, kindOfChoice, defaultVal);
        String[] parts = kindOfChoice.name().split("Or", 2); // e.g. TapOrUntap -> "Tap" / "Untap"; true = first
        String yes = parts.length == 2 ? parts[0] : "Yes";
        String no = parts.length == 2 ? parts[1] : "No";
        Boolean r = askYesNo("choose_option", src(sa) + (question == null ? "Choose." : question), yes, no);
        if (r == null) { delegated("choose_binary", "no valid answer"); return asAi(() -> super.chooseBinary(sa, question, kindOfChoice, defaultVal)); }
        return r;
    }

    @Override
    public byte chooseColor(String message, SpellAbility sa, ColorSet colors) {
        if (ai() || colors.countColors() < 2) return super.chooseColor(message, sa, colors);
        List<MagicColor.Color> list = new ArrayList<>();
        for (MagicColor.Color c : colors) list.add(c);
        List<String> labels = new ArrayList<>();
        for (MagicColor.Color c : list) labels.add(c.getName());
        int i = askIndex("choose_color", src(sa) + (message == null || message.isEmpty() ? "Choose a color." : message), labels, null);
        if (i < 0) { delegated("choose_color", "no valid answer"); return asAi(() -> super.chooseColor(message, sa, colors)); }
        return list.get(i).getColorMask();
    }

    @Override
    public ColorSet chooseColors(String message, SpellAbility sa, int min, int max, ColorSet options) {
        if (ai()) return super.chooseColors(message, sa, min, max, options);
        List<Opt> opts = new ArrayList<>();
        for (MagicColor.Color c : options) opts.add(new Opt(c.getName(), c.getName(), null));
        List<String> r = ask("choose_color", src(sa) + (message == null || message.isEmpty() ? "Choose colors." : message), opts, min, max);
        if (r == null) { delegated("choose_colors", "no valid answer"); return asAi(() -> super.chooseColors(message, sa, min, max, options)); }
        return ColorSet.fromNames(r);
    }

    @Override
    public String chooseSomeType(String kindOfType, SpellAbility sa, Collection<String> validTypes, boolean isOptional) {
        if (ai() || validTypes.size() <= 1) return super.chooseSomeType(kindOfType, sa, validTypes, isOptional);
        if (validTypes.size() > MAX_ENUMERATED_OPTIONS) {
            delegated("choose_type", validTypes.size() + " " + kindOfType + " types to choose from");
            return asAi(() -> super.chooseSomeType(kindOfType, sa, validTypes, isOptional));
        }
        List<String> types = new ArrayList<>(validTypes);
        int i = askIndex("choose_option", src(sa) + "Choose a " + kindOfType + " type.", types, null);
        if (i < 0) { delegated("choose_type", "no valid answer"); return asAi(() -> super.chooseSomeType(kindOfType, sa, validTypes, isOptional)); }
        return types.get(i);
    }

    @Override
    public boolean chooseCardsPile(SpellAbility sa, CardCollectionView pile1, CardCollectionView pile2, String faceUp) {
        if (ai()) return super.chooseCardsPile(sa, pile1, pile2, faceUp);
        boolean show1 = "True".equals(faceUp) || "One".equals(faceUp);
        boolean show2 = "True".equals(faceUp);
        String l1 = "Pile 1 (" + pile1.size() + " cards" + (show1 ? ": " + names(pile1) : ", face down") + ")";
        String l2 = "Pile 2 (" + pile2.size() + " cards" + (show2 ? ": " + names(pile2) : ", face down") + ")";
        Boolean r = askYesNo("choose_option", src(sa) + "Choose a pile.", l1, l2);
        if (r == null) { delegated("choose_pile", "no valid answer"); return asAi(() -> super.chooseCardsPile(sa, pile1, pile2, faceUp)); }
        return r;
    }

    private static String names(CardCollectionView cs) {
        List<String> n = new ArrayList<>();
        for (Card c : cs) n.add(c.getName());
        return String.join(", ", n);
    }

    @Override
    public CounterType chooseCounterType(List<CounterType> options, SpellAbility sa, String prompt, Map<String, Object> params) {
        if (ai() || options.size() <= 1) return super.chooseCounterType(options, sa, prompt, params);
        List<String> labels = new ArrayList<>();
        for (CounterType t : options) labels.add(String.valueOf(t));
        int i = askIndex("choose_option", src(sa) + (prompt == null ? "Choose a counter type." : prompt), labels, null);
        if (i < 0) { delegated("choose_counter", "no valid answer"); return asAi(() -> super.chooseCounterType(options, sa, prompt, params)); }
        return options.get(i);
    }

    @Override
    public String chooseKeywordForPump(List<String> options, SpellAbility sa, String prompt, Card tgtCard) {
        if (ai() || options.size() <= 1) return super.chooseKeywordForPump(options, sa, prompt, tgtCard);
        int i = askIndex("choose_option", src(sa) + (prompt == null ? "Choose a keyword." : prompt), options, null);
        if (i < 0) { delegated("choose_keyword", "no valid answer"); return asAi(() -> super.chooseKeywordForPump(options, sa, prompt, tgtCard)); }
        return options.get(i);
    }

    @Override
    public String chooseProtectionType(SpellAbility sa, List<String> choices) {
        if (ai() || choices.size() <= 1) return super.chooseProtectionType(sa, choices);
        int i = askIndex("choose_option", src(sa) + "Choose what to gain protection from.", choices, null);
        if (i < 0) { delegated("choose_protection", "no valid answer"); return asAi(() -> super.chooseProtectionType(sa, choices)); }
        return choices.get(i);
    }

    @Override
    public CardCollectionView chooseCardsToDelve(int genericAmount, CardCollection grave) {
        if (ai() || grave.isEmpty() || genericAmount <= 0) return super.chooseCardsToDelve(genericAmount, grave);
        CardCollection r = askCards("cost_choice", "Delve: choose up to " + genericAmount + " card(s) to exile from your graveyard; each pays {1}.",
                grave, 0, Math.min(genericAmount, grave.size()));
        if (r == null) { delegated("delve", "no valid answer"); return asAi(() -> super.chooseCardsToDelve(genericAmount, grave)); }
        return r;
    }

    @Override
    public CardCollectionView chooseCardsToDiscardToMaximumHandSize(int numDiscard) {
        CardCollectionView hand = player.getCardsIn(ZoneType.Hand);
        CardCollection r = askCards("discard", "Discard " + numDiscard + " card(s) down to your maximum hand size.", hand, numDiscard, numDiscard);
        if (r == null) { delegated("discard", "no valid answer"); return asAi(() -> super.chooseCardsToDiscardToMaximumHandSize(numDiscard)); }
        return r;
    }

    @Override
    public CardCollection chooseCardsToDiscardFrom(Player p, SpellAbility sa, CardCollection validCards, int min, int max,
            CardCollectionView visibleToChooser) {
        if (ai() || validCards.isEmpty()) return super.chooseCardsToDiscardFrom(p, sa, validCards, min, max, visibleToChooser);
        String who = p.equals(player) ? "your" : "your opponent's";
        CardCollection r = askCards("discard", "Choose " + (min == max ? String.valueOf(min) : min + "-" + max) + " card(s) from " + who + " hand to discard.",
                validCards, Math.min(min, validCards.size()), Math.min(max, validCards.size()));
        if (r == null) { delegated("discard", "no valid answer"); return asAi(() -> super.chooseCardsToDiscardFrom(p, sa, validCards, min, max, visibleToChooser)); }
        return r;
    }

    // ====================================================================== still Forge AI (rare in cube) — counted as delegated

    @Override
    public String chooseCardName(SpellAbility sa, Predicate<ICardFace> cpp, String valid, String message) {
        if (!ai()) delegated("name_a_card", "naming an arbitrary card is not offered to agents yet");
        return asAi(() -> super.chooseCardName(sa, cpp, valid, message));
    }

    @Override
    public String chooseCardName(SpellAbility sa, List<ICardFace> faces, String message) {
        if (!ai()) delegated("name_a_card", "naming an arbitrary card is not offered to agents yet");
        return asAi(() -> super.chooseCardName(sa, faces, message));
    }

    @Override
    public Map<Card, ManaCostShard> chooseCardsForConvokeOrImprovise(SpellAbility sa, ManaCost manaCost, CardCollectionView untappedCards,
            boolean artifacts, boolean creatures, Integer maxReduction) {
        if (!ai()) delegated("convoke_improvise", "not offered to agents yet");
        return asAi(() -> super.chooseCardsForConvokeOrImprovise(sa, manaCost, untappedCards, artifacts, creatures, maxReduction));
    }

    @Override
    public List<SpellAbility> chooseSpellAbilitiesForEffect(List<SpellAbility> spells, SpellAbility sa, String title, int num, Map<String, Object> params) {
        if (!ai()) delegated("choose_spells", "multi-spell choice not offered to agents yet");
        return asAi(() -> super.chooseSpellAbilitiesForEffect(spells, sa, title, num, params));
    }

    @Override
    public Map<Byte, Integer> specifyManaCombo(SpellAbility sa, ColorSet colorSet, int manaAmount, boolean different) {
        if (!ai()) delegated("mana_combo", "not offered to agents yet");
        return asAi(() -> super.specifyManaCombo(sa, colorSet, manaAmount, different));
    }

    @Override
    public CardCollection chooseCardsForEffectMultiple(Map<String, CardCollection> validMap, SpellAbility sa, String title, boolean isOptional) {
        if (!ai()) delegated("choose_cards_multiple", "not offered to agents yet");
        return asAi(() -> super.chooseCardsForEffectMultiple(validMap, sa, title, isOptional));
    }

    /** Legacy combat-ordering rules only (off by default in Forge). */
    @Override
    public CardCollection orderBlockers(Card attacker, CardCollection blockers) {
        if (!ai()) delegated("order_blockers", "legacy damage-assignment order rules");
        return asAi(() -> super.orderBlockers(attacker, blockers));
    }

    /** One option in a decision request. */
    static final class Opt {
        final String id; final String label; final String card; final JsonObject meta;
        Opt(String id, String label, String card) { this(id, label, card, null); }
        Opt(String id, String label, String card, JsonObject meta) { this.id = id; this.label = label; this.card = card; this.meta = meta; }
        JsonObject toJson() {
            JsonObject jo = new JsonObject();
            jo.addProperty("id", id);
            jo.addProperty("label", label);
            if (card != null) jo.addProperty("card", card);
            if (meta != null) jo.add("meta", meta);
            return jo;
        }
    }
}
