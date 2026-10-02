package forge.bridge;

import forge.game.Game;
import forge.game.player.Player;
import forge.game.player.PlayerController;
import forge.player.LobbyPlayerHuman;
import forge.player.PlayerControllerHuman;

/** Lobby player for an agent that plays through Forge's HUMAN controller, with a headless screen (spike). */
public class LobbyPlayerAgentHuman extends LobbyPlayerHuman {
    private final BridgeClient client;
    private final MatchContext ctx;
    private final int seat;

    public LobbyPlayerAgentHuman(String name, BridgeClient client, MatchContext ctx, int seat) {
        super(name);
        this.client = client;
        this.ctx = ctx;
        this.seat = seat;
    }

    @Override
    public Player createIngamePlayer(Game game, int id) {
        Player player = new Player(getName(), game, id); // neutral name: no "personalized" human name
        AgentChannel ch = new AgentChannel(client, ctx, seat);
        ch.player = player;
        PlayerControllerHuman controller = new AgentControllerHuman(game, player, this, ch);
        AgentGuiGame gui = new AgentGuiGame(ch);
        gui.setGameView(game.getView());
        controller.setGui(gui);
        gui.setOriginalGameController(player.getView(), controller);
        controller.getInputQueue().addObserver(new InputDriver(controller, gui, ch));
        player.setFirstController(controller);
        return player;
    }

    @Override
    public PlayerController createMindSlaveController(Player master, Player slave) {
        return new PlayerControllerHuman(slave, this, (PlayerControllerHuman) master.getController());
    }
}
