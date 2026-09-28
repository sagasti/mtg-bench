package forge.bridge;

import java.util.EnumSet;
import java.util.List;
import java.util.Set;

import com.google.common.collect.Multiset;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import forge.game.Game;
import forge.game.GameLogEntry;
import forge.game.GameLogEntryType;
import forge.game.card.Card;
import forge.game.card.CardCollectionView;
import forge.game.card.CounterType;
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
        boolean hidden = c.isFaceDown() && !c.getController().equals(viewer) && !includeHiddenName;
        o.addProperty("name", hidden ? "face-down card" : c.getName());
        if (c.isToken()) {
            o.addProperty("token", true);
            o.addProperty("types", c.getType().toString());
            String text = c.getOracleText();
            if (text != null && !text.isEmpty()) o.addProperty("text", text);
        }
        if (c.isCreature()) {
            o.addProperty("pt", c.getNetPower() + "/" + c.getNetToughness());
            if (c.getDamage() > 0) o.addProperty("damage", c.getDamage());
            if (c.isSick() && c.getController().equals(viewer)) o.addProperty("summoningSick", true);
        }
        if (c.isTapped()) o.addProperty("tapped", true);
        Multiset<CounterType> counters = c.getCounters();
        if (counters != null && !counters.isEmpty()) {
            JsonObject co = new JsonObject();
            for (Multiset.Entry<CounterType> e : counters.entrySet()) co.addProperty(e.getElement().toString(), e.getCount());
            o.add("counters", co);
        }
        Card attachedTo = c.getAttachedTo();
        if (attachedTo != null) o.addProperty("attachedTo", id(attachedTo));
        if (!c.getController().equals(c.getOwner())) o.addProperty("owner", label(viewer, c.getOwner()));
        return o;
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
        o.add("battlefield", cards(p.getCardsIn(ZoneType.Battlefield), viewer));
        o.add("graveyard", names(p.getCardsIn(ZoneType.Graveyard), viewer));
        CardCollectionView exile = p.getCardsIn(ZoneType.Exile);
        if (!exile.isEmpty()) o.add("exile", names(exile, viewer));
        return o;
    }

    public static JsonObject build(Game game, Player viewer, int gameNo) {
        JsonObject s = new JsonObject();
        s.addProperty("game", gameNo);
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
                e.addProperty("description", si.getStackDescription());
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
        for (int i = n - 1; i >= 0; i--) log.add(entries.get(i).message());
        s.add("recentLog", log);
        return s;
    }
}
