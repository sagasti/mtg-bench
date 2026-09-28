package forge.bridge;

/** Per-match settings shared by both external controllers. */
public final class MatchContext {
    public volatile int game = 0;
    public final int maxTurns;
    /** Only ask at meaningful priority stops (see PlayerControllerExternal.shouldStop). */
    public final boolean smartStops;
    /** Ask about mana payment even when every legal payment taps the same kind of sources. */
    public final boolean alwaysAskMana;

    public MatchContext(int maxTurns, boolean smartStops, boolean alwaysAskMana) {
        this.maxTurns = maxTurns;
        this.smartStops = smartStops;
        this.alwaysAskMana = alwaysAskMana;
    }
}
