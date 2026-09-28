# data/

- `cards.json` — generated card index (`npm run bench -- cards index --forge-res <forge>/res`). Not committed.
- `MagicCompRules.txt` — the Magic Comprehensive Rules as plain text, used by the `search_rules` tool.
  Download the latest TXT from https://magic.wizards.com/en/rules and save it here with this exact name.
  Not committed (Wizards' copyright). Without it, `search_rules` answers "not available".
- `cubes/` — optional custom cube lists (`<name>.dck` or one card per line); refer to them by name in `event.cube`.
