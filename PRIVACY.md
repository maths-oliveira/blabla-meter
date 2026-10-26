# Blabla Meter — Privacy Policy

*Effective 25 October 2026*

Blabla Meter is a browser extension that rates how useful a web page is, summarises it and highlights
low-value passages. It is open source: <https://github.com/maths-oliveira/blabla-meter>.

**The short version:** Blabla Meter has no servers of its own. It does not collect analytics, track
you, show ads or sell anything. Page content, ad-candidate descriptions and the feedback you choose
to give leave your computer only to reach the AI or scoring service **you** chose in the options (or
the optional local bridge), for the action you asked for.

## What is sent, and to whom

### To the AI provider you configure

The instant score runs automatically when you open the side panel and uses Jev through the optional
local helper; it does not call the generative AI provider. The **AI summary & highlights** deep dive
runs only when you click it. When you use the deep dive, Blabla Meter sends to your chosen provider:

- the page's title, address (URL) and text: up to about 14,000 characters, or only the text you
  selected;
- your learned preferences: the rules distilled from your feedback, your highlight categories, and
  your 12 most recent feedback items (page titles shortened to 80 characters, scores, votes, notes
  and highlight corrections).

When feedback triggers a relearn (every 5 new items), it sends the last 60 feedback items instead:
page titles shortened to 100 characters, site host, scores, votes, notes and highlight corrections.
A relearn does not send the current page text. This is how the preference rules are updated.

The provider is whichever one you picked in ⚙ Options: Anthropic, OpenAI, Google Gemini, Groq,
Mistral, DeepSeek, OpenRouter, OpenCode, a custom endpoint you entered, or a program on your own
computer (Ollama or the Blabla Meter local helper). That provider's own privacy policy governs what
it does with the request. Your API key for that provider is sent only to that provider, to
authenticate the request.

### To the optional local helper on your computer

If you run the optional local helper from the GitHub repository (it listens on `127.0.0.1`, your
own machine), the extension also sends it:

- for the **instant score** and the **◉ score** picker: the page's site name, title, a text excerpt
  of up to 2,000 characters, up to 8 section excerpts, and your preference rules;
- for the **🚫 ad-block** toggle, while it is on: short descriptions of elements that look like ads
  (tag, class names, size, up to 300 characters of their text) plus the site name and page title, on
  every page you visit;
- your learned preference rules (shared with the helper's news reader), and the address of the
  current page to look up your time on that site in your own local usage report.

The helper forwards the scoring requests to TypeSafe (the Jev model; a separate paid service)
using the TypeSafe key you provide, and runs any AI requests through the provider configured on
your computer. The helper
defaults to the OpenCode Zen API. Its optional `cli` mode runs the installed OpenCode agent and may
send prompts to OpenCode's hosted free models; that mode is disabled unless you set
`BBLA_ALLOW_CLI=1`, and it has local tools. Without the helper, none of this happens; obvious ad
slots are still hidden locally.

## What is stored on your device

Everything below stays in your browser's extension storage and is never sent to the developer:

- **Settings:** chosen provider, model, endpoint URLs, API keys (kept separately per provider), the
  TypeSafe key, ad-block thresholds, and the on/off switch.
- **Learned memory:** your feedback (votes, scores, notes, highlight corrections, with the page title,
  site and address they refer to), the preference rules learned from it, and your highlight
  categories.
- **Per-site choices:** elements you blocked with ⛔ and areas you taught with ◉.
- **Session cache:** recent analyses and a diagnostic log. These are cleared when the browser closes.
  The log is saved to a file only when you click 🧾; it is filtered for API keys before saving.

The optional local helper stores its own files on your computer, outside browser storage:
`~/.config/bbla/ai.json`, `typesafe.key`, `shared-rules.json`, and the usage report. These are not
removed when you uninstall the extension.

You can export, edit or reset the learned memory in ⚙ Options → Memory file, and remove blocked
elements and score areas there too. Uninstalling the extension deletes its browser storage. It does
not delete files you exported or the helper's files above; delete those manually if you want them
gone.

## Permissions and why they are needed

- **activeTab, scripting:** read the page you are analysing and draw highlights and score badges on it.
- **tabs:** notice when you switch tabs or a page changes, so the score refers to the page in front of you.
- **sidePanel:** the extension's interface lives in the browser side panel.
- **storage:** keep the settings and memory described above.
- **Access to opencode.ai, openrouter.ai, 127.0.0.1 and localhost:** reach those AI providers and
  programs on your own computer. Other providers' addresses are requested only when you select them.
- **Optional access to all sites:** analyse pages and apply the ad-block without clicking the toolbar
  icon first. It is requested only if you turn it on in the options, and can be revoked there.

## What Blabla Meter does not do

- No analytics, telemetry, tracking pixels or crash reporting.
- No accounts, and no data sent to the developer.
- No selling, renting or sharing of data, and no use of it for advertising, credit or lending decisions.
- No remote code: everything the extension runs ships inside it.

Blabla Meter's use of information complies with the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements.

## Children

Blabla Meter is not directed at children under 13 and does not knowingly process their data.

## Changes

Changes to this policy are published in this file; its history is visible in the repository.

## Contact

Open an issue at <https://github.com/maths-oliveira/blabla-meter/issues>.
