# Chrome Web Store listing — Blabla Meter

Copy-paste source for the developer dashboard. Keep in sync with `extension/manifest.json` and `PRIVACY.md`.

## Store listing tab

**Name** (from the manifest): Blabla Meter

**Summary** (from the manifest, 126/132 characters):
How much of this page is useful? Blabla score, summary and bullshit highlighter with your own AI (Claude, GPT, Gemini, local).

**Category:** Productivity → Tools

**Language:** English

**Description:**

```
Is this page worth your time? Blabla Meter reads it and tells you.

● Blabla score 0–100: how much of the page is actually useful to you, with a one-line verdict: worth reading or not.
● Pareto summary: the 20% of the content that carries 80% of the value, in a few bullets.
● Bullshit highlighter: marks sensationalism, clickbait, tragedy-as-entertainment, celebrity and political gossip, outrage bait, empty speculation, filler and disguised ads right on the page, colour-coded. Click one in the panel to jump to it.
● Learns from you: thumbs up or down, your own score, a note on why, and ✓/✗ on each highlight. Every 5 feedback items it distils them into preference rules used in every future analysis. Export, edit or reset them any time.
● Unclutter tools: block any distracting element on a site with one click (remembered per site), plus reading time and a clickable outline of the page's sections.
● Ad hiding: hides obvious ad slots on every page while the toggle is on.

BRING YOUR OWN AI
Use the provider you already have: Anthropic (Claude), OpenAI, Google Gemini, Groq, Mistral, DeepSeek, OpenRouter or OpenCode with your own API key, or keep everything on your computer with Ollama. Gemini, Groq and Mistral have free tiers; Ollama is free and fully local.

PRIVATE BY DESIGN
No account, no analytics, no tracking, no servers of ours. Page text goes only to the AI provider you pick, and only for the page you asked about. Keys and memory stay in your browser.

POWER USERS
The open-source local helper (GitHub, link below) adds an instant score with explaining chips, per-section score badges and smarter ad detection with the Jev model, free OpenCode models, a news reader ranked by your preferences, and a "time on this site" report. The extension works without it.

Open source: https://github.com/maths-oliveira/blabla-meter
```

**Screenshots** (1280×800, ready in `store/screenshots/`, upload in this order):
1. `1-score-and-highlights.png`: page with highlights and section badges, panel with score, chips, verdict and Pareto summary.
2. `2-highlight-list.png`: highlight list with ✓/✗ feedback and the feedback box.
3. `3-choose-your-ai.png`: ⚙ Options → AI provider (Anthropic selected).
4. `4-section-badges-outline.png`: per-section badges next to the AI summary.
5. `5-block-picker.png`: the ⛔ block picker on a sponsored box.

They show real output (the local bridge's free model + Jev) on a fictional article, `store/screenshots/demo-article.html`.

**Small promo tile** (440×280, optional): the icon, "Blabla Meter" and the line "Is this page worth your time?"

## Privacy practices tab

**Single purpose:**
Rate how useful the web page you are viewing is, summarise its valuable parts and highlight low-value content, using an AI provider the user chooses.

**Permission justifications:**

| Permission | Justification |
|---|---|
| activeTab | Read the text of the page the user asks to analyse, after they click the toolbar icon. |
| scripting | Inject the functions that extract the page text and draw highlights, score badges and the element picker on the page. |
| tabs | Know which page the side panel refers to and refresh the score when the user switches tabs or the page changes. |
| sidePanel | The extension's whole interface lives in the side panel. |
| storage | Keep the user's settings, API keys, learned preferences and per-site choices locally. |
| Host permissions (opencode.ai, openrouter.ai, 127.0.0.1, localhost) | Send the analysis request to the AI provider the user selected, or to AI programs running on the user's own computer (Ollama, the optional local helper). Other providers' hosts are requested only when the user selects them. |
| Optional host permission (all URLs) | Requested only if the user enables it in the options: analyse pages and hide ads without clicking the toolbar icon on each site, and reach a custom AI endpoint the user entered. |

**Remote code:** No, I am not using remote code.

**Data usage**, check:
- **Website content**: page text and title are sent to the user's chosen AI provider for analysis.
- **Web history**: the address of the analysed page is part of that request, and feedback stored locally references page addresses.
- **Authentication information**: the user's own API keys are stored locally and sent only to the matching provider to authenticate. Checking this is the cautious reading of the policy.

Leave unchecked: personally identifiable information, health, financial and payment, personal communications, location, user activity (no clicks, keystrokes or mouse tracking are collected).

**Certify all three:**
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://github.com/maths-oliveira/blabla-meter/blob/main/PRIVACY.md

## Distribution tab

Visibility: Public. Regions: all.

## Upload

`./extension/build_zip.sh --out .` → `blabla-meter-<version>.zip`. Bump `version` in `extension/manifest.json` before each new upload.
