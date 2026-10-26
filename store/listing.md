# Chrome Web Store listing — Blabla Meter

Copy-paste source for the developer dashboard. Keep in sync with `extension/manifest.json` and `PRIVACY.md`.

> The rejected submission was flagged for keyword spam because its description listed many AI
> providers by name. This copy keeps the same features but removes provider/model name lists.
> 0.9.3 is pending review (submitted Oct 24, 2026). This file is now the **0.9.4 draft**; it has
> not been submitted and must not overwrite the pending 0.9.3 package.

## Store listing tab

**Name** (from the manifest): Blabla Meter

**Summary** (from the manifest, 123/132 characters):
How much of this page is useful? Blabla score, summary and bullshit highlighter with your own AI provider or a local model.

**Category:** Tools

**Language:** English

**Homepage:** https://github.com/maths-oliveira/blabla-meter

**Support:** https://github.com/maths-oliveira/blabla-meter/issues

**Description:**

```
Is this page worth your time? Blabla Meter reads it and tells you.

● Blabla score 0–100: how much of the page is actually useful to you (the instant score needs a separate TypeSafe scoring key; TypeSafe is a paid service).
● AI summary & highlights, on demand: a one-line verdict, the 20% of the content that carries 80% of the value in a few bullets, and a colour-coded bullshit highlighter. Marks sensationalism, clickbait, tragedy-as-entertainment, celebrity and political gossip, outrage bait, empty speculation, filler and disguised ads right on the page. Click one in the panel to jump to it.
● Learns from you: thumbs up or down, your own score, a note on why, and ✓/✗ on each highlight. Every 5 feedback items it distils them into preference rules used in every future analysis; this relearn can run in the background. Export, edit or reset them any time.
● Unclutter tools: block any distracting element on a site with one click (remembered per site), plus reading time and a clickable outline of the page's sections.
● Ad hiding: hides obvious ad slots on pages the extension can access while the toggle is on (all-sites access makes it automatic); with a scoring key, the optional local helper can judge the ambiguous ones too.

BRING YOUR OWN AI
Use the AI account or local model you already have: choose a provider in Options and paste your key or endpoint. Some providers offer free tiers, and a local model keeps the text on your computer. The AI summary & highlights only runs when you click it.

PRIVATE BY DESIGN
No account, no analytics, no tracking, no servers of ours. Page text goes only to the AI provider you pick, for the page you ask it to score or analyse, or to the optional local helper on your computer for instant scoring. The helper forwards those requests to the provider configured on your computer (it is not necessarily local inference). Ad-block candidate descriptions go to TypeSafe through that helper when it is running. Feedback you give may also be sent to that provider to learn your preferences. Keys and learned memory are stored in your browser; if you use “Save key to bridge”, the TypeSafe key is also written to `~/.config/bbla/typesafe.key` on your computer. Requests run only for the features you use: the instant score and ad-block scan can run automatically, while the AI summary runs when you click it.

POWER USERS
The open-source local helper (GitHub, link below) adds an instant score with explaining chips, per-section score badges and smarter ad detection (a separate scoring key is needed for the instant score and ad decisions), an optional opt-in CLI mode for free models, a news reader ranked by your preferences, and a "time on this site" report. The extension works without it.

Open source: https://github.com/maths-oliveira/blabla-meter
```

**Screenshots** (1280×800, ready in `store/screenshots/`, upload in this order):
1. `1-score-and-highlights.png`: page with highlights and section badges, panel with score, chips, verdict and Pareto summary.
2. `2-highlight-list.png`: highlight list with ✓/✗ feedback and the feedback box.
3. `3-choose-your-ai.png`: ⚙ Options → AI provider picker.
4. `4-section-badges-outline.png`: per-section badges next to the AI summary.
5. `5-block-picker.png`: the ⛔ block picker on a sponsored box.

They show real output (the local bridge + Jev) on a fictional article, `store/screenshots/demo-article.html`.

**Small promo tile** (440×280, optional): the icon, "Blabla Meter" and the line "Is this page worth your time?"

## Privacy practices tab

**Single purpose:**
Help the user decide whether the web page they are viewing is worth their time: rate and summarise its useful parts, highlight low-value content, and reduce distractions on that page (ad hiding, element blocking and a reading outline), using an AI provider the user chooses.

**Permission justifications:**

| Permission | Justification |
|---|---|
| activeTab | Read the text of the page the user asks to analyse, after they click the toolbar icon. |
| scripting | Inject the functions that extract the page text and draw highlights, score badges and the element picker on the page. |
| tabs | Know which page the side panel refers to and refresh the score when the user switches tabs or the page changes. |
| sidePanel | The extension's whole interface lives in the side panel. |
| storage | Keep the user's settings, API keys, learned preferences and per-site choices locally. |
| Host permissions (opencode.ai, openrouter.ai, 127.0.0.1, localhost) | Send the analysis request to the AI provider the user selected, or to local AI programs on the user's own computer (the optional local helper). Other providers' hosts are requested only when the user selects them. |
| Optional host permission (all URLs) | Requested only if the user enables it in the options: analyse pages and hide ads without clicking the toolbar icon on each site, and reach a custom AI endpoint the user entered. |

**Remote code:** No, I am not using remote code.

**Data usage**, check:
- **Website content**: page text and title are sent to the user's chosen AI provider for analysis; feedback notes and highlight corrections may be sent to that provider when the preference memory relearns. When the optional helper is running and ad-block is on, short descriptions of ad-like elements are sent through the helper to TypeSafe for scoring.
- **Web history**: the address of the analysed page is part of that request, and feedback stored locally references page addresses.
- **Authentication information**: the user's own API keys and TypeSafe scoring key are stored locally and sent only to the matching provider to authenticate. Checking this is the cautious reading of the policy.

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

For 0.9.4, use the copy above, keep the Support/Homepage URLs, and make sure the listing says the
instant score needs a separate scoring key while the AI summary is on demand. Before submitting,
push the updated `PRIVACY.md` to `main` (the privacy URL above must not point at stale text) and
verify the public raw URL. 0.9.3 remains the pending submission; do not overwrite its package or
resubmit it with this draft. Do not reuse the old provider-name list.
