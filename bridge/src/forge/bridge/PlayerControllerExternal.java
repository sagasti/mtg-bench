package forge.bridge;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import forge.LobbyPlayer;
import forge.ai.ComputerUtil;
import forge.ai.ComputerUtilAbility;
import forge.ai.ComputerUtilCard;
import forge.ai.ComputerUtilCost;
import forge.ai.PlayerControllerAi;
import forge.game.Game;
import forge.game.GameEndReason;
import forge.game.GameEntity;
import forge.game.ability.ApiType;
import forge.game.card.Card;
import forge.game.card.CardCollection;
import forge.game.card.CardCollectionView;
import forge.game.combat.Combat;
import forge.game.combat.CombatUtil;
import forge.game.phase.PhaseHandler;
import forge.game.phase.PhaseType;
import forge.game.player.DelayedReveal;
import forge.game.player.Player;
import forge.game.player.PlayerActionConfirmMode;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.TargetChoices;
import forge.game.spellability.TargetRestrictions;
import forge.game.zone.ZoneType;
import forge.util.collect.FCollectionView;

/**
 * A Forge player whose major decisions are made by an external agent.
 *
 * Extends the Forge AI controller so that every decision NOT overridden here
 * (mana payment, X values, cost choices, trigger ordering, scry, damage
 * assignment order, modes of charms, ...) falls back to Forge's AI. The
 * decisions routed to the agent are:
 *   mulligan, london_bottom, priority (play land / cast / activate / pass), targets
 *   (for the agent's own spells and triggers), attackers, blockers, discard,
 *   choose_entity, choose_cards, confirm.
 * If the agent's answer is missing or illegal, the AI's choice is used and the
 * harness records a fallback.
 */
public class PlayerControllerExternal extends PlayerControllerAi {
    private final BridgeClient client;
    private final MatchContext ctx;
    private final int seat;
    /** The spell ability the agent chose at the last priority, so playChosenSpellAbility can let the agent target it. */
    private SpellAbility agentChosen;
    /** True while Forge's AI is planning on our behalf; generic choices then go to the AI, not the agent. */
    private int aiPlanning = 0;

    public PlayerControllerExternal(Game game, Player p, LobbyPlayer lp, BridgeClient client, MatchContext ctx, int seat) {
        super(game, p, lp);
        this.client = client;
        this.ctx = ctx;
        this.seat = seat;
    }

    // ------------------------------------------------------------------ helpers

    private static final class Opt {
        final String id; final String label; final String card; final JsonObject meta;
        Opt(String id, String label, String card) { this(id, label, card, null); }
        Opt(String id, String label, String card, JsonObject meta) { this.id = id; this.label = label; this.card = card; this.meta = meta; }
    }

    /** Ask the agent; returns chosen ids, or null if no valid answer (caller must fall back to the AI). */
    private List<String> ask(String kind, String prompt, List<Opt> options, int min, int max, JsonObject extraState) {
        return ask(kind, prompt, options, min, max, extraState, null);
    }

    /** hints: pre-computed values for the harness's built-in bots; never shown to LLM agents. */
    private List<String> ask(String kind, String prompt, List<Opt> options, int min, int max, JsonObject extraState, JsonObject hints) {
        if (options.isEmpty() && min > 0) return null;
        JsonObject req = new JsonObject();
        req.addProperty("seat", seat);
        req.addProperty("game", ctx.game);
        req.addProperty("kind", kind);
        req.addProperty("prompt", prompt);
        JsonObject state = StateView.build(getGame(), player, ctx.game);
        if (extraState != null) for (Map.Entry<String, JsonElement> e : extraState.entrySet()) state.add(e.getKey(), e.getValue());
        req.add("state", state);
        if (hints != null) req.add("hints", hints);
        JsonArray opts = new JsonArray();
        for (Opt o : options) {
            JsonObject jo = new JsonObject();
            jo.addProperty("id", o.id);
            jo.addProperty("label", o.label);
            if (o.card != null) jo.addProperty("card", o.card);
            if (o.meta != null) jo.add("meta", o.meta);
            opts.add(jo);
        }
        req.add("options", opts);
        req.addProperty("min", min);
        req.addProperty("max", Math.min(max, options.size()));
        JsonObject ans = client.request(req);
        if (ans == null || !ans.has("choice")) return null;
        Set<String> valid = new HashSet<>();
        for (Opt o : options) valid.add(o.id);
        List<String> out = new ArrayList<>();
        for (JsonElement e : ans.getAsJsonArray("choice")) {
            String id = e.getAsString();
            if (!valid.contains(id) || out.contains(id)) return null;
            out.add(id);
        }
        if (out.size() < min || out.size() > max) return null;
        return out;
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

    private static String truncate(String s, int n) {
        if (s == null) return "";
        s = s.replace('\n', ' ');
        return s.length() <= n ? s : s.substring(0, n - 1) + "…";
    }

    private List<Opt> cardOptions(Iterable<Card> cards) {
        List<Opt> out = new ArrayList<>();
        for (Card c : cards) out.add(new Opt(StateView.id(c), cardLabel(c) + " [" + c.getZone().getZoneType() + ", " + owner(c) + "]", c.getName()));
        return out;
    }

    private static Card byId(Iterable<Card> cards, String id) {
        for (Card c : cards) if (StateView.id(c).equals(id)) return c;
        return null;
    }

    private boolean turnCapReached() {
        if (getGame().getPhaseHandler().getTurn() > ctx.maxTurns && !getGame().isGameOver()) {
            client.log("turn cap reached; declaring draw");
            getGame().setGameOver(GameEndReason.Draw);
            return true;
        }
        return getGame().isGameOver();
    }

    // ------------------------------------------------------------------ mulligan

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
        if (r == null) return super.mulliganKeepHand(firstPlayer, cardsToReturn);
        return r.get(0).equals("keep");
    }

    @Override
    public CardCollectionView tuckCardsViaMulligan(CardCollectionView hand, int cardsToReturn) {
        List<String> r = ask("london_bottom", "Choose " + cardsToReturn + " card(s) to put on the bottom of your library.",
                cardOptions(hand), cardsToReturn, cardsToReturn, null);
        if (r == null) return super.tuckCardsViaMulligan(hand, cardsToReturn);
        CardCollection out = new CardCollection();
        for (String id : r) out.add(byId(hand, id));
        return out;
    }

    // ------------------------------------------------------------------ priority

    private boolean shouldStop() {
        if (!ctx.smartStops) return true;
        Game g = getGame();
        PhaseHandler ph = g.getPhaseHandler();
        PhaseType phase = ph.getPhase();
        boolean myTurn = ph.isPlayerTurn(player);
        if (!g.getStack().isEmpty()) {
            // don't interrupt ourselves: respond only to the opponent's spells/abilities
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
        if (!shouldStop()) return null;
        Game g = getGame();

        CardCollection cards = ComputerUtilCard.dedupeCards(ComputerUtilAbility.getAvailableCards(g, player));
        List<SpellAbility> all = ComputerUtilAbility.getOriginalAndAltCostAbilities(ComputerUtilAbility.getSpellAbilities(cards, player), player);
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
                    if (!ComputerUtilCost.canPayCost(sa, player, false)) continue;
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
        if (opts.size() == 1) return null; // only "pass": don't spend a model call

        String prompt = g.getStack().isEmpty()
                ? "You have priority. Play a land, cast a spell, activate an ability, or pass."
                : "You have priority with objects on the stack. Respond, or pass to let the top object resolve.";
        List<String> r = ask("priority", prompt, opts, 1, 1, null);
        if (r == null) return super.chooseSpellAbilityToPlay();
        if (r.get(0).equals("pass")) return null;
        SpellAbility chosen = byId.get(r.get(0));
        agentChosen = chosen;
        return Collections.singletonList(chosen);
    }

    @Override
    public boolean playChosenSpellAbility(SpellAbility sa) {
        if (sa != agentChosen || sa.isLandAbility()) return super.playChosenSpellAbility(sa);
        agentChosen = null;
        // Let the AI fill in the parts the agent isn't asked about (X, default targets, modes), then let the agent choose targets.
        aiPlanning++;
        try { getAi().canPlaySa(sa); } catch (RuntimeException e) { /* AI planning is best-effort */ }
        finally { aiPlanning--; }
        ComputerUtil.handlePlayingSpellAbility(player, sa, this::agentTargets);
        return true;
    }

    /** Ask the agent for targets for each targeted part of an ability chain; keeps the AI's targets where unsupported. */
    private void agentTargets(SpellAbility root) {
        for (SpellAbility cur = root; cur != null; cur = cur.getSubAbility()) {
            if (!cur.usesTargeting()) continue;
            TargetRestrictions tr = cur.getTargetRestrictions();
            if (tr == null || cur.isDividedAsYouChoose() || tr.getZone().contains(ZoneType.Stack)) continue; // v1: AI handles these
            List<GameEntity> cands = tr.getAllCandidates(cur, false);
            if (cands.isEmpty()) continue;
            Card host = cur.getHostCard();
            int min = tr.getMinTargets(host, cur);
            int max = Math.min(tr.getMaxTargets(host, cur), cands.size());
            if (max <= 0) continue;
            List<Opt> opts = new ArrayList<>();
            Map<String, GameEntity> byId = new HashMap<>();
            for (GameEntity e : cands) {
                String id; String label; String cardName = null; JsonObject meta = new JsonObject();
                if (e instanceof Player p) {
                    id = p.equals(player) ? "you" : "opponent";
                    label = p.equals(player) ? "You (yourself)" : "Opponent";
                    meta.addProperty("hostile", !p.equals(player));
                } else {
                    Card c = (Card) e;
                    id = StateView.id(c);
                    label = cardLabel(c) + " (" + owner(c) + ")";
                    cardName = c.getName();
                    meta.addProperty("hostile", !c.getController().equals(player));
                }
                byId.put(id, e);
                opts.add(new Opt(id, label, cardName, meta));
            }
            JsonObject extra = new JsonObject();
            extra.addProperty("casting", host != null ? host.getName() : "?");
            extra.addProperty("abilityText", truncate(cur.getDescription(), 300));
            List<String> r = ask("targets", "Choose target(s) for " + (host != null ? host.getName() : "this ability") + ": "
                    + truncate(cur.getDescription(), 200), opts, Math.min(min, max), max, extra);
            if (r == null) continue; // keep AI's targets
            TargetChoices previous = cur.getTargets().clone();
            cur.clearTargets();
            for (String id : r) cur.getTargets().add(byId.get(id));
            if (!cur.isTargetNumberValid()) {
                client.error("agent targets invalid for " + (host != null ? host.getName() : "?") + "; reverting to AI targets");
                cur.setTargets(previous);
            }
        }
    }

    /** Own triggered abilities: AI orders them and handles modes; the agent picks targets. */
    @Override
    public void orderAndPlaySimultaneousSa(List<SpellAbility> activePlayerSAs) {
        for (SpellAbility sa : orderSimultaneousSa(activePlayerSAs)) {
            boolean targeted = false;
            for (SpellAbility s = sa; s != null; s = s.getSubAbility()) targeted |= s.usesTargeting();
            if (sa.isTrigger() && !sa.isCopied() && targeted && sa.getApi() != ApiType.Charm && !sa.hasParam("TargetingPlayer")) {
                boolean ok;
                aiPlanning++;
                try { ok = getAi().doTrigger(sa, true); } finally { aiPlanning--; }
                if (ok) {
                    agentTargets(sa);
                    ComputerUtil.playStack(sa, player, getGame());
                }
            } else {
                super.orderAndPlaySimultaneousSa(Collections.singletonList(sa));
            }
        }
    }

    // ------------------------------------------------------------------ combat

    @Override
    public void declareAttackers(Player attacker, Combat combat) {
        if (turnCapReached()) return;
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
        List<String> r = ask("attackers", "Declare attackers. Choose any number (none = no attack). Each creature may attack only one defender.",
                opts, 0, opts.size(), null, hints);
        if (r != null) {
            Set<Card> used = new HashSet<>();
            boolean ok = true;
            for (String id : r) {
                Card c = atkById.get(id);
                if (!used.add(c)) { ok = false; break; }
                combat.addAttacker(c, defById.get(id));
            }
            if (ok && CombatUtil.validateAttackers(combat)) return;
            client.error("agent attack declaration invalid; using AI attackers");
            for (Card c : new ArrayList<>(combat.getAttackers())) combat.removeFromCombat(c);
        }
        super.declareAttackers(attacker, combat);
    }

    @Override
    public void declareBlockers(Player defender, Combat combat) {
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
        List<String> r = ask("blockers", "Declare blockers. Each of your creatures can block one attacker; several can block the same attacker. Choose none to take the damage.",
                opts, 0, defender.getCreaturesInPlay().size(), null, hints);
        if (r != null) {
            Set<Card> used = new HashSet<>();
            List<Card> added = new ArrayList<>();
            boolean ok = true;
            for (String id : r) {
                Card[] p = pairs.get(id);
                if (!used.add(p[0])) { ok = false; break; }
                combat.addBlocker(p[1], p[0]);
                added.add(p[0]);
            }
            if (ok && CombatUtil.validateBlocks(combat, defender) == null) return;
            client.error("agent block declaration invalid; using AI blocks");
            for (Card b : added) combat.removeFromCombat(b);
        }
        super.declareBlockers(defender, combat);
    }

    // ------------------------------------------------------------------ generic choices

    @Override
    public <T extends GameEntity> T chooseSingleEntityForEffect(FCollectionView<T> optionList, DelayedReveal delayedReveal, SpellAbility sa,
            String title, boolean isOptional, Player targetedPlayer, Map<String, Object> params) {
        if (aiPlanning > 0 || optionList.isEmpty()) return super.chooseSingleEntityForEffect(optionList, delayedReveal, sa, title, isOptional, targetedPlayer, params);
        List<Opt> opts = new ArrayList<>();
        Map<String, T> byId = new HashMap<>();
        for (T e : optionList) {
            String id; String label; String name = null;
            if (e instanceof Player p) { id = p.equals(player) ? "you" : "opponent"; label = p.equals(player) ? "You" : "Opponent"; }
            else { Card c = (Card) e; id = StateView.id(c); label = cardLabel(c) + " (" + owner(c) + ")"; name = c.getName(); }
            byId.put(id, e);
            opts.add(new Opt(id, label, name));
        }
        String src = sa != null && sa.getHostCard() != null ? sa.getHostCard().getName() + ": " : "";
        List<String> r = ask("choose_entity", src + (title == null ? "Choose one." : title), opts, isOptional ? 0 : 1, 1, null);
        if (r == null) return super.chooseSingleEntityForEffect(optionList, delayedReveal, sa, title, isOptional, targetedPlayer, params);
        return r.isEmpty() ? null : byId.get(r.get(0));
    }

    @Override
    public CardCollectionView chooseCardsForEffect(CardCollectionView sourceList, SpellAbility sa, String title, int min, int max,
            boolean isOptional, Map<String, Object> params) {
        if (aiPlanning > 0 || sourceList.isEmpty()) return super.chooseCardsForEffect(sourceList, sa, title, min, max, isOptional, params);
        String src = sa != null && sa.getHostCard() != null ? sa.getHostCard().getName() + ": " : "";
        int lo = isOptional ? 0 : Math.min(min, sourceList.size());
        List<String> r = ask("choose_cards", src + (title == null ? "Choose cards." : title), cardOptions(sourceList), lo, Math.min(max, sourceList.size()), null);
        if (r == null) return super.chooseCardsForEffect(sourceList, sa, title, min, max, isOptional, params);
        CardCollection out = new CardCollection();
        for (String id : r) out.add(byId(sourceList, id));
        return out;
    }

    @Override
    public boolean confirmAction(SpellAbility sa, PlayerActionConfirmMode mode, String message, List<String> options, Card cardToShow,
            Map<String, Object> params) {
        if (aiPlanning > 0) return super.confirmAction(sa, mode, message, options, cardToShow, params);
        String yes = options != null && options.size() == 2 ? options.get(0) : "Yes";
        String no = options != null && options.size() == 2 ? options.get(1) : "No";
        String src = sa != null && sa.getHostCard() != null ? sa.getHostCard().getName() + ": " : "";
        List<String> r = ask("confirm", src + (message == null ? "Confirm?" : message),
                List.of(new Opt("yes", yes, null), new Opt("no", no, null)), 1, 1, null);
        if (r == null) return super.confirmAction(sa, mode, message, options, cardToShow, params);
        return r.get(0).equals("yes");
    }

    @Override
    public CardCollectionView chooseCardsToDiscardToMaximumHandSize(int numDiscard) {
        CardCollectionView hand = player.getCardsIn(ZoneType.Hand);
        List<String> r = ask("discard", "Discard " + numDiscard + " card(s) down to your maximum hand size.", cardOptions(hand), numDiscard, numDiscard, null);
        if (r == null) return super.chooseCardsToDiscardToMaximumHandSize(numDiscard);
        CardCollection out = new CardCollection();
        for (String id : r) out.add(byId(hand, id));
        return out;
    }

    @Override
    public CardCollection chooseCardsToDiscardFrom(Player p, SpellAbility sa, CardCollection validCards, int min, int max,
            CardCollectionView visibleToChooser) {
        if (aiPlanning > 0 || validCards.isEmpty()) return super.chooseCardsToDiscardFrom(p, sa, validCards, min, max, visibleToChooser);
        String who = p.equals(player) ? "your" : "your opponent's";
        List<String> r = ask("discard", "Choose " + (min == max ? min : min + "-" + max) + " card(s) from " + who + " hand to discard.",
                cardOptions(validCards), Math.min(min, validCards.size()), Math.min(max, validCards.size()), null);
        if (r == null) return super.chooseCardsToDiscardFrom(p, sa, validCards, min, max, visibleToChooser);
        CardCollection out = new CardCollection();
        for (String id : r) out.add(byId(validCards, id));
        return out;
    }
}
