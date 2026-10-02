package forge.bridge;

import java.io.BufferedReader;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * Line-delimited JSON connection back to the Node harness (127.0.0.1 only).
 * Decisions are strictly request/response: the game thread blocks until the
 * harness answers, so there is never more than one outstanding request.
 */
public final class BridgeClient implements Closeable {
    private final Socket socket;
    private final BufferedReader in;
    private final Writer out;
    private int nextRid = 0;

    public BridgeClient(int port, String token) throws IOException {
        socket = new Socket(InetAddress.getLoopbackAddress(), port);
        socket.setTcpNoDelay(true);
        in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
        out = new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8);
        JsonObject hello = new JsonObject();
        hello.addProperty("type", "hello");
        hello.addProperty("token", token);
        send(hello);
    }

    public synchronized void send(JsonObject msg) {
        try {
            out.write(msg.toString());
            out.write('\n');
            out.flush();
        } catch (IOException e) {
            throw new IllegalStateException("harness connection lost", e);
        }
    }

    /** Sends a decision request and blocks for the matching answer. Returns null if the connection drops. */
    public JsonObject request(JsonObject decision) {
        return exchange("decision", decision);
    }

    /** Sends a message of the given type and blocks for the harness's matching answer. Returns null if the connection drops. */
    public synchronized JsonObject exchange(String type, JsonObject msg) {
        int rid = ++nextRid;
        msg.addProperty("type", type);
        msg.addProperty("rid", rid);
        send(msg);
        try {
            String line;
            while ((line = in.readLine()) != null) {
                JsonObject reply = JsonParser.parseString(line).getAsJsonObject();
                if ("answer".equals(reply.get("type").getAsString()) && reply.get("rid").getAsInt() == rid) {
                    return reply;
                }
            }
        } catch (IOException | RuntimeException e) {
            System.err.println("[bridge] failed reading answer: " + e);
        }
        return null;
    }

    public void log(String text) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "log");
        o.addProperty("msg", text);
        send(o);
    }

    /** Something the bridge worked around without breaking the decision (the harness counts it per match and reports it). */
    public void warn(String text) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "warning");
        o.addProperty("msg", text);
        send(o);
    }

    public void error(String text) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "error");
        o.addProperty("msg", text);
        send(o);
    }

    @Override
    public void close() throws IOException {
        socket.close();
    }
}
