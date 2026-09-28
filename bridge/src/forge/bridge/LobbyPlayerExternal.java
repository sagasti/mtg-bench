package forge.bridge;

import forge.ai.LobbyPlayerAi;
import forge.game.Game;
import forge.game.player.Player;
import forge.game.player.PlayerController;

/** Lobby player whose in-game controller forwards decisions to the harness. */
public class LobbyPlayerExternal extends LobbyPlayerAi {
    private final BridgeClient client;
    private final MatchContext ctx;
    private final int seat;

    public LobbyPlayerExternal(String name, BridgeClient client, MatchContext ctx, int seat) {
        super(name, null);
        this.client = client;
        this.ctx = ctx;
        this.seat = seat;
    }

    @Override
    public Player createIngamePlayer(Game game, int id) {
        Player p = new Player(getName(), game, id);
        p.setFirstController(new PlayerControllerExternal(game, p, this, client, ctx, seat));
        return p;
    }

    @Override
    public PlayerController createMindSlaveController(Player master, Player slave) {
        // Controlling another player (Mindslaver etc.): the agent decides for the controlled player.
        return new PlayerControllerExternal(slave.getGame(), slave, this, client, ctx, seat);
    }
}
