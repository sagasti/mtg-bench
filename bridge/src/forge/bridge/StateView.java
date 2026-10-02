package forge.bridge;

import java.util.EnumSet;
import java.util.List;
import java.util.Set;
import java.util.function.Supplier;

import com.google.common.collect.Multiset;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import forge.game.Game;
import forge.game.GameLogEntry;
import forge.game.GameLogEntryType;
import forge.game.card.Card;
import forge.game.card.CardCollectionView;
import forge.game.card.CardView;
import forge.game.player.PlayerView;
import forge.game.spellability.StackItemView;
import forge.gui.card.CardDetailUtil;
import forge.card.MagicColor;
import forge.game.card.CounterType;
import forge.game.keyword.KeywordInterface;
import forge.game.mana.ManaPool;
import forge.game.spellability.SpellAbility;
import forge.game.spellability.TargetChoices;
import forge.game.combat.Combat;
import forge.game.player.Player;
import forge.game.spellability.SpellAbilityStackInstance;
import forge.game.zone.ZoneType;

/**
 * Player-filtered JSON view of a Forge game. Only information the viewing
 * player may legally see: own hand, public zones, counts for hidden zones.
 * Card ids are "c<forge id>" and match the ids used in decision options.
 */
public final class StateView {
    private StateView() {}

    /** Log entry types that are public information. ZONE_CHANGE and INFORMATION are excluded because they can name hidden cards. */
    private static final Set<GameLogEntryType> PUBLIC_LOG = EnumSet.of(
            GameLogEntryType.TURN, GameLogEntryType.MULLIGAN, GameLogEntryType.LAND, GameLogEntryType.STACK_ADD,
            GameLogEntryType.STACK_RESOLVE, GameLogEntryType.COMBAT, GameLogEntryType.DAMAGE, GameLogEntryType.LIFE,
            GameLogEntryType.DISCARD, GameLogEntryType.GAME_OUTCOME);

    public static String id(Card c) {
        return "c" + c.getId();
    }

    public static String label(Player viewer, Player p) {
        return p.equals(viewer) ? "you" : "opponent";
    }

    public static JsonObject card(Card c, Player viewer, boolean includeHiddenName) {
        JsonObject o = new JsonObject();
        o.addProperty("id", id(c));
        CardView cv = c.getView();
        PlayerView pv = viewer.getView();
        boolean hidden = c.isFaceDown() && !includeHiddenName && !cv.canFaceDownBeShownTo(pv);
        o.addProperty("name", hidden ? "face-down card" : c.getName());
        if (c.isFaceDown() && !hidden) o.addProperty("faceDown", true);
        if (c.isToken()) o.addProperty("token", true);
        boolean onField = c.isInZone(ZoneType.Battlefield);
        if (onField || c.isToken()) {
            // Forge's own card-detail text, as a human sees it on hover: current rules text after every effect,
            // counters, attachments, chosen colour/type, imprinted/exiled-with cards, shields, text changes...
            // Forge decides visibility; a face-down card shows only its face-down characteristics.
            boolean canShow = cv.canBeShownTo(pv);
            // Current rules text after every effect, from the live card: the view's tracked copy of it stays empty in
            // a headless game. Then the rest of Forge's card-detail text (counters, attachments, exiled-with, chosen
            // colour/type, shields...).
            String rules = canShow ? clean(rendered(c.getGame(), "rules text of " + c.getName(), "printed Oracle text shown",
                    c::getAbilityText, c::getOracleText)) : "";
            String detail = clean(rendered(c.getGame(), "card detail of " + c.getName(), "left out",
                    () -> CardDetailUtil.composeCardText(cv.getCurrentState(), c.getGame().getView(), canShow), () -> ""));
            String text = rules.isEmpty() || detail.contains(rules) ? detail : (rules + (detail.isEmpty() ? "" : "\n" + detail));
            if (!text.isEmpty()) o.addProperty("text", text);
        }
        if (c.isCreature()) {
            o.addProperty("pt", c.getNetPower() + "/" + c.getNetToughness());
            if (c.getDamage() > 0) o.addProperty("damage", c.getDamage());
            if (onField && c.isSick() && c.getController().equals(viewer)) o.addProperty("summoningSick", true);
        }
        if (c.isTapped()) o.addProperty("tapped", true);
        if (c.isPhasedOut()) o.addProperty("phasedOut", true);
        if (!c.getController().equals(c.getOwner())) o.addProperty("owner", label(viewer, c.getOwner()));
        return o;
    }

    /** Where rendering fallbacks are reported (set by AgentBridge); each distinct one once per game. */
    static volatile BridgeClient warnings;
    private static final Set<String> warned = java.util.concurrent.ConcurrentHashMap.newKeySet();

    /**
     * Text from one of Forge's live renderers, which can throw for some cards: Card.getAbilityText on a modal
     * triggered ability with no activating player (Ertai Resurrected on the battlefield) dereferences it while counting
     * each mode's targets. A failed rendering never breaks the decision: the fallback stands in, and a bridge warning
     * says so.
     */
    private static String rendered(Game game, String what, String instead, Supplier<String> render, Supplier<String> fallback) {
        try {
            return render.get();
        } catch (RuntimeException e) {
            String msg = what + " couldn't be rendered (" + e.getClass().getSimpleName() + "); " + instead;
            BridgeClient w = warnings;
            if (w != null && warned.add(game.getId() + "|" + msg)) w.warn(msg);
            return fallback.get();
        }
    }

    /** Plain text: no HTML from Forge's display formatting, normalized line breaks. */
    static String clean(String s) {
        if (s == null) return "";
        return s.replaceAll("<[^>]+>", "")
                .replaceAll(" ?\\[(Zone Changer|Phase|Removed from|Added to)[^\\]]*\\]", "") // Forge's internal trigger bookkeeping
                .replace("\r\n", "\n").replaceAll("\n{2,}", "\n").trim();
    }

    private static JsonArray cards(Iterable<Card> cs, Player viewer) {
        JsonArray a = new JsonArray();
        for (Card c : cs) a.add(card(c, viewer, false));
        return a;
    }

    private static JsonArray names(Iterable<Card> cs, Player viewer) {
        JsonArray a = new JsonArray();
        for (Card c : cs) a.add(c.isFaceDown() && !c.getController().equals(viewer) ? "face-down card" : c.getName());
        return a;
    }

    private static JsonObject side(Player p, Player viewer) {
        JsonObject o = new JsonObject();
        boolean me = p.equals(viewer);
        o.addProperty("life", p.getLife());
        if (p.getPoisonCounters() > 0) o.addProperty("poison", p.getPoisonCounters());
        o.addProperty("librarySize", p.getCardsIn(ZoneType.Library).size());
        if (me) {
            o.add("hand", cards(p.getCardsIn(ZoneType.Hand), viewer));
            o.addProperty("landsPlayedThisTurn", p.getLandsPlayedThisTurn());
        } else {
            o.addProperty("handSize", p.getCardsIn(ZoneType.Hand).size());
        }
        ManaPool pool = p.getManaPool();
        if (pool.totalMana() > 0) {
            JsonObject mp = new JsonObject();
            String[] names = {"W", "U", "B", "R", "G", "C"};
            byte[] cols = {MagicColor.WHITE, MagicColor.BLUE, MagicColor.BLACK, MagicColor.RED, MagicColor.GREEN, MagicColor.COLORLESS};
            for (int i = 0; i < cols.length; i++) {
                int n = pool.getAmountOfColor(cols[i]);
                if (n > 0) mp.addProperty(names[i], n);
            }
            o.add("manaPool", mp);
        }
        Multiset<CounterType> pc = p.getCounters();
        if (pc != null && !pc.isEmpty()) {
            JsonObject co = new JsonObject();
            for (Multiset.Entry<CounterType> e : pc.entrySet()) co.addProperty(e.getElement().toString(), e.getCount());
            o.add("counters", co);
        }
        JsonArray pk = new JsonArray();
        for (KeywordInterface k : p.getKeywords()) {
            String t = k.getTitle();
            if (t != null && !t.isEmpty()) pk.add(t);
        }
        if (pk.size() > 0) o.add("keywords", pk);
        if (p.isMonarch()) o.addProperty("monarch", true);
        CardCollectionView command = p.getCardsIn(ZoneType.Command);
        if (!command.isEmpty()) o.add("command", cards(command, viewer));
        o.add("battlefield", cards(p.getCardsIn(ZoneType.Battlefield), viewer));
        o.add("graveyard", names(p.getCardsIn(ZoneType.Graveyard), viewer));
        CardCollectionView exile = p.getCardsIn(ZoneType.Exile);
        if (!exile.isEmpty()) o.add("exile", names(exile, viewer));
        return o;
    }

    /** Targets of a stack object and its sub-abilities: card ids, "you"/"opponent", or "spell: <source>". */
    private static JsonArray targets(SpellAbility sa, Player viewer) {
        JsonArray a = new JsonArray();
        for (TargetChoices tc : sa.getAllTargetChoices()) {
            for (Card c : tc.getTargetCards()) a.add(id(c));
            for (Player p : tc.getTargetPlayers()) a.add(label(viewer, p));
            for (SpellAbility t : tc.getTargetSpells()) a.add("spell: " + (t.getHostCard() != null ? t.getHostCard().getName() : "?"));
        }
        return a;
    }

    /** All public log entries of a game, oldest first (the filter that keeps hidden cards out). */
    public static JsonArray publicLog(Game game) {
        JsonArray log = new JsonArray();
        List<GameLogEntry> entries = game.getGameLog().getLogEntriesForTypes(PUBLIC_LOG); // newest first
        for (int i = entries.size() - 1; i >= 0; i--) log.add(clean(entries.get(i).message()));
        return log;
    }

    public static JsonObject build(Game game, Player viewer, MatchContext ctx, int seat) {
        JsonObject s = new JsonObject();
        s.addProperty("game", ctx.game);
        JsonObject match = new JsonObject();
        match.addProperty("gamesYouWon", ctx.wins[seat]);
        match.addProperty("gamesOpponentWon", ctx.wins[1 - seat]);
        s.add("match", match);
        s.addProperty("turn", game.getPhaseHandler().getTurn());
        s.addProperty("phase", String.valueOf(game.getPhaseHandler().getPhase()));
        Player active = game.getPhaseHandler().getPlayerTurn();
        if (active != null) s.addProperty("activePlayer", label(viewer, active));
        s.addProperty("youAre", viewer.getName());
        s.add("you", side(viewer, viewer));
        for (Player p : game.getPlayers()) {
            if (!p.equals(viewer)) { s.add("opponent", side(p, viewer)); break; }
        }
        if (!game.getStack().isEmpty()) {
            JsonArray st = new JsonArray();
            for (SpellAbilityStackInstance si : game.getStack()) {
                JsonObject e = new JsonObject();
                e.addProperty("controller", label(viewer, si.getSpellAbility().getActivatingPlayer()));
                e.addProperty("source", si.getSpellAbility().getHostCard() != null ? si.getSpellAbility().getHostCard().getName() : "?");
                e.addProperty("description", clean(rendered(game, "stack text of " + e.get("source").getAsString(), "left out",
                        () -> StackItemView.get(si).getText(), () -> "")));
                JsonArray tg = targets(si.getSpellAbility(), viewer);
                if (tg.size() > 0) e.add("targets", tg);
                st.add(e);
            }
            s.add("stack", st); // top of stack first
        }
        Combat combat = game.getPhaseHandler().getCombat();
        if (combat != null && !combat.getAttackers().isEmpty()) {
            JsonArray atk = new JsonArray();
            for (Card a : combat.getAttackers()) {
                JsonObject e = card(a, viewer, false);
                Object def = combat.getDefenderByAttacker(a);
                e.addProperty("attacking", def instanceof Player ? label(viewer, (Player) def) : String.valueOf(def));
                JsonArray bl = new JsonArray();
                for (Card b : combat.getBlockers(a)) bl.add(id(b));
                if (bl.size() > 0) e.add("blockedBy", bl);
                atk.add(e);
            }
            s.add("combat", atk);
        }
        JsonArray log = new JsonArray();
        List<GameLogEntry> entries = game.getGameLog().getLogEntriesForTypes(PUBLIC_LOG);
        // Forge returns newest first; keep the 15 most recent in chronological order.
        int n = Math.min(15, entries.size());
        for (int i = n - 1; i >= 0; i--) log.add(clean(entries.get(i).message()));
        s.add("recentLog", log);
        return s;
    }
}
