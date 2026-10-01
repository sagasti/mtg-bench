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
        boolean hidden = c.isFaceDown() && !c.getController().equals(viewer) && !includeHiddenName;
        o.addProperty("name", hidden ? "face-down card" : c.getName());
        if (c.isFaceDown() && !hidden) o.addProperty("faceDown", true);
        if (c.isToken()) o.addProperty("token", true);
        boolean onField = c.isInZone(ZoneType.Battlefield);
        if (onField || c.isToken()) {
            // Current characteristics, after every continuous effect: what the rules engine is using right now.
            o.addProperty("types", c.getType().toString());
            o.addProperty("colors", colors(c));
            if (!hidden) {
                JsonArray kws = keywords(c);
                if (kws.size() > 0) o.add("keywords", kws);
                String text = currentText(c);
                if (!text.isEmpty() && (c.isToken() || isModified(c))) o.addProperty("text", text);
            }
        }
        if (c.isCreature()) {
            o.addProperty("pt", c.getNetPower() + "/" + c.getNetToughness());
            if (onField && (c.getNetPower() != c.getBasePower() || c.getNetToughness() != c.getBaseToughness()))
                o.addProperty("basePt", c.getBasePower() + "/" + c.getBaseToughness());
            if (c.getDamage() > 0) o.addProperty("damage", c.getDamage());
            if (onField && c.isSick() && c.getController().equals(viewer)) o.addProperty("summoningSick", true);
        }
        if (c.isTapped()) o.addProperty("tapped", true);
        if (c.isPhasedOut()) o.addProperty("phasedOut", true);
        Multiset<CounterType> counters = c.getCounters();
        if (counters != null && !counters.isEmpty()) {
            JsonObject co = new JsonObject();
            for (Multiset.Entry<CounterType> e : counters.entrySet()) co.addProperty(e.getElement().toString(), e.getCount());
            o.add("counters", co);
        }
        Card attachedTo = c.getAttachedTo();
        if (attachedTo != null) o.addProperty("attachedTo", id(attachedTo));
        CardCollectionView attached = c.getAttachedCards();
        if (attached != null && !attached.isEmpty()) {
            JsonArray at = new JsonArray();
            for (Card a : attached) at.add(id(a));
            o.add("attachments", at);
        }
        if (!c.getController().equals(c.getOwner())) o.addProperty("owner", label(viewer, c.getOwner()));
        return o;
    }

    private static String colors(Card c) {
        String s = c.getColor().toString();
        return s == null || s.isEmpty() ? "colorless" : s;
    }

    private static JsonArray keywords(Card c) {
        JsonArray a = new JsonArray();
        for (KeywordInterface k : c.getKeywords()) {
            String t = k.getTitle();
            if (t != null && !t.isEmpty()) a.add(t);
        }
        return a;
    }

    private static String currentText(Card c) {
        return clean(c.getAbilityText());
    }

    /** True when an effect currently changes the card's abilities, keywords, types or colours (layers 3-6), so its printed text is no longer the whole story. */
    private static boolean isModified(Card c) {
        return !c.getChangedCardTraits().isEmpty() || !c.getChangedCardTraitsByText().isEmpty()
                || !c.getChangedCardKeywords().isEmpty() || !c.getChangedCardKeywordsByText().isEmpty()
                || c.getChangedCardTypes().iterator().hasNext() || c.hasChangedCardColors();
    }

    /** Plain text: no HTML from Forge's display formatting, normalized line breaks. */
    private static String clean(String s) {
        if (s == null) return "";
        return s.replaceAll("<[^>]+>", "").replace("\r\n", "\n").replaceAll("\n{2,}", "\n").trim();
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
        for (int i = n - 1; i >= 0; i--) log.add(entries.get(i).message());
        s.add("recentLog", log);
        return s;
    }
}
