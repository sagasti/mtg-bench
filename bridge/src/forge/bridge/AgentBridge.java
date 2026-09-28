package forge.bridge;

import java.io.File;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

import com.google.gson.JsonObject;

import forge.GuiDesktop;
import forge.LobbyPlayer;
import forge.deck.Deck;
import forge.deck.io.DeckSerializer;
import forge.game.Game;
import forge.game.GameEndReason;
import forge.game.GameOutcome;
import forge.game.GameRules;
import forge.game.GameType;
import forge.game.Match;
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
        int exit = 0;
        try {
            GuiBase.setInterface(new GuiDesktop());
            FModel.initialize(null, null);

            long seed = Long.parseLong(a.getOrDefault("seed", "1"));
            MyRandom.setRandom(new Random(seed));
            int games = Integer.parseInt(a.getOrDefault("games", "3"));
            MatchContext ctx = new MatchContext(Integer.parseInt(a.getOrDefault("max-turns", "40")), !"all".equals(a.get("stops")), "always".equals(a.get("mana")));

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
                lobby[s] = external ? new LobbyPlayerExternal(name, client, ctx, s) : GamePlayerUtil.createAiPlayer(name, s);
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
                end.addProperty("reason", error != null ? "error: " + error : out != null ? String.valueOf(out.getWinCondition()) : "unknown");
                client.send(end);
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
}
