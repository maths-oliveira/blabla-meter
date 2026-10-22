# usefulnews

A news aggregator that ranks every article by how **useful it is to you** — actionable, relevant,
impactful, well-argued — and pushes down clickbait, sensationalism, tragedy-as-entertainment,
speculation and gossip. You set a minimum score, give 👍/👎, your own 0-100 score and a note, and it
learns.

## Run

```bash
./run          # http://127.0.0.1:8805  (or ../run: bridge + news)
```

First visit asks for your profile (location, work, what's useful, what's useless), then **↻ Refresh**
fetches the feeds and scores them.

## How scoring works

Each article is judged on separate dimensions (see `scoring.py`):

| kind | dimensions |
|---|---|
| Score 0-1 | actionable · relevance (to your profile) · impact (on you) · depth / quality |
| Flag probability | clickbait · sensational · tragedy as entertainment · speculation · gossip |
| Topic | tech tool, local event, local news, personal finance, politics, crime, … |

`usefulness = weighted mean of scores × Π(1 − weight × flag) + learned topic/source adjustment`,
clamped 0-100. Open "why this score" on any article to see every part. Weights are editable in
Settings and apply instantly.

**Scorers**: Jev (TypeSafe, default — fast, cheap, calibrated) or any generative LLM through
`ai.py` (OpenCode CLI free models, OpenCode Zen/Go, OpenRouter, custom). See
[JEV-EVALUATION.md](JEV-EVALUATION.md) for the head-to-head.

## Memory (how it improves)

- Every 👍/👎/manual score updates per-topic (±15) and per-source (±8) adjustments immediately.
- Every 5 feedback items (or 🧠 Memory → "Re-learn"), the LLM distils your votes and notes into ≤12
  preference rules. The rules are part of what Jev sees for every article; you can edit them by hand.
- Changing profile or rules marks old judgments stale (dashed badge); the next refresh re-scores.

## Keys

- TypeSafe: `TYPESAFE_API_KEY`, or Settings (saved to `~/.config/usefulnews/typesafe.key`, 0600);
  falls back to `~/.config/mercado/typesafe.key`.
- LLM: Settings → provider/key (`~/.config/usefulnews/`); default is the installed `opencode` (free).

Data (SQLite + JSON) lives in `data/` (git-ignored).

## Tests

```bash
python3 -m unittest test_usefulnews && node --check web/app.js
```
