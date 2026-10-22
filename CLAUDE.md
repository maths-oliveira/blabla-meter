# bbla (Blabla Meter) — notes for Claude

Read `README.md`. Origin: `outline.txt` (keep it).

## Layout
- `extension/` — MV3 (Brave/Chrome compatible, no build step), ES modules. Packaged with
  `extension/build_zip.sh` → `blabla-meter-<version>.zip`.
  - `background.js` — service worker: message router (`analyze` = on-demand LLM deep dive,
    `pageScore` = instant Jev score shown on panel open, `pageStats`/`showBlocks` for
    freshness + badges, `pick` in block|score mode, `scoreElement` + `scoreClear` for the
    learned per-site score areas, `restoreMarks` for the marks toggle, `focus`,
    `blockSelector`, `blockClear`, `clear`, `feedback`, `relearn`, `testProvider`, `testJev`,
    `saveJevKey`, `ads*`), settings/memory in `chrome.storage.local`, analysis cache per URL in
    `chrome.storage.session`. Sends the extension's TypeSafe key per-request
    (`X-Typesafe-Key`) plus `thresholds` + `model` in every `/ads/score` call.
  - `lib/ads.js` — `DEFAULT_ADS_THRESHOLDS` + `normalizeThresholds` + `shouldHide`
    (object or legacy positional args) + `buildAdsPayload` (includes thresholds/model).
  - `lib/pagescore.js` — `buildPagePayload` (title/excerpt/host, 2000 chars, plus up to 8
    capped section blocks) + `scoreTags` (topic + 4 dimension chips + flags ≥ 0.5) + `tagLines`
    (badge tooltip lines) + `generalizeSelector` (picked → group selector) + `hashExcerpt`
    (block-result cache keys) + `settledEnough` (hydration waits).
  - `lib/ai.js` — providers + `chat()` (fetch; `fetchImpl` injectable for tests). OpenAI-style
    chat/completions except `api: "anthropic"` (Messages API, raw fetch, `anthropic-version` +
    browser-access header, no temperature); per-provider quirks in `PROVIDERS[id].body`. Keys are
    per provider in `settings.keys` (`keyFor`; legacy single `key` only until keys exist). Options
    Save requests host access for the endpoint origin (covered by optional `<all_urls>`).
    `DEFAULT_SETTINGS` also holds `typesafeKey`, `jevModel`, `adsThresholds`, `customBlocks`,
    `scoreSelectors` and the master switch `enabled` (background `extGet`/`extSet`,
    guarded by `needOn`; panel ⏻ button + options card flip it).
  - `lib/analysis.js` — prompt, `normalizeAnalysis` (never trust AI JSON), seed categories, memory
    helpers (`addFeedback`, `needsRelearn` every 5, `relearnMessages`, `applyRules`).
  - `lib/page.js` — functions injected with `chrome.scripting.executeScript({func})`; they must stay
    self-contained (no imports/closures). `highlightQuotes` concatenates text nodes, finds each quote
    with a whitespace/quote-tolerant regex, wraps ranges back-to-front. `extractPage` also returns
    `headings` + `words` (side panel reading time + outline) and `blocks` (per-heading sections
    for badges); `showBlockScores`/`clearBlockScores` draw the per-section score circles.
    Badges go inside real h1–h6 (before clamped card headlines); the number is CSS `::before`
    from `data-score`, so it never leaks into `innerText` on re-extraction.
    Container choice is by text volume (feeds over lone articles); header/footer/aside only
    count as chrome when top-level or nav-bearing, so hero sections keep badges.
    `startElementPicker`,
    `applyCustomBlocks`/`clearCustomBlocks` are the Unclutter-style manual per-site blocking.
  - `sidepanel.*`, `options.*`, `ui.css`. The panel is two-stage: instant Jev score + tags +
    outline on open (`pageScore`), verdict/pareto/highlights only via the AI deep-dive button.
    Section badges are injected by `showBlockScores` (page.js); the panel re-scores when a
    cheap `pageStats` check shows the body changed under a cached score.
- `bridge/bridge.py` + `bridge/ai.py` — local OpenAI-style endpoint (port 8804) that runs the provider
  from `ai.py` (default: installed `opencode` CLI, free models). Refuses web-page origins; allows
  `chrome-extension://` and no-origin. `ai.py` is shared verbatim with rrecipes/usefulnews/wwhats.
  `POST /ads/score` takes the key from `X-Typesafe-Key` (or `typesafeKey`) then file/env, plus
  per-request `thresholds` + `model`; `POST /page/score` (bridge/pages.py, same key lookup) scores
  the page on news-style dimensions for the instant score; `POST /ads/key` persists the key (0600).
- `usage/` (ex cchrome, subtree merge 2026-10-03) — `build_report.py` + `collect/` build
  `dashboard.html` from `report_template.html` (data embedded as `const D=…`). `site_stats.py` reads
  it back for one URL (same `site_key` and category rules as the dashboard). The bridge serves
  `GET /usage`, `GET /usage/site?url=` (extension origins only) and `POST /usage/rebuild`; the side
  panel's usage box (`showUsage` in sidepanel.js) calls them and hides itself when the bridge is down.

- `news/` (ex usefulnews, subtree merge 2026-10-03) — Flask app, port **8805** (8801 is taken by
  another local server now). See `news/CLAUDE.md`. Tests: `cd news && python3 -m unittest test_usefulnews`.
- `shared_rules.py` — `~/.config/bbla/shared-rules.json` = {page, news}. News writes `news` on
  relearn and reads `page` into `memory()["page_rules"]` (in reader_state and profile_hash, never saved
  to news memory). The extension POSTs `page` rules on any `memory.rules` change (storage.onChanged
  in background.js) and passes `newsRules` to `buildMessages`. Bridge: `GET|POST /memory/rules`.
  Tests point `BBLA_SHARED_RULES` at a temp file — keep it that way.
- `run` — bridge + news together.

## Gotchas
- Page access: `activeTab` (granted when the icon is clicked) + host permissions for the AI
  endpoints and localhost; `<all_urls>` is optional and requested from the options page.
- OpenCode Go needs the `x-opencode-session` header; the Zen free tier refuses non-OpenCode clients.
- `[hidden] { display: none !important }` in ui.css is required because labels are `display:flex`.

## Test
`node --test tests/*.test.mjs`. E2E: Playwright `launch_persistent_context(..., channel="chromium",
args=["--disable-extensions-except=…", "--load-extension=…"])` — plain headless doesn't load extensions.
