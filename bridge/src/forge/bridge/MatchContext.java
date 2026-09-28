package forge.bridge;

/** Per-match settings shared by both external controllers. */
public final class MatchContext {
    public volatile int game = 0;
    public final int maxTurns;
    /** Only ask at meaningful priority stops (see PlayerControllerExternal.shouldStop). */
    public final boolean smartStops;

    public MatchContext(int maxTurns, boolean smartStops) {
        this.maxTurns = maxTurns;
        this.smartStops = smartStops;
    }
}
