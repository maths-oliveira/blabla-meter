# Blabla Meter (Chrome/Brave extension)

*Internal name (code, config dirs, storage): `bbla`.*

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Install-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/blabla-meter/emjbfdcigbfojhdipapdjaanlkhcjoai)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-%E2%98%95-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/maths.oliveira)

Reads the page you're on and tells you how much of it is worth your attention:

- **Blabla score 0-100** — instant, via one Jev call (no waiting): how much of the page is
  actually useful to you, with topic + dimension/flag chips explaining why. The one-line verdict,
  Pareto summary and bullshit highlighter below are an on-demand **AI summary & highlights**
  button — you decide when to wait for the slow model.
- **Per-section badges** — each headed section gets its own Jev score as a small circle on the
  page; hover shows its tags (plus any AI insights once the deep dive ran for that section).
  ✕ marks is a toggle (hide / re-apply from cache, never re-runs the AI). The **◉ score**
  picker scores one clicked section and learns its shape for the site — similar cards join
  future scorings automatically (managed under Options → Learned score areas). Picking scores
  the element plus its similars immediately, each with its own badge.
  Stuck? The 🧾 log button downloads a diagnostic file (page extraction + extension answers,
  no keys) to send for debugging.
- The score refreshes when the page body changes under the same URL (hydrating pages, SPA
  navigation); Score waits for the body to settle (thin or still-growing text is re-read
  for ~10 s) and always scores current content, never cache.
- **Pareto summary** — the 20 % of the content that carries 80 % of the value.
- **Bullshit highlighter** — marks sensationalism, clickbait, tragedy-as-entertainment, celebrity and
  political gossip, hate bait, empty speculation, filler, disguised ads, "not actionable for me" —
  right on the page, colour-coded. Click one in the panel to scroll to it.
  When a passage fits no category, the AI proposes a new one and Blabla Meter adds it to its category list
  (editable in the options).
- **Learns from you** — 👍/👎 on the analysis, your own score, a note on why, and ✓/✗ on each
  highlight. Every 5 feedback items the AI distils them into preference rules that go with every
  future analysis. Everything (rules, categories, feedback) is one exportable memory file.

- **Ad-block toggle** (🚫 in the side panel, stays ON across pages/sessions) — hides ads on every
  page while ON. Obvious slots (`div-gpt-ad`, `adsbygoogle`, doubleclick/tabooola iframes…) are
  hidden instantly; ambiguous nodes (sponsored/promo/popup-looking) are judged by **Jev
  (`jev-1.13.0`, TypeSafe)** through the bridge (`POST /ads/score`, `bridge/ads.py`) — the same
  calibrated-probability machinery as the news ranker — and hidden at `is_ad ≥ 0.55`
  (or `≥ 0.35` + disruptive). Without a Jev key it still hides the obvious ones
  (heuristic only). Configure everything in ⚙ Options → **Jev ad-block**: the TypeSafe key
  (sent with each scoring request; “Save key to bridge” also stores it in
  `~/.config/bbla/typesafe.key` for `./run` and the news ranker), the Jev model, and the three
  score thresholds (`hideAt`, `hideAtDisrupt` + `disruptAt`) — no re-scoring needed, the hide
  decision is computed in code. Needs the all-sites permission (⚙ Options → Page access) for automatic
  blocking on pages you haven't clicked the icon on.
- **⛔ Block element picker + reading time & outline** (Unclutter-inspired, all local, no AI) —
  click ⛔ in the side panel, then click any distracting element to hide it on every visit to that
  site (saved per site in ⚙ Options → Blocked elements, works even with 🚫 off, `Esc` cancels).
  Each analysis also shows an estimated reading time and a clickable outline of the page's sections.

Tip: select text before analyzing to analyze only the selection.

- **Time on this site** (ex `~/src/cchrome`, now `usage/`) — when the local bridge is running, the
  side panel shows how much time you spent on the current site (last 7 days, rank, total), its
  category and usefulness score from the usage report, a ↻ update button and a link to the full
  report at `http://127.0.0.1:8804/usage`.

- **Useful news** (ex `~/src/usefulnews`, now `news/`) — a news reader that ranks articles by how
  useful they are to you (📰 in the side panel → `http://127.0.0.1:8805`). The preference rules each
  side learns from your 👍/👎 are **shared**: page feedback in the extension shapes the news ranking
  and news feedback shapes the page score (`shared_rules.py`, via the bridge, file
  `~/.config/bbla/shared-rules.json`).

Start everything local with `./run` (bridge :8804 + news :8805); `./run bridge` or `./run news` for one.

## Usage report (`usage/`)

Brave desktop history + Android app usage + phone Brave history → `usage/dashboard.html` (time per
site/app, by hour and day, categories with a usefulness score, recommendations).

```bash
python3 usage/build_report.py            # or the ↻ update button / POST /usage/rebuild on the bridge
python3 usage/build_report.py --collect  # also pull a fresh usagestats snapshot from the phone (adb)
```

Categories, regex rules and scores: `usage/categories.json`. Private data stays local and git-ignored
(`usage/brave_history.db`, `usage/data/`, `usage/dashboard.html`).

## Install

### Chrome Web Store (recommended)

[Install Blabla Meter](https://chromewebstore.google.com/detail/blabla-meter/emjbfdcigbfojhdipapdjaanlkhcjoai) — works in Chrome, Brave, Edge and other Chromium browsers. No build step, no helper needed for the AI summary; the optional local helper adds the instant score, section badges and ad-block.

### From source (development)

Brave is Chromium under the hood, so the MV3 extension loads as-is — no build step.

1. `brave://extensions` → enable **Developer mode** (top right).
2. Either **Load unpacked** → pick `bbla/extension/`, or drag-and-drop the packaged zip:
   `./extension/build_zip.sh` → `blabla-meter-<version>.zip`.
3. Click the Blabla Meter icon (or **Alt+B**) on any page → the side panel opens → **Score this page**.
   Optional: pin the icon via the 🧩 puzzle piece → 📌.
4. ⚙ Options → choose the AI provider:

| provider | what you need |
|---|---|
| OpenCode Zen (default) | an OpenCode Zen API key with credit |
| OpenCode Go | an OpenCode Go subscription key |
| OpenRouter | an OpenRouter key (`openrouter/free` model works without credit) |
| Anthropic (Claude) | an Anthropic API key (default `claude-opus-5-5`; `claude-haiku-5-5` is cheapest) |
| OpenAI | an OpenAI API key (default `gpt-5.4-mini`) |
| Google Gemini | a Google AI Studio key — free tier (default `gemini-flash-latest`) |
| Groq | a Groq key — free tier (default `openai/gpt-oss-120b`) |
| Mistral | a Mistral key — free tier (default `mistral-small-latest`) |
| DeepSeek | a DeepSeek key (default `deepseek-chat`) |
| **Ollama** — free, local | Ollama running with a pulled model; type its name in Model. A 403 means start Ollama with `OLLAMA_ORIGINS=chrome-extension://*` |
| **Local bridge** — free | the `opencode` CLI installed; run `python3 bridge/bridge.py` (port 8804). Only the Chrome Web Store extension ID is accepted; for an unpacked build, start it with `BBLA_EXTENSION_IDS=<your-extension-id>` |
| Custom | any OpenAI-compatible endpoint (LM Studio, vLLM, LiteLLM…) |

Each provider keeps its own key, so switching providers never sends one vendor's key to another.
Providers outside the built-in host list ask once for access to their API domain when you press Save.

OpenCode's free models are only served to the OpenCode app itself, so the extension can't call them
directly — the bridge runs them through your installed `opencode`. Configure the bridge's own
provider/model in `~/.config/bbla/ai.json` (same format as the other ~/src apps).

Keys are stored in `chrome.storage.local` of your browser profile only (the TypeSafe key is
optionally also saved to `~/.config/bbla/typesafe.key` via ⚙ Options → Jev ad-block → Save key
to bridge).

Jev thresholds live in the same options card and travel with every `POST /ads/score` call, so the
bridge needs no restart or config edit after you move a slider.

## Privacy

No analytics, no servers of ours: page text goes only to the AI provider you choose. Full policy:
[PRIVACY.md](PRIVACY.md). Chrome Web Store listing text: [store/listing.md](store/listing.md).

## Tests

```bash
node --test tests/*.test.mjs
```

End-to-end was verified with Playwright loading the unpacked extension in Chromium against the bridge.

## License

MIT — see [LICENSE](LICENSE). Copy it, fork it, ship it.

## Support

If Blabla Meter saves you time, you can [buy me a coffee ☕](https://buymeacoffee.com/maths.oliveira) — also linked
from the side panel header (☕) and the bottom of ⚙ Options. If the coffee page is unavailable, email
[so.matheus@proton.me](mailto:so.matheus@proton.me) or [open an issue](https://github.com/maths-oliveira/blabla-meter/issues).
