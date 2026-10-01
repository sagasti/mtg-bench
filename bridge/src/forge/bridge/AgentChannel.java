package forge.bridge;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import forge.game.player.Player;

/**
 * One agent seat's connection to the harness, shared by the human-controller path (AgentGuiGame + InputDriver):
 * builds the player-filtered state, sends a decision, validates the ids. Same protocol as PlayerControllerExternal.
 */
final class AgentChannel {
    final BridgeClient client;
    final MatchContext ctx;
    final int seat;
    Player player;
    /** The harness flagged the last answer as a forfeit (the null action). */
    boolean lastAnswerForfeit = false;

    AgentChannel(BridgeClient client, MatchContext ctx, int seat) {
        this.client = client;
        this.ctx = ctx;
        this.seat = seat;
    }

    List<String> ask(String kind, String prompt, List<PlayerControllerExternal.Opt> options, int min, int max, JsonObject hints) {
        max = Math.min(max, options.size());
        if (options.isEmpty() || min > max) return null;
        JsonObject req = new JsonObject();
        req.addProperty("seat", seat);
        req.addProperty("game", ctx.game);
        req.addProperty("kind", kind);
        req.addProperty("prompt", prompt);
        req.add("state", StateView.build(player.getGame(), player, ctx, seat));
        JsonArray opts = new JsonArray();
        for (PlayerControllerExternal.Opt o : options) opts.add(o.toJson());
        req.add("options", opts);
        req.addProperty("min", min);
        req.addProperty("max", max);
        if (hints != null) req.add("hints", hints);
        JsonObject ans = client.request(req);
        lastAnswerForfeit = ans != null && ans.has("forfeit") && ans.get("forfeit").getAsBoolean();
        if (ans == null || !ans.has("choice")) return null;
        Set<String> valid = new HashSet<>();
        for (PlayerControllerExternal.Opt o : options) valid.add(o.id);
        List<String> out = new ArrayList<>();
        for (JsonElement e : ans.getAsJsonArray("choice")) {
            String id = e.getAsString();
            if (!valid.contains(id) || out.contains(id)) return null;
            out.add(id);
        }
        return out.size() < min || out.size() > max ? null : out;
    }

    void delegated(String what, String reason) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "delegated");
        o.addProperty("seat", seat);
        o.addProperty("game", ctx.game);
        o.addProperty("what", what);
        o.addProperty("reason", reason);
        client.send(o);
    }
}
