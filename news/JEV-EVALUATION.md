# Is usefulnews a good use case for Jev? — Yes.

Question from `outline.txt`: *"I want to see if this project is a good use case of the typesafe jev tool."*
Measured on 2026-09-30 with real feeds (g1, Folha, BBC Brasil, Tecnoblog, Hacker News, The Verge,
Google News Curitiba) and a test profile (Curitiba, software engineer, likes AI tools / local events /
personal finance / cooking, avoids celebrity, crime, election polls, far-away wars).

## Why it fits

The outline asks for "a score for each decision" plus filtering, feedback and memory. That is
exactly Jev's shape: many small typed judgments with probabilities, composed in code.

- **One request per article, 10 questions in parallel**: 4 Scores (actionable, relevance, impact,
  depth), 5 Nouls (clickbait, sensational, tragedy-as-entertainment, speculation, gossip), 1 Choice
  (topic). The 0-100 usefulness is computed in code (`scoring.usefulness`) — weights change instantly
  without re-scoring, and every number on screen is explainable ("why this score").
- **Memory is state, not training**: learned preference rules go into `reader.learned_preferences`
  in the Jev state; thumbs also produce per-topic/per-source adjustments in code.

## Numbers

| | Jev (`jev-1.13.0`) | Generative LLM (OpenCode CLI, `mimo-v2.6-flash-free`) |
|---|---|---|
| 148 articles, full refresh | well under a minute incl. feed fetching | (not run — ~6 min extrapolated from the sample) |
| 24-article sample | **1.2 s** | 58.9 s |
| cost | ≈ **US$ 0.00006 / article** (~1.5k input tokens) | free tier here; paid APIs cost more per article |
| output | typed + calibrated probabilities, never malformed | JSON that must be validated (`LLMScorer` clips/normalizes) |

Agreement on the same 24 articles: usefulness rank correlation (Spearman) **0.83**, mean gap
**10 points**, same topic 62 %. Per dimension: actionable 0.83, relevance 0.77, impact 0.78,
clickbait 0.80, sensational 0.84, gossip 0.82, depth 0.56, speculation 0.55 (tragedy: no tragic items in
the sample).

Ranking sanity check (Jev, before any feedback): top = Windows clipboard how-to, new Firefox, local
Curitiba public-exam notice, Show HN tools; bottom (3-5) = reality-show gossip, election debates,
party intrigue.

Learning check: 👎 on two coupon/deal posts (+ notes), 👍 on the Curitiba exam and Firefox, then
"re-learn" → the LLM distilled 3 rules ("Dislikes shopping deals, coupons, and product price drops"…).
After re-scoring, *all* deal posts dropped from 57-70 to 20-28, including four the user never rated,
and a Curitiba storm alert moved into the top 10.

## Where Jev was weaker (watch these)

- **Local election logistics** ("Paraná will not have a dry law on election day", "TRE brings
  voting machines to Curitiba for practice"): Jev 12/39 vs LLM 44/60. These are actionable local
  items that share vocabulary with "election polls" (in `avoid`). If it bothers you, 👍 them with a
  note — the rule memory handles this kind of nuance.
- **Topic labels** agree only 62 % with the LLM; topics drive the learned topic bias, so borderline
  labels (deal posts as `personal_finance` vs `business`) spread that bias a bit.
- `depth` is judged from title + summary only (no article body fetch).

## Division of labour chosen

- **Jev**: all per-article judgments (default scorer).
- **Generative LLM (OpenCode)**: only for turning free-text feedback notes into preference rules
  (`scoring.distill_rules`), and as an optional alternative scorer.

Reproduce: `python3 compare_scorers.py --n 24` (needs a prior Jev refresh in the data dir).
