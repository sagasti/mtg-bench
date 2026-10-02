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
    /**
     * Set by AgentControllerHuman while Forge asks a question whose kind the input alone doesn't tell (discard, scry,
     * London-mulligan bottom...); InputDriver and AgentGuiGame label the decision with it.
     */
    volatile String kindHint = null;
    /** Bot-only tags for the optional effect a yes/no question is about (set by AgentControllerHuman.confirmAction). */
    volatile JsonObject confirmHints = null;
    /** Informational messages from Forge (notifications, reveals) since the last decision; shown with the next one. */
    private final List<String> notices = new ArrayList<>();
    private static final int MAX_NOTICES = 12;
    /**
     * Re-ask number of the next question within one in-game step (0 = first ask; InputDriver sets it for retries of
     * the same step after Forge rejected the answer). Sent as "attempt", then reset.
     */
    int attempt = 0;

    AgentChannel(BridgeClient client, MatchContext ctx, int seat) {
        this.client = client;
        this.ctx = ctx;
        this.seat = seat;
    }

    List<String> ask(String kind, String prompt, List<PlayerControllerExternal.Opt> options, int min, int max, JsonObject hints) {
        int att = attempt;
        attempt = 0;
        max = Math.min(max, options.size());
        if (options.isEmpty() || min > max) return null;
        JsonObject req = new JsonObject();
        req.addProperty("seat", seat);
        req.addProperty("game", ctx.game);
        req.addProperty("kind", kind);
        String news = drainNotices();
        req.addProperty("prompt", news.isEmpty() ? prompt : prompt + "\n(Since your last decision: " + news + ")");
        req.add("state", StateView.build(player.getGame(), player, ctx, seat));
        JsonArray opts = new JsonArray();
        for (PlayerControllerExternal.Opt o : options) opts.add(o.toJson());
        req.add("options", opts);
        req.addProperty("min", min);
        req.addProperty("max", max);
        if (hints != null) req.add("hints", hints);
        req.addProperty("attempt", att);
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

    synchronized void notice(String text) {
        if (text == null || text.isBlank()) return;
        if (notices.size() >= MAX_NOTICES) notices.remove(0);
        notices.add(StateView.clean(text).replace('\n', ' ').trim());
    }

    private synchronized String drainNotices() {
        String s = String.join(" / ", notices);
        notices.clear();
        return s;
    }

    void auto(String category, String what, String reason) {
        ctx.auto(seat, category, what, reason);
    }

    /** The agent's answers kept failing in-game and it got the null action (counted against the agent). */
    void forfeited(String what, String reason) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "forfeit");
        o.addProperty("seat", seat);
        o.addProperty("game", ctx.game);
        o.addProperty("what", what);
        o.addProperty("reason", reason);
        client.send(o);
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
