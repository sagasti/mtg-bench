# Tickets

One file per ticket. Status: open | in progress | done | dropped.

| Code | Title | Severity | Status |
|---|---|---|---|
| [MB-001](MB-001.md) | Pods, not games, are the replication unit; one pod can't separate models | high | in progress |
| [MB-002](MB-002.md) | Rating anchors drift with bridge version and cube; rank-bot forfeits targeting at scale | high | done |
| [MB-003](MB-003.md) | Provider errors and truncated outputs are scored as the agent's mistakes | high | done |
| [MB-004](MB-004.md) | Seats aren't in the same reasoning regime or on pinned hosts | high | in progress |
| [MB-005](MB-005.md) | The prompt misdescribes the interface; harness policies shape which decisions exist | medium | in progress |
| [MB-006](MB-006.md) | Errored and timed-out matches censor long games non-randomly | medium | done |
| [MB-007](MB-007.md) | maxGameTurns isn't enforced on the default (human) bridge | medium | done |
| [MB-008](MB-008.md) | Same seed means same packs: runs aren't independent replicates | medium | done |
| [MB-009](MB-009.md) | Cube contamination; bot-only computed hints; coarse decision kinds on the human path | medium | done |
| [MB-010](MB-010.md) | No version provenance in run artifacts; bridge depends on Forge internals | medium | done |
| [MB-011](MB-011.md) | Cost and wall-clock scale with the slowest, most expensive seat | medium | done |
| [MB-012](MB-012.md) | Missing pieces for defensible published results | medium | done |
| [MB-013](MB-013.md) | Mandatory targets arrive with min 0; empty answers accepted; rank-bot answers [] (root cause of MB-002's forfeits) | high | done |
| [MB-014](MB-014.md) | A decision timeout abandons the whole match as an infrastructure error | high | done |
| [MB-015](MB-015.md) | Harness exceptions become agent forfeits, and forfeit rows drop the error | medium | done |
| [MB-016](MB-016.md) | Malformed submit_decision calls are coerced to choice [] and accepted when min is 0 | medium | done |
| [MB-017](MB-017.md) | Errored matches still award standings points and match-level results | medium | done |
| [MB-018](MB-018.md) | Provenance inflated: match notes counted as in-game agent decisions; re-asks counted separately | medium | done |
| [MB-019](MB-019.md) | Tokens of decisions that end in infra errors are missing from the cost tables | medium | done |
| [MB-020](MB-020.md) | Missing prompt templates render silently as empty | low | done |
| [MB-021](MB-021.md) | Bootstrap clusters collide when merging runs | low | done |
| [MB-022](MB-022.md) | Card reference omits graveyard, exile and stack-source cards | low | done |
| [MB-023](MB-023.md) | SeatConfig.concurrency is documented but never read | low | done |
| [MB-024](MB-024.md) | Re-using a --run-id appends to the existing run and corrupts it | high | done |
| [MB-025](MB-025.md) | --pools-from accepts an incomplete draft log | medium | done |
| [MB-026](MB-026.md) | Derived runs don't check the source matches the new config | medium | done |
| [MB-027](MB-027.md) | Swiss pairing can dead-end and crash the event; crashed runs report as complete | medium | done |
| [MB-028](MB-028.md) | --pools-from restores post-deckbuild notes before re-running deckbuild | low | done |
| [MB-029](MB-029.md) | Loaded decks are never validated | low | done |
| [MB-030](MB-030.md) | 'End Turn' / 'Undo' buttons at priority silently yield the rest of the turn | high | done |
| [MB-031](MB-031.md) | Attack retries never reach the budget and re-asks invert the agent's choice | high | done |
| [MB-032](MB-032.md) | Forfeits on mandatory selections press OK with fewer than min picks | high | done |
| [MB-033](MB-033.md) | Reveals are turned into agent decisions | medium | done |
| [MB-034](MB-034.md) | manaPayment: always is ignored on the human path | medium | done |
| [MB-035](MB-035.md) | The forfeit null action on yes/no questions is 'Yes' | medium | done |
| [MB-036](MB-036.md) | Every Forge notification is shown to the agent as a rejection of its last choice | medium | done |
| [MB-037](MB-037.md) | Block retries can only add blockers, never remove them | medium | done |
| [MB-038](MB-038.md) | An exception in step() re-drives the same input forever | low | done |
| [MB-039](MB-039.md) | No ablations isolating harness effects | medium | open |
| [MB-040](MB-040.md) | Drafting and playing skill aren't separated | medium | open |
| [MB-041](MB-041.md) | No human baseline | medium | open |
| [MB-042](MB-042.md) | No held-out cube condition | medium | open |
| [MB-043](MB-043.md) | Targets outside the seat's own zones are never offered | high | done |
| [MB-044](MB-044.md) | Mana payment presses a stale Auto forever | high | done |
| [MB-045](MB-045.md) | An unbounded number prompt floods the harness until it runs out of heap | high | done |
| [MB-046](MB-046.md) | An unbreakable loop runs until the match timeout | medium | done |
| [MB-047](MB-047.md) | rank-bot accepts pointless optional copies | medium | done |
| [MB-048](MB-048.md) | Rendering Ertai Resurrected's rules text crashes the input driver | medium | done |
| [MB-049](MB-049.md) | Deckbuilding is one blind shot: show the agent its deck's stats and allow revisions | medium | open |
| [MB-050](MB-050.md) | Mixed-zone target lists include section headers as selectable options | low | open |
| [MB-051](MB-051.md) | Record the provider's native finish reason on failed calls | low | open |
