# Tickets

One file per ticket. Status: open | in progress | done | dropped.

| Code | Title | Severity | Status |
|---|---|---|---|
| [MB-001](MB-001.md) | Pods, not games, are the replication unit; one pod can't separate models | high | open |
| [MB-002](MB-002.md) | Rating anchors drift with bridge version and cube; rank-bot forfeits targeting at scale | high | open |
| [MB-003](MB-003.md) | Provider errors and truncated outputs are scored as the agent's mistakes | high | in progress |
| [MB-004](MB-004.md) | Seats aren't in the same reasoning regime or on pinned hosts | high | in progress |
| [MB-005](MB-005.md) | The prompt misdescribes the interface; harness policies shape which decisions exist | medium | open |
| [MB-006](MB-006.md) | Errored and timed-out matches censor long games non-randomly | medium | open |
| [MB-007](MB-007.md) | maxGameTurns isn't enforced on the default (human) bridge | medium | open |
| [MB-008](MB-008.md) | Same seed means same packs: runs aren't independent replicates | medium | open |
| [MB-009](MB-009.md) | Cube contamination; bot-only computed hints; coarse decision kinds on the human path | medium | open |
| [MB-010](MB-010.md) | No version provenance in run artifacts; bridge depends on Forge internals | medium | open |
| [MB-011](MB-011.md) | Cost and wall-clock scale with the slowest, most expensive seat | medium | open |
| [MB-012](MB-012.md) | Missing pieces for defensible published results | medium | open |
| [MB-013](MB-013.md) | Mandatory targets arrive with min 0; empty answers accepted; rank-bot answers [] (root cause of MB-002's forfeits) | high | open |
| [MB-014](MB-014.md) | A decision timeout abandons the whole match as an infrastructure error | high | in progress |
| [MB-015](MB-015.md) | Harness exceptions become agent forfeits, and forfeit rows drop the error | medium | done |
| [MB-016](MB-016.md) | Malformed submit_decision calls are coerced to choice [] and accepted when min is 0 | medium | done |
| [MB-017](MB-017.md) | Errored matches still award standings points and match-level results | medium | open |
| [MB-018](MB-018.md) | Provenance inflated: match notes counted as in-game agent decisions; re-asks counted separately | medium | in progress |
| [MB-019](MB-019.md) | Tokens of decisions that end in infra errors are missing from the cost tables | medium | in progress |
| [MB-020](MB-020.md) | Missing prompt templates render silently as empty | low | done |
| [MB-021](MB-021.md) | Bootstrap clusters collide when merging runs | low | open |
| [MB-022](MB-022.md) | Card reference omits graveyard, exile and stack-source cards | low | done |
| [MB-023](MB-023.md) | SeatConfig.concurrency is documented but never read | low | done |
| [MB-024](MB-024.md) | Re-using a --run-id appends to the existing run and corrupts it | high | open |
| [MB-025](MB-025.md) | --pools-from accepts an incomplete draft log | medium | open |
| [MB-026](MB-026.md) | Derived runs don't check the source matches the new config | medium | open |
| [MB-027](MB-027.md) | Swiss pairing can dead-end and crash the event; crashed runs report as complete | medium | open |
| [MB-028](MB-028.md) | --pools-from restores post-deckbuild notes before re-running deckbuild | low | open |
| [MB-029](MB-029.md) | Loaded decks are never validated | low | open |
