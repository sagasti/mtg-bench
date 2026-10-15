package forge.bridge;

import forge.LobbyPlayer;
import forge.ai.PlayerControllerAi;
import forge.game.Game;
import forge.game.player.Player;

/** Pilot patch (mtg-rival): Forge's stock AI, except that the harness can force who plays first (balanced play/draw bars). */
public class PlayerControllerAiForced extends PlayerControllerAi {
    private final int seat;
    private final MatchContext ctx;

    public PlayerControllerAiForced(Game game, Player p, LobbyPlayer lp, int seat, MatchContext ctx) {
        super(game, p, lp);
        this.seat = seat;
        this.ctx = ctx;
    }

    @Override
    public Player chooseStartingPlayer(boolean isFirstGame) {
        if (ctx.firstSeat >= 0) {
            ctx.auto(seat, "policy", "play_draw", "starting player forced by the harness (--first)");
            return ctx.firstSeat == seat ? getPlayer() : getPlayer().getOpponents().get(0);
        }
        return super.chooseStartingPlayer(isFirstGame);
    }
}
