package forge.bridge;

import forge.LobbyPlayer;
import forge.ai.LobbyPlayerAi;
import forge.game.Game;
import forge.game.player.Player;
import forge.player.GamePlayerUtil;

/** Pilot patch (mtg-rival): a stock-AI lobby player whose in-game controller honours MatchContext.firstSeat. */
public class LobbyPlayerAiForced extends LobbyPlayerAi {
    private final int seat;
    private final MatchContext ctx;

    public LobbyPlayerAiForced(String name, int seat, MatchContext ctx) {
        super(name, null);
        this.seat = seat;
        this.ctx = ctx;
    }

    /** Same profile selection as Forge's own GamePlayerUtil.createAiPlayer, then our controller. */
    public static LobbyPlayer create(String name, int seat, MatchContext ctx) {
        LobbyPlayerAi reference = (LobbyPlayerAi) GamePlayerUtil.createAiPlayer(name, seat);
        LobbyPlayerAiForced ai = new LobbyPlayerAiForced(name, seat, ctx);
        ai.setAiProfile(reference.getAiProfile());
        return ai;
    }

    @Override
    public Player createIngamePlayer(Game game, int id) {
        Player p = new Player(getName(), game, id);
        p.setFirstController(new PlayerControllerAiForced(game, p, this, seat, ctx));
        return p;
    }
}
