package forge.bridge;

import java.io.File;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

import com.google.common.eventbus.Subscribe;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import forge.GuiDesktop;
import forge.LobbyPlayer;
import forge.deck.Deck;
import forge.deck.io.DeckSerializer;
import forge.game.Game;
import forge.game.GameEndReason;
import forge.game.GameLogEntry;
import forge.game.GameOutcome;
import forge.game.GameRules;
import forge.game.GameType;
import forge.game.Match;
import forge.game.event.GameEventPlayerPriority;
import forge.game.player.Player;
import forge.game.player.RegisteredPlayer;
import forge.gui.GuiBase;
import forge.model.FModel;
import forge.player.GamePlayerUtil;
import forge.util.MyRandom;

/**
 * Entry point launched by the harness for one match:
 *   java -cp forge-gui-desktop-...-jar-with-dependencies.jar:mtg-bench-bridge.jar forge.bridge.AgentBridge \
 *     --port P --token T --deck0 a.dck --deck1 b.dck --external0 true --external1 false \
 *     --games 3 --seed 42 --max-turns 40 [--stops smart|all] [--mana smart|always]
 * Must run with the Forge install (the directory containing res/) as working directory.
 */
public final class AgentBridge {
    public static void main(String[] args) throws Exception {
        if (System.getProperty("java.awt.headless") == null) System.setProperty("java.awt.headless", "true");
        System.setProperty("java.util.Arrays.useLegacyMergeSort", "true"); // same workaround Forge's Main applies
        Map<String, String> a = new HashMap<>();
        for (int i = 0; i + 1 < args.length; i += 2) a.put(args[i].replaceFirst("^--", ""), args[i + 1]);

        BridgeClient client = new BridgeClient(Integer.parseInt(a.get("port")), a.get("token"));
        StateView.warnings = client;
        int exit = 0;
        try {
            GuiBase.setInterface(new GuiDesktop());
            FModel.initialize(null, null);

            long seed = Long.parseLong(a.getOrDefault("seed", "1"));
            MyRandom.setRandom(new Random(seed));
            int games = Integer.parseInt(a.getOrDefault("games", "3"));
            MatchContext ctx = new MatchContext(Integer.parseInt(a.getOrDefault("max-turns", "40")), !"all".equals(a.get("stops")), "always".equals(a.get("mana")),
                    Integer.parseInt(a.getOrDefault("max-retries", "3")));

            GameRules rules = new GameRules(GameType.Draft);
            rules.setAppliedVariants(EnumSet.of(GameType.Draft));
            rules.setGamesPerMatch(games);

            List<RegisteredPlayer> players = new ArrayList<>();
            LobbyPlayer[] lobby = new LobbyPlayer[2];
            for (int s = 0; s < 2; s++) {
                Deck deck = DeckSerializer.fromFile(new File(a.get("deck" + s)));
                if (deck == null) throw new IllegalArgumentException("could not load deck " + a.get("deck" + s));
                String name = "P" + (s + 1); // neutral names: agents never learn who they are playing
                boolean external = Boolean.parseBoolean(a.getOrDefault("external" + s, "true"));
                boolean human = Boolean.parseBoolean(a.getOrDefault("human", "false")); // spike: Forge's human controller + headless screen
                lobby[s] = !external ? GamePlayerUtil.createAiPlayer(name, s)
                        : human ? new LobbyPlayerAgentHuman(name, client, ctx, s) : new LobbyPlayerExternal(name, client, ctx, s);
                RegisteredPlayer rp = new RegisteredPlayer(deck);
                rp.setPlayer(lobby[s]);
                players.add(rp);
            }

            Match match = new Match(rules, players, "mtg-bench");
            int g = 0;
            while (!match.isMatchOver() && g < games + 2) {
                g++;
                ctx.game = g;
                Game game = match.createGame();
                game.setNoGUIUser();
                TurnCap cap = new TurnCap(game, ctx.maxTurns);
                game.subscribeToEvents(cap);
                LoopGuard loop = new LoopGuard(game, ctx);
                game.subscribeToEvents(loop);
                JsonObject start = new JsonObject();
                start.addProperty("type", "game_start");
                start.addProperty("game", g);
                client.send(start);
                String error = null;
                try {
                    match.startGame(game); // runs the whole game on this thread
                } catch (Throwable t) {
                    error = t.toString();
                    t.printStackTrace();
                    if (!game.isGameOver()) game.setGameOver(GameEndReason.Draw);
                }
                GameOutcome out = game.getOutcome();
                JsonObject end = new JsonObject();
                end.addProperty("type", "game_end");
                end.addProperty("game", g);
                if (out != null && !out.isDraw() && out.getWinningLobbyPlayer() != null) {
                    end.addProperty("winner", out.getWinningLobbyPlayer().equals(lobby[0]) ? 0 : 1);
                }
                Player starter = game.getStartingPlayer();
                if (starter != null) end.addProperty("onThePlay", starter.getLobbyPlayer().equals(lobby[0]) ? 0 : 1);
                end.addProperty("turns", out != null ? out.getLastTurnNumber() : game.getPhaseHandler().getTurn());
                end.addProperty("reason", error != null ? "error: " + error : cap.reached ? "Draw (turn cap of " + ctx.maxTurns + " turns)"
                        : loop.reached ? "Draw (unbreakable loop)" : out != null ? String.valueOf(out.getWinCondition()) : "unknown");
                // Full Forge game log, chronological, for offline review. The harness writes it to a file; it never reaches agents.
                JsonArray log = new JsonArray();
                for (GameLogEntry e : game.getGameLog().getAllEntries()) log.add(e.type() + ": " + e.message());
                end.add("log", log);
                JsonArray auto = new JsonArray();
                for (int i = 0; i < 2; i++) auto.add(ctx.drainAuto(i));
                end.add("auto", auto);
                client.send(end);
                Integer winner = end.has("winner") ? end.get("winner").getAsInt() : null;
                if (winner != null) ctx.wins[winner]++;
                if (!match.isMatchOver() && g < games + 2) {
                    // Between games: agents may rewrite their match notes from this game's public log (MTR 2.11:
                    // notes taken during a match may be used for the rest of it). The next game waits for them.
                    JsonObject between = new JsonObject();
                    between.addProperty("game", g);
                    JsonArray wins = new JsonArray();
                    wins.add(ctx.wins[0]);
                    wins.add(ctx.wins[1]);
                    between.add("wins", wins);
                    JsonArray names = new JsonArray();
                    for (int i = 0; i < 2; i++) {
                        String name = "?";
                        for (Player p : game.getPlayers()) if (p.getLobbyPlayer().equals(lobby[i])) name = p.getName();
                        names.add(name);
                    }
                    between.add("names", names);
                    between.add("log", StateView.publicLog(game));
                    client.exchange("between_games", between);
                }
            }
            JsonObject done = new JsonObject();
            done.addProperty("type", "match_end");
            client.send(done);
        } catch (Throwable t) {
            t.printStackTrace();
            try { client.error(t.toString()); } catch (RuntimeException ignored) { }
            exit = 1;
        } finally {
            client.close();
        }
        System.exit(exit);
    }

    /**
     * The game is a draw once it passes maxGameTurns (total turns, both players). Checked whenever a player would get
     * priority, on the game thread, for every kind of seat: Forge then sees the game over at its next state-based check.
     */
    static final class TurnCap {
        private final Game game;
        private final int maxTurns;
        volatile boolean reached = false;

        TurnCap(Game game, int maxTurns) {
            this.game = game;
            this.maxTurns = maxTurns;
        }

        @Subscribe
        public void onPriority(GameEventPlayerPriority e) {
            if (maxTurns > 0 && game.getPhaseHandler().getTurn() > maxTurns && !game.isGameOver()) {
                reached = true;
                // Without an outcome, setGameOver counts every remaining player as a winner.
                for (Player p : game.getPlayers()) p.intentionalDraw();
                game.setGameOver(GameEndReason.Draw);
            }
        }
    }

    /**
     * An unbreakable loop is a draw (in the spirit of MTR 4.4): the same game state at priority, with something on the
     * stack, recurring LOOP_REPEATS times in one turn. Nothing in a loop like that changes anything, so neither player
     * is going to stop it (both copying Chain of Smog back and forth with empty hands, for every kind of seat). The
     * state compared is public: turn, phase, who has priority, each player's life, poison, zone sizes and floating
     * mana, every permanent (tapped, counters, damage, power/toughness) and the stack (sources, abilities, targets).
     */
    static final class LoopGuard {
        static final int LOOP_REPEATS = 20;
        private final Game game;
        private final MatchContext ctx;
        private final Map<String, Integer> seen = new HashMap<>();
        private int turn = -1;
        volatile boolean reached = false;

        LoopGuard(Game game, MatchContext ctx) {
            this.game = game;
            this.ctx = ctx;
        }

        @Subscribe
        public void onPriority(GameEventPlayerPriority e) {
            if (game.isGameOver() || game.getStack().isEmpty()) return;
            int t = game.getPhaseHandler().getTurn();
            if (t != turn) { seen.clear(); turn = t; }
            if (seen.merge(stateKey(e), 1, Integer::sum) < LOOP_REPEATS) return;
            reached = true;
            for (int i = 0; i < 2; i++)
                ctx.auto(i, "policy", "game_end", "unbreakable loop: the same game state recurred " + LOOP_REPEATS + " times in one turn; game drawn");
            for (Player p : game.getPlayers()) p.intentionalDraw();
            game.setGameOver(GameEndReason.Draw);
        }

        private String stateKey(GameEventPlayerPriority e) {
            StringBuilder sb = new StringBuilder();
            sb.append(e.phase()).append('|').append(e.priority() != null ? e.priority().getId() : -1);
            for (Player p : game.getPlayers()) {
                sb.append("|p").append(p.getId()).append(':').append(p.getLife()).append(',').append(p.getPoisonCounters());
                for (forge.game.zone.ZoneType z : new forge.game.zone.ZoneType[] { forge.game.zone.ZoneType.Hand, forge.game.zone.ZoneType.Library,
                        forge.game.zone.ZoneType.Graveyard, forge.game.zone.ZoneType.Exile }) sb.append(',').append(p.getCardsIn(z).size());
                sb.append(',').append(p.getManaPool().totalMana());
            }
            for (forge.game.card.Card c : game.getCardsIn(forge.game.zone.ZoneType.Battlefield)) {
                sb.append("|c").append(c.getId()).append(c.isTapped() ? 'T' : 'U').append(c.getCounters()).append(',').append(c.getDamage());
                if (c.isCreature()) sb.append(',').append(c.getNetPower()).append('/').append(c.getNetToughness());
            }
            // Stack objects by source name, not id: each copy of a spell is a new card.
            for (forge.game.spellability.SpellAbilityStackInstance si : game.getStack()) {
                forge.game.spellability.SpellAbility sa = si.getSpellAbility();
                sb.append("|s").append(sa.getHostCard() != null ? sa.getHostCard().getName() : "?").append(',').append(sa.getApi());
                for (forge.game.spellability.TargetChoices tc : sa.getAllTargetChoices()) {
                    for (forge.game.card.Card c : tc.getTargetCards()) sb.append(",c").append(c.getId());
                    for (Player p : tc.getTargetPlayers()) sb.append(",p").append(p.getId());
                    for (forge.game.spellability.SpellAbility ts : tc.getTargetSpells()) sb.append(",s").append(ts.getHostCard() != null ? ts.getHostCard().getName() : "?");
                }
            }
            return sb.toString();
        }
    }
}
