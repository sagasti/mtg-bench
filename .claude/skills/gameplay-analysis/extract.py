#!/usr/bin/env python3
"""Build one seat's gameplay dossier from a run dir, for the gameplay-analysis skill.

Usage: extract.py <runDir> <seat> <outFile>

The dossier is Markdown: the seat's deck and builder's rationale, its draft picks, and for every match and game the
condensed public game log plus each of the seat's decisions with what it saw (turn, phase, life, hand, options), what it
chose and why (its own rationale), and any invalid answers or forfeits. Only the seat's own view is used for its
decisions; the game log is Forge's public log (no opponent hands).
"""
import json
import os
import re
import sys

run, seat, out = sys.argv[1], sys.argv[2], sys.argv[3]


def jsonl(name):
    path = os.path.join(run, name)
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


decisions = [d for d in jsonl("decisions.jsonl") if d.get("seat") == seat]
prompts = {p["requestId"]: p["prompt"] for p in jsonl("rendered-prompts.jsonl") if p.get("seat") == seat}
matches = [m for m in jsonl("matches.jsonl") if seat in m.get("seats", [])]
picks = [p for p in jsonl("draft.jsonl") if p.get("type") == "pick" and p.get("seat") == seat]


def field(prompt, key):
    m = re.search(rf"^\s*{key}: (.*)$", prompt, re.M)
    return m.group(1).strip().strip('"') if m else ""


def block(prompt, header):
    """The YAML list under `header:` inside the seat's own `you:` section (hand, battlefield)."""
    you = prompt.split("\nyou:", 1)[-1].split("\nopponent:", 1)[0]
    m = re.search(rf"^  {header}:(.*?)(?=^  \w+:|\Z)", you, re.M | re.S)
    if not m:
        return []
    return [re.sub(r"\s+", " ", x).strip() for x in re.findall(r"name: (.*)", m.group(1))]


def options(prompt):
    sec = prompt.split("## Options", 1)
    if len(sec) < 2:
        return []
    return [ln[2:].strip() for ln in sec[1].splitlines() if ln.startswith("- ")]


def life(prompt):
    you = prompt.split("\nyou:", 1)[-1]
    opp = prompt.split("\nopponent:", 1)[-1]
    return field(you, "life"), field(opp, "life")


def game_log(match_id, game):
    path = os.path.join(run, "games", f"{match_id}-g{game}.log")
    if not os.path.exists(path):
        return ["(no game log)"]
    keep = []
    for ln in open(path):
        ln = ln.rstrip()
        if ln.startswith(("PHASE:", "MANA:", "STACK_RESOLVE:", "PLAYER_CONTROL:")):
            continue
        keep.append(re.sub(r" \(\d+\)", "", ln))
    return keep


pod = next((d.get("pod") for d in decisions if d.get("pod") is not None), 0)
L = []
deck_path = os.path.join(run, f"pod{pod}", "decks", f"{seat}.json")
deck = json.load(open(deck_path)) if os.path.exists(deck_path) else None
build = next((d for d in decisions if d.get("phase") == "deckbuild"), None)
L.append(f"# Gameplay dossier: {seat} ({os.path.basename(run.rstrip('/'))})\n")
if deck:
    counts = {}
    for n in deck["main"]:
        counts[n] = counts.get(n, 0) + 1
    L.append(f"## Deck ({len(deck['main'])} cards; basics {deck['basics']})\n")
    L.append(", ".join(f"{k}× {n}" if k > 1 else n for n, k in counts.items() if n not in deck["basics"]))
    L.append(f"\nSideboard: {', '.join(deck['sideboard'])}\n")
if build:
    L.append(f"Builder's rationale: {build.get('rationale', '')}\n")
if picks:
    L.append("## Draft picks (pack-pick: card)\n")
    L.append("; ".join(f"P{p['pack']}p{p['pick']}: {p['card']}" for p in picks) + "\n")

for m in matches:
    me = m["seats"].index(seat)
    opp = m["seats"][1 - me]
    games = list(m.get("games", []))
    played = {g["game"] for g in games}
    for gid in sorted({d.get("game") for d in decisions if d.get("matchId") == m["matchId"] and d.get("game")} - played):
        games.append({"game": gid, "winner": None, "reason": "unfinished (match aborted)", "turns": "?", "onThePlay": None})
    score = "".join("W" if g["winner"] == me else "L" if g["winner"] == 1 - me else "D" if g["reason"] != "unfinished (match aborted)" else "-" for g in games)
    status = f" — ERROR: {m['error'][:120]}" if m.get("error") else ""
    L.append(f"\n## Match {m['matchId']} vs {opp}: {score}{status}\n")
    for g in games:
        gid = g["game"]
        outcome = "won" if g["winner"] == me else "lost" if g["winner"] == 1 - me else "no result" if g["onThePlay"] is None else "draw"
        on_play = f"P{g['onThePlay'] + 1}" if g["onThePlay"] is not None else "?"
        L.append(f"\n### Game {gid}: {outcome} ({g['reason']}, {g['turns']} turns; {seat} is P{me + 1}; on the play: {on_play})\n")
        L.append("Public game log:\n```")
        L.extend(game_log(m["matchId"], gid))
        L.append("```\n")
        L.append(f"{seat}'s decisions (turn/phase · life you/opp · hand · your board · options → choice · rationale):\n")
        prev, repeat = None, 0
        for d in [d for d in decisions if d.get("matchId") == m["matchId"] and d.get("game") == gid]:
            p = prompts.get(d["requestId"], "")
            opts = options(p)
            choice = "; ".join(d.get("choiceLabels") or []) or "(none)"
            flags = []
            if d.get("invalidAttempts"):
                flags.append(f"{d['invalidAttempts']} invalid answer(s)")
            if d.get("forfeit"):
                flags.append("FORFEIT" + (f" ({d.get('error')})" if d.get("error") else ""))
            if d.get("autoResolved"):
                flags.append("forced")
            you_life, opp_life = life(p)
            hand = block(p, "hand")
            board = block(p, "battlefield")
            line = (f"- T{field(p, 'turn') or '?'} {field(p, 'phase')} · {you_life}/{opp_life} · "
                    f"{d['kind']}"
                    + (f" · hand [{', '.join(hand)}]" if hand else "")
                    + (f" · board [{', '.join(board)}]" if board else "")
                    + (f" · {len(opts)} options: {' | '.join(o[:70] for o in opts[:12])}{' …' if len(opts) > 12 else ''}" if opts else "")
                    + f" → **{choice[:200]}**"
                    + (f" · {'; '.join(flags)}" if flags else "")
                    + (f" · _{(d.get('rationale') or '').strip()[:400]}_" if d.get("rationale") else ""))
            key = (d["kind"], choice) if not flags else None
            if key is not None and key == prev:
                repeat += 1
                continue
            if repeat:
                L.append(f"  (… the same decision repeated {repeat} more time(s))")
            prev, repeat = key, 0
            L.append(line)
        if repeat:
            L.append(f"  (… the same decision repeated {repeat} more time(s))")

notes_dir = os.path.join(run, f"pod{pod}", "notes")
for suffix in (".draft.md", ".md"):
    path = os.path.join(notes_dir, seat + suffix)
    if os.path.exists(path):
        L.append(f"\n## Notes file {seat}{suffix}\n\n{open(path).read()}")

os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
with open(out, "w") as f:
    f.write("\n".join(L) + "\n")
print(f"{out}: {os.path.getsize(out) // 1024} KB, {len(matches)} matches, {len(decisions)} decisions")
