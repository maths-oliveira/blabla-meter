const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

import { DEFAULT_SETTINGS, PROVIDERS, keyFor } from "./lib/ai.js";

let tab = null;
let fast = null;      // instant Jev score (no generative AI)
let analysis = null;  // on-demand LLM deep dive (verdict, pareto, highlights)
let vote = 0;
let bridgeUp = null;        // null until checked; false = local helper not running
let hasProvider = true;     // can the configured AI provider answer right now?
let primaryAction = "fast"; // fast | deep | setup

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      res?.ok ? resolve(res.result) : reject(new Error(res?.error || "no answer"));
    });
  });
}

function status(msg, error = false) {
  $("status").hidden = !msg;
  $("status").textContent = msg || "";
  $("status").classList.toggle("error", error);
}

async function currentTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}

async function bridgeBase() {
  const { settings } = await chrome.storage.local.get("settings");
  return (((settings || {}).bridgeUrl) || DEFAULT_SETTINGS.bridgeUrl).replace(/\/+$/, "");
}

/* The instant score/badges need the optional local helper; the news reader is
   another local app. Check both so the panel doesn't offer dead actions. */
async function checkBridge() {
  try {
    const r = await fetch((await bridgeBase()) + "/health", { signal: AbortSignal.timeout(1500) });
    bridgeUp = r.ok;
  } catch {
    bridgeUp = false;
  }
  try {
    // no-cors: the news app has no CORS headers; resolving at all means it is up.
    await fetch("http://127.0.0.1:8805/", { mode: "no-cors", signal: AbortSignal.timeout(1200) });
    $("news-link").hidden = false;
  } catch {
    $("news-link").hidden = true;
  }
  return bridgeUp;
}

async function providerReady() {
  const { settings } = await chrome.storage.local.get("settings");
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const p = PROVIDERS[s.provider] || PROVIDERS.zen;
  if (s.provider === "bridge") return bridgeUp === true;
  if (s.provider === "ollama") return !!s.model;
  if (s.provider === "custom") return !!s.baseUrl;
  return !p.needsKey || !!keyFor(s);
}

function setPrimary(action, label, title = "") {
  primaryAction = action;
  $("btn-analyze").textContent = label;
  $("btn-analyze").title = title;
}

async function refreshSetup() {
  hasProvider = await providerReady();
  const bridgeDown = bridgeUp === false;
  const show = !hasProvider || bridgeDown;
  $("setup").hidden = !show;
  if (show) {
    $("setup-msg").textContent = !hasProvider
      ? "Pick an AI provider in Options, paste your key, and come back. Gemini, Groq, Mistral and OpenRouter have free tiers; Ollama runs locally."
      : "The instant score and section badges need the optional local helper. AI summary & highlights works with your configured provider.";
    $("setup-open").textContent = "⚙ Options";
    $("setup-key").hidden = hasProvider;
  }
  if (!hasProvider) setPrimary("setup", "Set up your AI", "Choose an AI provider in Options");
  else if (bridgeDown) setPrimary("deep", "AI summary & highlights", "The instant score needs the local helper; this runs the AI deep dive.");
  else setPrimary("fast", "Score this page", "");
  // Don't show a second, identical deep-dive button when the primary is already it.
  if (primaryAction !== "fast") $("btn-deep").hidden = true;
}

async function onTabChange() {
  const t = await currentTab();
  if (!t || (tab && t.id === tab.id && t.url === tab.url)) return;
  tab = t;
  $("page-title").textContent = t.title || t.url || "";
  if (!(await refreshPower())) {
    status("Blabla Meter is off — turn it on with the ⏻ toggle.");
    $("result").hidden = true;
    $("deep").hidden = true;
    $("btn-deep").hidden = true;
    return;
  }
  showUsage(t.url);
  await refreshSetup();
  $("result").hidden = true;
  $("deep").hidden = true;
  $("btn-deep").hidden = true;
  fast = null;
  analysis = null;
  marksOn = true;
  paintMarks();
  if (pickListener) { chrome.storage.onChanged.removeListener(pickListener); pickListener = null; }
  status("");
  // show the cached fast score for this URL, if any (no AI call)
  const fkey = "pagescore:" + (t.url || "").split("#")[0];
  const fcached = (await chrome.storage.session.get(fkey))[fkey];
  if (fcached) {
    fast = fcached;
    await showScore(fast);
    const dkey = "analysis:" + (t.url || "").split("#")[0];
    const dcached = (await chrome.storage.session.get(dkey))[dkey];
    if (dcached) {
      analysis = dcached;
      await showDeep(analysis);
    }
    // Same URL but a different body (hydration, SPA navigation, live feed):
    // re-score instead of showing a stale number.
    if (hasProvider && bridgeUp !== false) {
      try {
        const st = await send({ type: "pageStats", tabId: t.id });
        const old = fast.chars || 0;
        if (old > 0 && Math.abs(st.chars - old) / old > 0.35) {
          status("Page content changed — updating score…");
          await scoreFast();
        }
      } catch {}
    }
  } else if (hasProvider && bridgeUp !== false) {
    scoreFast();
  }
  // re-apply ad-blocking on the new page while the toggle stays ON
  try {
    const st = await send({ type: "adsGet" });
    adsOn = !!st.enabled;
    paintAds(null);
    if (adsOn && /^https?:/.test(t.url || "")) {
      send({ type: "adsRun", tabId: t.id }).then(paintAds, (e) => { $("ads-status").textContent = e.message; });
    }
  } catch {}
}

/* Time spent on this site, from the usage report served by the local bridge (usage/, ex cchrome). */
const fmtTime = (s) => s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, "0")}` : `${Math.round(s / 60)} min`;
const fmtDay = (iso) => iso.slice(8, 10) + "/" + iso.slice(5, 7);
async function showUsage(url) {
  const box = $("usage");
  box.hidden = true;
  if (!/^https?:/.test(url || "")) return;
  const base = await bridgeBase();
  let u;
  try {
    const r = await fetch(`${base}/usage/site?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(2500) });
    u = await r.json();
  } catch { return; }   // bridge not running: no usage box
  if (tab?.url !== url) return;
  if (!u.ok) {
    box.innerHTML = `<span class="muted small">⏱ ${esc(u.error)}</span>`;
    box.hidden = false;
    return;
  }
  const color = u.score >= 60 ? "var(--good)" : u.score >= 35 ? "var(--mid)" : "var(--bad)";
  box.innerHTML = `<div class="row"><b>⏱ ${esc(u.key)}</b><span class="chip" style="--c:${color}" title="usefulness of this category (usage report)">${esc(u.category)} · ${Math.round(u.score)}/100</span></div>` +
    (u.total ? `<div class="usage-nums"><span><b>${fmtTime(u.week)}</b> last 7 days${u.rank_week ? ` · #${u.rank_week}` : ""}</span>` +
      `<span><b>${fmtTime(u.total)}</b> since ${fmtDay(u.since)}</span></div>`
      : `<div class="muted small">No time recorded on this site.</div>`) +
    `<div class="row small muted"><span class="grow">report until ${fmtDay(u.until)}</span>` +
    `<button type="button" id="usage-rebuild" class="link">↻ update</button><a href="${base}/usage" target="_blank">full report ↗</a></div>`;
  box.hidden = false;
  $("usage-rebuild").onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = "updating…";
    try { await fetch(`${base}/usage/rebuild`, { method: "POST" }); } catch {}
    if (tab?.url === url) showUsage(url);
  };
}

/* Stage 1 — instant Jev score: one typed-judgment call, no generative AI.
   Runs automatically when the panel opens. */
async function scoreFast() {
  if (!extOn) { status("Blabla Meter is off — turn it on with the ⏻ toggle."); return; }
  tab = await currentTab();
  if (!/^https?:/.test(tab?.url || "")) return;
  $("btn-analyze").disabled = true;
  status("Scoring with Jev…");
  try {
    fast = await send({ type: "pageScore", tabId: tab.id });
    await showScore(fast);
    status("");
  } catch (e) {
    if (e.message === "NO_JEV_KEY") {
      // No TypeSafe key: fall back to the full AI analysis (old behavior).
      status("The instant score needs a TypeSafe/Jev key — running the full AI analysis instead (⚙ Options → Jev ad-block).");
      await analyze(true);
      status("");
    } else if (e.message === "NO_BRIDGE") {
      // Store installs usually run without the local bridge: not an error.
      bridgeUp = false;
      await refreshSetup();
      status(hasProvider
        ? "The instant score needs the optional local helper. Use “AI summary & highlights”."
        : "The instant score needs the optional local helper. Set up a provider in ⚙ Options.");
    } else {
      status(e.message + await autoLog("score-failed", e), true);
      $("btn-deep").hidden = false; // the deep dive may still work via a cloud provider
    }
  } finally {
    $("btn-analyze").disabled = false;
  }
}

/* Stage 2 — on-demand LLM deep dive: verdict prose, pareto, highlights.
   Only runs when the reader clicks; they decide when to wait. */
async function deepDive() {
  if (!extOn) { $("deep-status").textContent = "Blabla Meter is off — turn it on with the ⏻ toggle."; return; }
  tab = await currentTab();
  $("btn-deep").disabled = true;
  $("deep-status").textContent = "Asking the AI… (10–60 s)";
  try {
    analysis = await send({ type: "analyze", tabId: tab.id, force: true });
    await showDeep(analysis);
    $("deep-status").textContent = "";
  } catch (e) {
    $("deep-status").textContent = e.message + await autoLog("deep-dive-failed", e);
  } finally {
    $("btn-deep").disabled = false;
  }
}

async function analyze(force = true) {
  if (!extOn) { status("Blabla Meter is off — turn it on with the ⏻ toggle."); return; }
  tab = await currentTab();
  $("btn-analyze").disabled = true;
  status(force ? "Reading the page and asking the AI… (10–60 s)" : "Loading…");
  try {
    analysis = await send({ type: "analyze", tabId: tab.id, force });
    if (!fast) {
      fast = { score: analysis.score, tags: null, url: analysis.url, title: analysis.title,
        chars: analysis.chars, words: analysis.words || 0, headings: analysis.headings || [], ms: analysis.ms };
    }
    await showScore(fast);
    await showDeep(analysis);
    status("");
  } catch (e) {
    status(e.message + await autoLog("analyze-failed", e), true);
  } finally {
    $("btn-analyze").disabled = false;
  }
}

async function showScore(f) {
  const { memory } = await chrome.storage.local.get("memory");
  const cats = Object.fromEntries((memory?.categories || []).map((c) => [c.id, c]));
  $("result").hidden = false;
  $("deep").hidden = true;
  const s = f.score;
  $("score").textContent = s ?? "?";
  const color = s == null ? "var(--mut)" : s >= 60 ? "var(--good)" : s >= 35 ? "var(--mid)" : "var(--bad)";
  $("gauge").style.setProperty("--p", s ?? 0);
  $("gauge").style.setProperty("--c", color);
  if (f.tags) {
    const pretty = (t) => String(t || "other").replace(/_/g, " ");
    const chips = [`<span class="chip" style="--c:#0ea5e9">≈ ${esc(pretty(f.tags.topic))}</span>`];
    for (const d of f.tags.scores || []) {
      chips.push(`<span class="chip" style="--c:var(--mut)" title="${esc(d.label)}">${esc(d.label)} ${d.value.toFixed(1)}</span>`);
    }
    for (const g of f.tags.flags || []) {
      chips.push(`<span class="chip" style="--c:${cats[g.cat]?.color || "#999"}" title="Jev probability ${g.p.toFixed(2)}">${esc(g.label)}</span>`);
    }
    $("score-tags").innerHTML = chips.join("");
  } else {
    $("score-tags").innerHTML = '<span class="muted small">full AI analysis</span>';
  }
  $("meta").textContent = `${Math.round(f.chars / 1000)}k chars · ${(f.ms / 1000).toFixed(0)} s`
    + (f.model ? ` · ${f.model}` : "") + (f.blocksCached ? ` · ${f.blocksCached} reused` : "");
  // Unclutter-style reading time + outline (from the extracted page, no AI needed).
  const mins = Math.max(1, Math.round((f.words || f.chars / 6) / 200));
  const heads = f.headings || [];
  $("outline-sum").textContent = `⏱ ~${mins} min read · ${heads.length ? heads.length + " sections" : "no sections"}`;
  $("outline-box").open = false;
  $("outline").innerHTML = heads.map((h) =>
    `<li data-hid="${esc(h.id)}" style="margin-left:${(h.level - 1) * 10}px">${esc(h.text)}</li>`).join("");
  $("btn-deep").hidden = primaryAction !== "fast";
  $("deep-status").textContent = "";
  let badges = 0;
  if (tab) badges = await send({ type: "showBlocks", tabId: tab.id, url: f.url }).catch(() => 0);
  $("meta").textContent += badges > 0 ? ` · ${badges} section badges`
    : (f.blockScores?.length ? " · badges failed — see 🧾 log" : " · no scorable sections");
  marksOn = true;
  paintMarks();
}

async function showDeep(a) {
  const { memory } = await chrome.storage.local.get("memory");
  const cats = Object.fromEntries((memory?.categories || []).map((c) => [c.id, c]));
  $("deep").hidden = false;
  $("verdict").textContent = a.verdict;
  $("pareto").innerHTML = a.pareto.map((p) => `<li>${esc(p)}</li>`).join("") || '<li class="muted">Nothing worth keeping.</li>';
  const found = new Set(a.found || []);
  $("hl-count").textContent = a.highlights.length ? `${found.size}/${a.highlights.length} marked on the page` : "none";
  const used = [...new Set(a.highlights.map((h) => h.category))];
  $("legend").innerHTML = used.map((id) => `<span class="chip" style="--c:${cats[id]?.color || "#999"}" title="${esc(cats[id]?.desc)}">${esc(cats[id]?.name || id)}</span>`).join("");
  $("highlights").innerHTML = a.highlights.map((h, i) => `
    <li data-i="${i}" class="${found.has(i) ? "" : "missing"}" title="${found.has(i) ? "click to scroll to it" : "not found verbatim on the page"}">
      <q style="--c:${cats[h.category]?.color || "#999"}">${esc(h.quote)}</q>
      <span class="why">${esc(cats[h.category]?.name || h.category)} — ${esc(h.why)}</span>
      <span class="acts"><button type="button" data-hv="right" title="right call">✓</button><button type="button" data-hv="wrong" title="not bullshit">✗</button></span>
    </li>`).join("") || '<li class="muted">No bullshit found.</li>';
  vote = 0;
  $("fb-up").classList.remove("on");
  $("fb-down").classList.remove("on");
  $("fb-score").value = "";
  $("fb-note").value = "";
  $("fb-saved").textContent = "";
  if (tab && fast) send({ type: "showBlocks", tabId: tab.id, url: fast.url }).catch(() => {});
  marksOn = true;
  paintMarks();
}

async function sendFeedback(extra = {}) {
  if (!analysis) return;
  const userScore = $("fb-score").value === "" ? null : Math.max(0, Math.min(100, +$("fb-score").value));
  const entry = {
    url: analysis.url, host: new URL(analysis.url).host, title: analysis.title, modelScore: fast?.score ?? analysis.score,
    vote, userScore, note: $("fb-note").value.trim(), ...extra,
  };
  try {
    const memory = await send({ type: "feedback", entry });
    $("fb-saved").textContent = `saved ✓ (${memory.feedback.length} feedback items in memory)`;
  } catch (e) {
    $("fb-saved").textContent = e.message;
  }
}

$("btn-analyze").onclick = () => {
  if (primaryAction === "deep") return deepDive();
  if (primaryAction === "setup") return chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
  return scoreFast();
};
$("btn-deep").onclick = () => deepDive();
$("btn-clear").onclick = async () => {
  if (!extOn) return; // power button already cleared the page when switching off
  tab = await currentTab();
  $("btn-clear").disabled = true;
  try {
    if (marksOn) {
      await send({ type: "clear", tabId: tab.id }).catch(() => {});
      marksOn = false;
    } else {
      // re-apply the cached marks; never runs the AI
      await send({ type: "restoreMarks", tabId: tab.id, url: tab.url }).catch(() => {});
      marksOn = true;
    }
  } finally {
    $("btn-clear").disabled = false;
    paintMarks();
  }
};
let pickListener = null;
$("btn-score").onclick = async () => {
  if (!extOn) { $("ads-status").textContent = "Blabla Meter is off — turn it on with the ⏻ toggle."; return; }
  tab = await currentTab();
  if (!/^https?:/.test(tab?.url || "")) return;
  const key = "scorepicked:" + new URL(tab.url).host;
  await chrome.storage.session.remove(key).catch(() => {});
  if (pickListener) chrome.storage.onChanged.removeListener(pickListener);
  pickListener = (changes, area) => {
    if (area !== "session" || !changes[key]) return;
    const v = changes[key].newValue;
    if (!v) return;
    if (v.scoring) { $("ads-status").textContent = "⏳ Scoring section… (Jev, a few seconds)"; return; }
    chrome.storage.onChanged.removeListener(pickListener);
    pickListener = null;
    if (v.error) { $("ads-status").textContent = v.error; return; }
    $("ads-status").textContent = `Section ${v.score} · ${(v.tags || []).slice(1, 4).join(" · ")}` +
      (v.similar ? ` · +${v.similar} similar badged` : "") + ` · learned (${v.learned} areas)`;
  };
  chrome.storage.onChanged.addListener(pickListener);
  $("ads-status").textContent = "scorer on: click a section… (Esc cancels)";
  try { await send({ type: "pick", tabId: tab.id, mode: "score" }); }
  catch (e) { $("ads-status").textContent = e.message; }
};
$("btn-pick").onclick = async () => {
  if (!extOn) { $("ads-status").textContent = "Blabla Meter is off — turn it on with the ⏻ toggle."; return; }
  tab = await currentTab();
  $("ads-status").textContent = "picker on: click an element… (Esc cancels)";
  try { await send({ type: "pick", tabId: tab.id }); }
  catch (e) { $("ads-status").textContent = e.message; }
};
$("outline").onclick = async (e) => {
  const li = e.target.closest("li[data-hid]");
  if (!li || !tab) return;
  send({ type: "focusHeading", tabId: tab.id, id: li.dataset.hid }).catch(() => {});
};
$("btn-log").onclick = async () => {
  try {
    await downloadLog(lastFailure?.reason || "", lastFailure?.error || "");
    status("Log saved (bbla-log.json, no keys inside) — attach it to a GitHub issue when reporting a problem.");
  } catch (e) {
    status(e.message, true);
  }
};

/* Log downloads (manual 🧾 or automatic on failure). Never contains keys. */
async function downloadLog(reason, lastError) {
  const logs = await send({ type: "getLogs" });
  const { settings } = await chrome.storage.local.get("settings");
  const doc = { exportedAt: new Date().toISOString(), reason: reason || "manual",
    url: tab?.url || "", lastError: lastError || "",
    env: { provider: settings?.provider, model: settings?.model, bridgeUrl: settings?.bridgeUrl,
      jevKeySet: !!((settings?.typesafeKey || "").trim()), jevModel: settings?.jevModel },
    logs };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));
  a.download = reason ? `bbla-log-${reason}.json` : "bbla-log.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  return doc;
}

/* Best-effort auto-download on failure. Returns a status suffix for the panel. */
/* Failures only record the reason; the file is saved when the user clicks 🧾
   (auto-downloading put a file in Downloads on every failed panel open). */
let lastFailure = null;
async function autoLog(reason, err) {
  lastFailure = { reason, error: err?.message || String(err) };
  return " Click 🧾 log to save diagnostics.";
}

/* --- Marks toggle: hides highlight marks + badges, re-applies them from cache --- */
let marksOn = true;

function paintMarks() {
  $("btn-clear").textContent = marksOn ? "✕ marks" : "◌ marks";
  $("btn-clear").classList.toggle("on", marksOn);
  $("btn-clear").title = marksOn
    ? "Hide highlight marks and section badges (scores and memory are kept)"
    : "Show highlight marks and section badges again (no AI call)";
}

/* --- Ad-block toggle: persists in settings, stays ON across pages/sessions --- */
let adsOn = false;

function paintAds(result) {
  $("btn-ads").textContent = adsOn ? "🚫 ads: on" : "🚫 ads: off";
  $("btn-ads").classList.toggle("on", adsOn);
  if (!result) { $("ads-status").textContent = ""; return; }
  const parts = [];
  if (result.hidden != null) parts.push(`${result.hidden} hidden`);
  if (result.jev) parts.push("Jev ✓");
  else if (result.note) parts.push(result.note);
  $("ads-status").textContent = parts.join(" · ");
}

async function refreshAds() {
  try {
    const st = await send({ type: "adsGet" });
    adsOn = !!st.enabled;
    paintAds(st.jev ? null : { note: "Jev unavailable?" });
    if (!st.jev && adsOn) $("ads-status").textContent = "on · heuristic only (set the TypeSafe key in ⚙ Options → Jev ad-block)";
  } catch { paintAds({ note: "bridge unreachable" }); }
}

/* --- Master on/off switch: when OFF the extension touches no page --- */
let extOn = true;

function paintPower() {
  $("btn-power").textContent = extOn ? "⏻ on" : "⏻ off";
  $("btn-power").classList.toggle("on", extOn);
  for (const id of ["btn-analyze", "btn-deep", "btn-ads", "btn-pick", "btn-score", "btn-clear"]) {
    const b = $(id);
    if (b) b.disabled = !extOn;
  }
}

async function refreshPower() {
  try {
    extOn = (await send({ type: "extGet" })).enabled !== false;
  } catch {
    try {
      const { settings } = await chrome.storage.local.get("settings");
      extOn = (settings || {}).enabled !== false;
    } catch { extOn = true; }
  }
  paintPower();
  return extOn;
}

$("btn-power").onclick = async () => {
  const next = !extOn;
  $("btn-power").disabled = true;
  try {
    try {
      extOn = (await send({ type: "extSet", enabled: next })).enabled;
    } catch {
      const { settings } = await chrome.storage.local.get("settings");
      const merged = { ...(settings || {}), enabled: next };
      await chrome.storage.local.set({ settings: merged });
      extOn = next;
    }
  } finally {
    $("btn-power").disabled = false;
    paintPower();
  }
  if (!extOn) {
    try {
      tab = await currentTab();
      if (tab) await send({ type: "clear", tabId: tab.id }).catch(() => {});
    } catch {}
    $("result").hidden = true;
    $("deep").hidden = true;
    $("btn-deep").hidden = true;
    status("Blabla Meter is off — turn it on with the ⏻ toggle.");
  } else {
    status("");
    tab = null;
    onTabChange();
    refreshAds();
  }
};

$("btn-ads").onclick = async () => {
  if (!extOn) { $("ads-status").textContent = "Blabla Meter is off — turn it on with the ⏻ toggle."; return; }
  tab = await currentTab();
  $("btn-ads").disabled = true;
  try {
    const r = await send({ type: "adsSet", enabled: !adsOn, tabId: tab.id });
    adsOn = !!r.enabled;
    if (r.hidden != null) paintAds(r);
    else {
      paintAds(null);
      $("ads-status").textContent = adsOn ? "" : `${r.restored ?? 0} restored`;
    }
  } catch (e) {
    $("ads-status").textContent = e.message;
  } finally {
    $("btn-ads").disabled = false;
  }
};
$("fb-up").onclick = () => { vote = vote === 1 ? 0 : 1; $("fb-up").classList.toggle("on", vote === 1); $("fb-down").classList.remove("on"); };
$("fb-down").onclick = () => { vote = vote === -1 ? 0 : -1; $("fb-down").classList.toggle("on", vote === -1); $("fb-up").classList.remove("on"); };
$("fb-send").onclick = () => sendFeedback();
$("highlights").onclick = async (e) => {
  const li = e.target.closest("li[data-i]");
  if (!li) return;
  const i = +li.dataset.i;
  const hv = e.target.dataset.hv;
  if (hv) {
    const h = analysis.highlights[i];
    await send({ type: "feedback", entry: { url: analysis.url, host: new URL(analysis.url).host, title: analysis.title, modelScore: analysis.score, vote: 0, highlight: { ...h, verdict: hv } } });
    e.target.closest(".acts").innerHTML = hv === "right" ? "✓ noted" : "✗ noted";
    return;
  }
  send({ type: "focus", tabId: tab.id, idx: i }).catch(() => {});
};

chrome.tabs.onActivated.addListener(onTabChange);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === "complete" || info.url) { tab = null; onTabChange(); } });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) refreshSetup().catch(() => {});
  if (area === "local" && changes.settings && changes.settings.newValue && "enabled" in changes.settings.newValue) {
    extOn = changes.settings.newValue.enabled !== false;
    paintPower();
    if (!extOn) {
      $("result").hidden = true;
      $("deep").hidden = true;
      $("btn-deep").hidden = true;
      status("Blabla Meter is off — turn it on with the ⏻ toggle.");
    }
  }
});
(async () => {
  await refreshPower();
  await checkBridge();
  await refreshSetup();
  await onTabChange();
  refreshAds();
})().catch((e) => status(e.message, true));
paintMarks();
