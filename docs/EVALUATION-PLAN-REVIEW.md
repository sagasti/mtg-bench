# Review of docs/EVALUATION-PLAN.md (2026-10-02)

Adversarial review against ML datasets-and-benchmarks standards, by a Fable reviewer with web access. Two of its less
familiar citations (AV-AIVAT, DraftFM) were spot-checked and exist as cited; its repo facts (forge-ai drafts like
rank-bot; Forge's `BoosterDraftAI` ranks with the CubeCobra list) were verified. Revisions to the plan are deferred until
the full 8-LLM event runs cleanly.

## Overall

Unusually careful for a one-person benchmark: provenance, censoring, pod bootstrap, config-hash pre-registration, anchor
versioning and cost reporting exceed what most LLM game benchmarks disclose (BALROG, TextArena, lmgame-Bench). Weak
points a D&B reviewer would press: (1) the programme is underpowered against the plan's own variance evidence; (2) stage
scores defined by Forge's heuristic pilot and a CubeCobra-ranked builder measure fitness under Forge's heuristics;
(3) adaptive allocation as written is optional stopping and conflicts with pods as the unit; (4) common random numbers
and deck swaps cancel less in MTG with stochastic LLMs than in bridge/poker. Fixes are mostly re-scoping and
specification.

## Findings

1. **Underpowered (major).** Identical Forge AI seats differed by 328 Elo (`full-llm-1`) and 336 (`human-bots-9`). Two
   seats over n pods: SE ≈ s·√(2/n); 80% power needs n ≈ 15.7·s²/d². With s ≈ 150 Elo, 8 pods resolves ~200 Elo; 100 Elo
   needs ~35 pods per cell. Change: add a power section (endpoint, MDE, power, pods from the measured noise floor and
   pairing correlation); relabel the $50 programme as the pilot. Refs: Miller 2024 (arXiv:2411.00640); Reuel et al.
   2024 BetterBench (arXiv:2411.12990); Kaggle Game Arena (arXiv:2609.31473).
2. **Stage yardsticks are Forge-relative (major).** Forge's AI is heuristic, "best with aggro and midrange, poor to OK in
   control, pretty bad for combo" (Forge wiki); `BoosterDraftAI`/`LimitedDeckBuilder` use the same CubeCobra ranking file
   as rank-bot. Change: rename scores honestly; estimate deck strength from a pilot+deck mixed model with several pilots
   (Forge's four profiles plus a cheap LLM), report pilot×deck interaction; fix Forge profile and ranking-file version
   before headline runs; keep pick-agreement with CubeCobra as a labelled descriptive. Refs: Forge AI wiki; Kim &
   Sandholm 2026 (arXiv:2605.14261); Bertram et al. 2021 (arXiv:2105.11864); Ward 2026 DraftFM (arXiv:2608.19568).
3. **Adaptive allocation is optional stopping (major).** Inflates false positives, invalidates bootstrap CIs, biases
   estimates; extra games for a pair add within-pod replication only. Change: fixed, pre-registered pod budget; if
   adaptive later, allocate whole pods, confidence sequences, IPW the BT fit. Refs: Simmons et al. 2011; Hadad et al.
   2021 (PNAS); Johari et al. 2022; Chiang et al. 2024 Chatbot Arena (arXiv:2403.04132); Li, Chen & Huang 2026 AV-AIVAT
   (arXiv:2608.06362); Heckel et al. 2019.
4. **CRN and duplicate cancel less than claimed (major).** Chance continues after the draft, trajectories diverge, LLMs
   aren't reproducible at temperature 0 (Atil et al. 2024, arXiv:2408.04667); deck swap cancels deck strength only under
   additivity, which conflicts with measuring "fit". Change: measure realised paired correlation and design effect in the
   pilot; consider a MIVAT-style control variate from a fixed board-state value function; fix temperature per seat; ≥2
   replicate seeds per model. Refs: Burch et al. AIVAT (AAAI 2018); White & Bowling MIVAT (IJCAI 2009).
5. **Specify the rating model; 8 clusters is too few to bootstrap (major).** Write down logit P(i beats j) =
   (θ_i − θ_j) + (δ_d_i − δ_d_j) + β·play/draw + pod effect; fit a GLMM or Bayesian hierarchical BT; with few pods use
   t-based or posterior intervals; publish the full win matrix and a BT goodness-of-fit check; state the opponent
   population. Refs: Turner & Firth 2012 (BradleyTerry2); Chiang et al. 2024; Balduzzi et al. 2018.
6. **Contamination controls (minor).** Make the synthesised cube the headline, rotated per release with a pre-committed
   hash; add a memorisation probe (name the cube, archetypes, pick order) and a canary string in released artifacts;
   verify matched power with bot-only pods. Refs: GSM1k, LiveBench, VarBench (arXiv:2406.17681), lmgame-Bench
   (arXiv:2505.15146), BALROG, Leaderboard Illusion (arXiv:2504.20879).
7. **Pre-register the analysis, not just the config (minor):** endpoints, contrasts, MDE, exclusions, censoring,
   stopping, how forfeits enter stage scores; timestamped outside the repo.
8. **Pinning (minor):** report per seat model id, host, quantisation, temperature/top-p, reasoning, max tokens, prompt
   version, date range; ≥2 seeds per model with between-seed SD next to between-pod SD.
9. **Multiple comparisons (minor):** ≤5 pre-registered primary contrasts; Holm/BH for the rest or hierarchical shrinkage.
10. **Human calibration (suggestion):** 2–3 players of known level pilot fixed decks against Forge AI and one LLM through
    the same interface, play only.
11. **Over-engineered (suggestion):** drop the study-brief "utility" test (fold into the knowledge-tier ablation); prefer
    several pack sets with randomised seat rotation over a Williams square on one pack set; add two prompt paraphrases
    as a nuisance factor for interface ablations.

## Top 5 changes

1. Power section; the $50 programme becomes the pilot.
2. Remove adaptive allocation from the headline.
3. Relabel stage scores as Forge-relative; several pilots in a specified mixed model; fix Forge profile and ranking file.
4. Synthesised, rotated, hash-committed cube as headline; memorisation probe and canary; verify matched power.
5. Pre-register the analysis externally; fix sampling parameters per seat; report host/quantisation and between-seed
   variance.
