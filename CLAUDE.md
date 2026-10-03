# mtg-bench: working rules

Project docs: `HANDOFF.md` (status, decisions log, future work), `docs/` (protocol, provenance, analytics), tickets in
`docs/tickets/`.

- **Review every changeset before it merges.** Each branch that changes code gets a `/code-review` at medium effort
  against `master` before merging; real findings are fixed on the branch first. Doc-only branches skip it.
- **One worktree, one install.** Every git worktree runs its own `npm install`; never symlink `node_modules` between
  checkouts.
- **Never read or print `.env`** (it holds the OpenRouter key). Check variable names only.
- **Paid runs are the owner's call.** Anything that calls an LLM provider costs money: say what it will cost and wait
  for a go-ahead. Bot, echo and mock runs are free.
- **Every action taken for a seat is recorded** as forced, policy, delegated or forfeit (`docs/DECISION-PROVENANCE.md`);
  a new mechanism that acts for a seat updates that document.
- **Owner questions go in `docs/QUESTIONS.md`**, one self-contained entry each, asked one at a time; don't bury
  decision requests at the end of status updates.
- **New run ids for new runs.** Run dirs are written once (`--force` deletes and restarts).
