# usefulnews (bbla/news) — notes for Claude

Part of bbla since 2026-10-03: port 8805, rules shared with the page meter via `../shared_rules.py` (see ../CLAUDE.md).

Read `README.md` and `JEV-EVALUATION.md`. Origin: `outline.txt` (keep it).

## Layout
- `app.py` — Flask (port 8805): `/api/state`, `/api/settings`, `/api/ai/config`, `/api/refresh`
  (background job: fetch → score missing/stale), `/api/job`, `/api/news`, `/api/feedback`,
  `/api/learn`, `/api/memory`.
- `feeds.py` — stdlib RSS/Atom parsing, default feeds, Google News local feed.
- `scoring.py` — dimension definitions (single source of truth for both scorers), `JevScorer`,
  `LLMScorer`, `usefulness()` composite, `learn_biases`, `distill_rules`.
- `store.py` — SQLite `data/news.db` (articles, judgments per scorer + profile_hash, feedback);
  `data/settings.json`, `data/memory.json`.
- `ai.py` — provider layer shared verbatim with rrecipes/bbla/wwhats; keep copies in sync.
- `compare_scorers.py` — Jev vs LLM report.

## Rules
- Raw judgments are stored, usefulness is computed at read time → weight/bias changes never need
  re-scoring. Only profile/rules changes (profile_hash) make judgments stale.
- Jev model pinned to `jev-1.13.0` (weights tuned on it). Changing a question's wording changes its
  meaning — re-run `compare_scorers.py` and eyeball the top/bottom of the list after edits.
- Tests never hit the network (feeds, Jev and LLM are mocked). Live Jev costs ≈ US$0.00006/article.
- To try things live without touching the user's data: `USEFULNEWS_DATA_DIR=<scratch> ./run`.
