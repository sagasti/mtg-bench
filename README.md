# mtg-bench

A benchmark for AI decision-making in Magic: The Gathering. **Eight agents cube-draft, build decks, and play each other** through the [Forge](https://github.com/Card-Forge/forge) rules engine. Results are pooled into Bradley-Terry (Elo-scale) ratings with confidence intervals, alongside full token and cost analytics.

```
 cube study ─▶ draft (8 seats, 3×15) ─▶ deckbuild ─▶ round robin, Bo3 ─▶ ratings + analytics
   (per LLM)     simultaneous picks       40 cards      via GameEngine        report.md
```

- **Any model**: Anthropic, OpenAI, Gemini, OpenRouter, or any OpenAI-compatible server (vLLM, Ollama…), plus free reference bots (`forge-ai`, `rank-bot`, `random`).
- **Same rules for everyone**: knowledge level, tools, budgets and prompts are set per event and versioned. Agents never see the cube's name, their opponent's identity, or hidden information.
- **Legal moves by construction**: agents choose from enumerated legal options, so the benchmark measures judgement, not rules parsing.
- **Everything logged**: every model call (tokens, including cache and reasoning, latency, errors), every decision, pick, deck and game.

> **Picking this up on a new machine?** Start with [HANDOFF.md](HANDOFF.md).

## Quick start

```bash
npm install
npm run bench -- cards index --forge-res ~/forge/res        # card data from Forge's scripts
npm run bench -- run config/smoke.mock.yaml --forge-res ~/forge/res   # offline end-to-end test (mock engine, no keys)
```
Then follow **[docs/FORGE_SETUP.md](docs/FORGE_SETUP.md)** to run real games through Forge.

## Configure an event

`config/event.example.yaml` is a fully commented template. The essentials:

```yaml
event: { name: pauper-v1, cube: "Adam Styborkski's Pauper Cube", pods: 4, format: round-robin,
         gamesPerMatch: 3, knowledge: oracle+tools+primer, cubeStudy: true }
engine: { type: forge, forgeDir: ~/forge }
seats:            # exactly 8
  - { id: claude-opus, provider: anthropic, model: claude-opus-5-5, apiKeyEnv: ANTHROPIC_API_KEY }
  - …
  - { id: forge-ai, provider: forge-ai }
```

| Doc | Covers |
|---|---|
| [docs/AGENTS.md](docs/AGENTS.md) | the 8 seats: providers, API keys, anchors, fairness, failure handling, cost planning |
| [docs/PROMPTS.md](docs/PROMPTS.md) | system prompts, knowledge levels (oracle text, rules search, primer), cube study, notes, anti-leak |
| [docs/ANALYTICS.md](docs/ANALYTICS.md) | logs, token accounting per provider, cost, report sections |
| [docs/FORGE_SETUP.md](docs/FORGE_SETUP.md) | installing Forge, building the bridge, smoke tests, what the agent vs Forge AI decides |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | decision contract and the Forge bridge wire format |

## Commands

```
npm run bench -- cards index --forge-res <dir>     build data/cards.json
npm run bench -- cubes --forge-res <dir>           list Forge's bundled cubes
npm run bench -- check <config> [--ping]           validate config, keys, data, engine; --ping tests each LLM seat
npm run bench -- run <config> [--engine mock|forge] [--pods N] [--run-id ID] [--forge-res DIR] [--verbose]
npm run bench -- report <runDir...>                report.md (merged if several)
npm run bench -- rate <runDir...> [--level game|match] [--anchor seat=1500]
```

## Layout

```
src/
  agents/        Seat wrapper (validation, fallback, notes, analytics), LLM agent + providers, bots, prompt rendering
  cards/         card DB from Forge scripts, cube loading, rankings
  draft/ deckbuild/ tournament/   pod pipeline, round robin / Swiss scheduling
  engine/        GameEngine interface; forge/ (TCP bridge adapter), mock/ (simplified rules, testing only)
  knowledge/     lookup_card / search_cube / search_rules tools, CR index
  analytics/     JSONL recorder, report
  rating/        Bradley-Terry + bootstrap
bridge/          Java: PlayerControllerExternal etc., runs inside Forge
prompts/v1/      versioned prompt templates
config/          event configs
```

## Status

- ✅ Harness, draft, deckbuild, round robin/Swiss, ratings and analytics: tested end to end with the mock engine.
- ✅ Forge bridge: agents make every game decision (casting sub-decisions, mana, combat damage, scry, triggers…). Anything Forge's AI decides for an agent is counted as "delegated". Type-checked against Forge source; the Node side of the protocol tested against a fake bridge.
- ⏳ First real Forge run: see FORGE_SETUP.md.
- 🔜 Ideas: deck-swap control (play each other's decks, to separate drafting skill from piloting skill); the last few delegated decision types (naming a card, convoke); puzzle and regret-vs-search tracks.

The mock engine is a simplified stand-in for testing. Never report its results.
