// Service worker: talks to the AI, injects page functions, keeps settings + memory.
import { DEFAULT_SETTINGS, chat, extractJson } from "./lib/ai.js";
import { addFeedback, applyRules, buildMessages, mergeCategories, needsRelearn, normalizeAnalysis, relearnMessages, sanitizeMemory } from "./lib/analysis.js";
import { buildAdsPayload, normalizeThresholds } from "./lib/ads.js";
import { buildPagePayload, generalizeSelector, hashExcerpt, scoreTags, settledEnough, tagLines } from "./lib/pagescore.js";
import { applyCustomBlocks, clearCustomBlocks, clearBlockScores, clearHighlights, clearPendingScore, collectAdCandidates, collectGroup, countHiddenAds, ensurePickedId, extractPage, focusHeading, focusHighlight, hideAdNodes, highlightQuotes, showAdNodes, showBlockScores, startPicker } from "./lib/page.js";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// Extension pages ping this port while open; it keeps the worker alive across
// a long AI/bridge fetch (MV3 workers can otherwise stop after ~30 s idle).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "keepalive") port.onMessage.addListener(() => {});
});

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  // Master kill-switch: older installs have no key stored → default ON.
  if (merged.enabled === undefined) merged.enabled = true;
  merged.enabled = merged.enabled !== false;
  merged.adsThresholds = normalizeThresholds(merged.adsThresholds);
  if (!merged.customBlocks || typeof merged.customBlocks !== "object") merged.customBlocks = {};
  if (!merged.scoreSelectors || typeof merged.scoreSelectors !== "object") merged.scoreSelectors = {};
  return merged;
}

async function getMemory() {
  const { memory } = await chrome.storage.local.get("memory");
  try {
    return sanitizeMemory(memory);
  } catch {
    return sanitizeMemory({ rules: [], categories: [], feedback: [] });
  }
}

const setMemory = (memory) => chrome.storage.local.set({ memory });

/* Diagnostic log: what the page gave + what the extension answered, newest last
   (capped). Never contains keys — only counts, timings and error messages.
   The side panel's 🧾 button downloads it as bbla-log.json. */
const LOG_KEY = "bbla-logs";
function redactLog(value) {
  if (typeof value === "string") {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
      .replace(/\b(?:sk|tsk|pk)[-_A-Za-z0-9]{4,}\b/gi, "[redacted]");
  }
  if (Array.isArray(value)) return value.map(redactLog);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactLog(v)]));
  }
  return value;
}
async function log(area, msg, data) {
  try {
    const entry = { t: new Date().toISOString(), area, msg: redactLog(msg) };
    if (data !== undefined) entry.data = redactLog(data);
    const cur = ((await chrome.storage.session.get(LOG_KEY))[LOG_KEY] || []).slice(-299);
    cur.push(entry);
    await chrome.storage.session.set({ [LOG_KEY]: cur });
    console.log("[bbla]", area, entry.msg, entry.data ?? "");
  } catch {}
}

/* Rules shared with the news ranker (news/) through the local bridge: page rules go out, news rules
   come in as extra context. Best effort: without the bridge each side just uses its own rules. */
async function bridgeBase() {
  return ((await getSettings()).bridgeUrl || DEFAULT_SETTINGS.bridgeUrl).replace(/\/+$/, "");
}
async function sharedNewsRules() {
  try {
    // POST (not GET): the bridge requires an extension Origin on data routes.
    const r = await fetch((await bridgeBase()) + "/memory/rules", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "read" }), signal: AbortSignal.timeout(1500),
    });
    return r.ok ? ((await r.json()).news || []) : [];
  } catch { return []; }
}
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.memory) return;
  const rules = Array.isArray(changes.memory.newValue?.rules) ? changes.memory.newValue.rules : [];
  const oldRules = Array.isArray(changes.memory.oldValue?.rules) ? changes.memory.oldValue.rules : [];
  if (JSON.stringify(oldRules) === JSON.stringify(rules)) return;
  try {
    await fetch((await bridgeBase()) + "/memory/rules", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "page", rules }), signal: AbortSignal.timeout(3000) });
  } catch {}
});

async function run(tabId, func, args = []) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return res?.result;
  } catch (e) {
    await log("page", `inject ${func.name} failed`, e.message);
    throw new Error(/Cannot access|permission|chrome:\/\//i.test(e.message)
      ? "Blabla Meter can't read this tab. Click the Blabla Meter toolbar icon while on the page (or allow all sites in the options). Browser pages (chrome://, the Web Store) can't be analyzed."
      : e.message);
  }
}

const cacheKey = (url) => "analysis:" + String(url || "").split("#")[0];

/* Async page work can outlive a navigation. Never inject into a tab whose
   address changed while an AI/bridge request was in flight. */
async function samePage(tabId, url) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return !!tab && String(tab.url || "").split("#")[0] === String(url || "").split("#")[0];
}

async function analyze(tabId, force) {
  const page = await extractSettled(tabId);
  if (!page?.text || page.text.length < 80) throw new Error("Not enough text on this page to analyze.");
  const key = cacheKey(page.url);
  if (!force) {
    const cached = (await chrome.storage.session.get(key))[key];
    if (cached) {
      await log("ai", "deep dive served from cache", { chars: cached.chars });
      if (!(await samePage(tabId, page.url))) {
        throw new Error("Page changed while analyzing — try again.");
      }
      cached.found = await run(tabId, highlightQuotes, [cached.highlights, (await getMemory()).categories]);
      return cached;
    }
  }
  let memory = await getMemory();
  const settings = await getSettings();
  const started = Date.now();
  const reply = await chat(settings, buildMessages(page, { ...memory, newsRules: await sharedNewsRules() }));
  const result = normalizeAnalysis(extractJson(reply), memory);
  if (result.newCategories.length) {
    memory = mergeCategories(memory, result.newCategories);
    await setMemory(memory);
  }
  const analysis = { ...result, url: page.url, title: page.title, chars: page.text.length, selection: page.selection, ms: Date.now() - started,
    words: page.words || 0, headings: (page.headings || []).slice(0, 40) };
  await chrome.storage.session.set({ [key]: analysis });
  if (!(await samePage(tabId, page.url))) {
    throw new Error("Page changed while analyzing — try again.");
  }
  analysis.found = await run(tabId, highlightQuotes, [analysis.highlights, memory.categories]);
  await log("ai", "deep dive ok", { score: analysis.score, highlights: analysis.highlights.length,
    marked: (analysis.found || []).length, chars: page.text.length, ms: analysis.ms });
  return analysis;
}

async function feedback(entry) {
  let memory = addFeedback(await getMemory(), entry);
  await setMemory(memory);
  if (needsRelearn(memory)) relearn().catch(() => {}); // background; the panel doesn't wait
  return memory;
}

async function relearn() {
  const memory = await getMemory();
  if (!memory.feedback.length) return memory;
  const reply = await chat(await getSettings(), relearnMessages(memory));
  const next = applyRules(await getMemory(), extractJson(reply)); // re-read: feedback may have arrived meanwhile
  await setMemory(next);
  return next;
}

/* Hydrating pages (MSN-style shell → real content): keep re-extracting while the
   body is thin or still growing, so Score analyzes the final content instead of
   the shell. Settled pages cost exactly one extract. */
async function extractSettled(tabId) {
  const extraBlocks = (await getSettings()).scoreSelectors || {};
  let page = null, prev = 0;
  const lens = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    page = await run(tabId, extractPage, [{ extraBlocks }]);
    lens.push((page?.text || "").length);
    if (settledEnough((page?.text || "").length, prev)) {
      await log("page", "extract settled", { attempts: attempt + 1, lens,
        headings: (page?.headings || []).length, blocks: (page?.blocks || []).length });
      return page;
    }
    prev = Math.max(prev, (page?.text || "").length);
    await new Promise((r) => setTimeout(r, 2500));
  }
  await log("page", "extract never settled", { lens,
    headings: (page?.headings || []).length, blocks: (page?.blocks || []).length });
  return page;
}

/* --- Instant Jev score (no generative AI): one typed-judgment call --- */

async function pageScore(tabId) {
  const page = await extractSettled(tabId);
  if (!page?.text || page.text.length < 80) throw new Error("Page looks empty — it may still be loading. Click Score again once loaded.");
  const ck = "pagescore:" + page.url.split("#")[0];
  await chrome.storage.session.remove(ck); // the button always scores current content, never cache
  const settings = await getSettings();
  const headers = { "Content-Type": "application/json" };
  if ((settings.typesafeKey || "").trim()) headers["X-Typesafe-Key"] = settings.typesafeKey.trim();
  const memory = await getMemory();
  const started = Date.now();
  // Efficiency memory: identical sections (recurring rails, syndicated cards)
  // reuse their Jev judgment instead of burning another call. Keyed by excerpt
  // hash — approximate across rule tweaks, which is fine for badges.
  const payload = buildPagePayload({ ...page, host: new URL(page.url).host },
    memory.rules, { model: settings.jevModel });
  const CACHE_KEY = "bbla-blockcache";
  const cache = (await chrome.storage.session.get(CACHE_KEY))[CACHE_KEY] || {};
  const fresh = [];
  for (const b of payload.blocks) {
    b.hash = hashExcerpt(b.excerpt);
    if (!cache[b.hash]) fresh.push({ id: b.id, hid: b.hid, heading: b.heading, excerpt: b.excerpt });
  }
  payload.blocks = fresh;
  let r;
  try {
    r = await fetch((await bridgeBase()) + "/page/score", {
      method: "POST", headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90000),
    });
  } catch {
    throw new Error("NO_BRIDGE"); // side panel points to the AI analysis instead
  }
  const data = await r.json().catch(() => ({}));
  if (r.status === 402) {
    await log("bridge", "/page/score → 402 (no key anywhere)");
    throw new Error("NO_JEV_KEY"); // side panel offers the on-demand AI deep dive
  }
  if (!r.ok) {
    await log("bridge", `/page/score → HTTP ${r.status}`, data?.error?.message || "");
    throw new Error("Instant score failed (bridge: " + (data?.error?.message || ("HTTP " + r.status)) + ")");
  }
  const excerpts = Object.fromEntries((page.blocks || []).map((b) => [b.hid, b.excerpt || ""]));
  const scored = { ...(data.blocks || {}) };
  let cached = 0;
  for (const b of (page.blocks || [])) {
    const h = hashExcerpt(b.excerpt || "");
    if (cache[h] && !scored[b.hid]) {
      scored[b.hid] = cache[h];
      cached++;
    }
  }
  for (const [bid, b] of Object.entries(data.blocks || {})) {
    const h = hashExcerpt((fresh.find((f) => f.id === bid) || {}).excerpt || "");
    if (h) cache[h] = { dims: b.dims, usefulness: b.usefulness };
  }
  for (const k of Object.keys(cache).slice(0, Math.max(0, Object.keys(cache).length - 200))) delete cache[k];
  await chrome.storage.session.set({ [CACHE_KEY]: cache });
  const blockScores = Object.entries(scored).map(([hid, b]) => ({
    hid, excerpt: excerpts[hid] || "", score: b.usefulness.value, tags: scoreTags(b.dims),
  }));
  const result = { score: data.usefulness.value, base: data.usefulness.base, penalty: data.usefulness.penalty,
    dims: data.dims, tags: scoreTags(data.dims), blockScores, url: page.url, title: page.title,
    chars: page.text.length, words: page.words || 0, headings: (page.headings || []).slice(0, 40),
    model: data.model, ms: Date.now() - started, at: Date.now(), blocksCached: cached };
  await chrome.storage.session.set({ [ck]: result });
  await log("bridge", "/page/score ok", { score: result.score, topic: data.dims?.topic,
    blocksSent: fresh.length, blocksCached: cached, blocksScored: blockScores.length,
    chars: page.text.length, ms: result.ms, model: data.model });
  return result;
}

/* Cheap content check (no bridge call): lets the panel notice the page body
   changed under a cached score (hydration, SPA navigation, live updates). */
async function pageStats(tabId) {
  const page = await run(tabId, extractPage);
  return { url: page.url, chars: (page.text || "").length, words: page.words || 0 };
}

/* Badge injection for the cached fast score (+ cached deep-dive insights).
   Tooltips carry the Jev tag lines plus any AI highlights matched to the block. */
async function showBlocks(tabId, url) {
  const base = String(url || "").split("#")[0];
  if (!base) return 0;
  if (!(await samePage(tabId, base))) return 0;
  const sess = await chrome.storage.session.get(["pagescore:" + base, "analysis:" + base]);
  const f = sess["pagescore:" + base];
  if (!f?.blockScores?.length) {
    if (await samePage(tabId, base)) await run(tabId, clearBlockScores).catch(() => {});
    return 0;
  }
  const memory = await getMemory();
  if (!(await samePage(tabId, base))) return 0;
  const names = Object.fromEntries(memory.categories.map((c) => [c.id, c.name]));
  const deep = sess["analysis:" + base];
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const items = f.blockScores.map((b) => {
    const ai = [];
    if (deep?.highlights) {
      const excerpt = norm(b.excerpt);
      for (const h of deep.highlights) {
        const q = norm(h.quote).slice(0, 40);
        if (q.length >= 20 && excerpt.includes(q)) {
          ai.push(`${names[h.category] || h.category} — ${h.why}`.slice(0, 160));
        }
        if (ai.length >= 4) break;
      }
    }
    return { hid: b.hid, score: b.score, tags: tagLines(b.tags), ai };
  });
  const r = await run(tabId, showBlockScores, [items]).catch(() => null);
  const shown = (r && typeof r.shown === "number") ? r.shown : 0;
  const missing = (r && typeof r.missing === "number") ? r.missing : items.length;
  await log("page", "badges injected", { items: items.length, shown, missing,
    rtype: typeof r, deepHighlights: deep?.highlights?.length || 0 });
  return shown;
}

/* --- Ad-block (heuristic instant hide + Jev via the bridge for ambiguous nodes) --- */

async function adsJevAvailable() {
  try {
    const r = await fetch((await bridgeBase()) + "/ads/status", { signal: AbortSignal.timeout(3000) });
    return r.ok ? !!((await r.json()).jev_available) : false;
  } catch { return false; }
}

async function adsGet() {
  const settings = await getSettings();
  // A key saved in the extension options counts even when the bridge has none on disk.
  const jev = !!(settings.typesafeKey || "").trim() || await adsJevAvailable();
  return { enabled: !!settings.adsEnabled, jev,
    hasLocalKey: !!(settings.typesafeKey || "").trim(), thresholds: settings.adsThresholds };
}

async function adsSet({ enabled, tabId }) {
  const settings = await getSettings();
  settings.adsEnabled = !!enabled;
  await chrome.storage.local.set({ settings });
  if (tabId == null) return { enabled: settings.adsEnabled };
  if (settings.adsEnabled) return adsRun(tabId);
  const restored = await run(tabId, showAdNodes).catch(() => 0);
  // Manual per-site blocks stay in force when the ad-block toggle is turned
  // off. Re-apply them because showAdNodes may have restored an element that
  // was hidden by both mechanisms.
  let custom = 0;
  try {
    const tab = await chrome.tabs.get(tabId);
    const blocks = (settings.customBlocks || {})[new URL(tab.url).host] || [];
    if (blocks.length) custom = await run(tabId, applyCustomBlocks, [blocks]).catch(() => 0);
  } catch {}
  return { enabled: false, restored, custom };
}

async function adsRun(tabId) {
  const settings = await getSettings();
  const thresholds = normalizeThresholds(settings.adsThresholds);
  const headers = { "Content-Type": "application/json" };
  if ((settings.typesafeKey || "").trim()) headers["X-Typesafe-Key"] = settings.typesafeKey.trim();
  // Unclutter-style per-site manual blocks always apply, even before/without Jev.
  let custom = 0;
  const col = await run(tabId, collectAdCandidates);
  if (!col || !Array.isArray(col.candidates)) throw new Error("Could not read ad candidates on this page.");
  if (!(await samePage(tabId, col.url))) {
    return { enabled: true, hidden: 0, obvious: 0, jev: false, total: col.candidates.length, note: "page changed while scoring" };
  }
  try {
    const blocks = (settings.customBlocks || {})[col.host] || [];
    if (blocks.length) custom = await run(tabId, applyCustomBlocks, [blocks]);
  } catch {}
  const obvious = col.candidates.filter((c) => c.obvious).map((c) => c.id);
  let hidden = obvious.length ? await run(tabId, hideAdNodes, [obvious]) : 0;
  // ambiguous first: promo-text matches, then the rest (Jev is capped server-side too)
  const rest = col.candidates.filter((c) => !c.obvious)
    .sort((a, b) => (b.promoText ? 1 : 0) - (a.promoText ? 1 : 0));
  if (!rest.length) {
    await chrome.storage.session.set({ ["ads:" + col.url.split("#")[0]]: { hidden, at: Date.now() } });
    return { enabled: true, hidden, obvious: hidden, jev: false, total: col.candidates.length };
  }
  const memory = await getMemory();
  let jev = false, jevHidden = 0, note = "";
  try {
    const r = await fetch((await bridgeBase()) + "/ads/score", {
      method: "POST", headers,
      body: JSON.stringify(buildAdsPayload(rest, col, memory.rules,
        { thresholds, model: settings.jevModel })),
      signal: AbortSignal.timeout(90000),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 402) note = "heuristic only (no TypeSafe key for Jev — set it in ⚙ Options → Jev instant score & ad-block)";
    else if (!r.ok) note = "heuristic only (bridge: " + (data?.error?.message || r.status) + ")";
    else {
      if (!(await samePage(tabId, col.url))) {
        return { enabled: true, hidden, obvious: hidden, jev: false, total: col.candidates.length, note: "page changed while scoring" };
      }
      jev = true;
      const ids = Object.values(data.decisions || {}).filter((d) => d && d.hide).map((d) => d.id);
      jevHidden = ids.length ? await run(tabId, hideAdNodes, [ids]) : 0;
      hidden += jevHidden;
    }
  } catch (e) {
    note = "heuristic only (bridge unreachable)";
  }
  if (!(await samePage(tabId, col.url))) {
    return { enabled: true, hidden, obvious: hidden, jev: false, total: col.candidates.length, note: "page changed while scoring" };
  }
  if (!jev) {
    // fallback: hide promo-text matches without Jev
    const promo = rest.filter((c) => c.promoText).map((c) => c.id);
    const n = promo.length ? await run(tabId, hideAdNodes, [promo]) : 0;
    hidden += n;
  }
  // authoritative count straight from the page (covers overlaps between passes)
  try { hidden = await run(tabId, countHiddenAds); } catch {}
  hidden += custom;
  await chrome.storage.session.set({ ["ads:" + col.url.split("#")[0]]: { hidden, at: Date.now() } });
  return { enabled: true, hidden, jev, total: col.candidates.length, custom, note };
}

/* Manual per-site blocks (Unclutter-style): the picker sends {host, selector}. */
async function blockSelector({ host, selector }) {
  host = String(host || "").slice(0, 120);
  selector = String(selector || "").slice(0, 300);
  if (!host || !selector) throw new Error("bad block request");
  const settings = await getSettings();
  const list = (settings.customBlocks || {})[host] || [];
  if (!list.includes(selector)) list.push(selector);
  settings.customBlocks = { ...(settings.customBlocks || {}), [host]: list.slice(-30) };
  await chrome.storage.local.set({ settings });
  return { host, selector, count: list.length };
}

async function blockClear({ host, tabId }) {
  const settings = await getSettings();
  if (host) {
    const blocks = { ...(settings.customBlocks || {}) };
    delete blocks[host];
    settings.customBlocks = blocks;
    await chrome.storage.local.set({ settings });
  }
  if (tabId != null) await run(tabId, clearCustomBlocks).catch(() => {});
  return { ok: true };
}

/* Score-picker: the reader clicked one element to score just that section.
   Scores it, badges it, scores the whole matching group right away, then
   LEARNS the generalized selector for the host — next extractions include the
   group as blocks automatically. Failures are also reported to the panel via
   the session key (the page message has no response channel). */
async function scoreElement(msg, senderTabId) {
  let { host, selector, excerpt, hid, groupSelector } = msg || {};
  const tabId = msg?.tabId ?? senderTabId;
  host = String(host || "").slice(0, 120);
  selector = String(selector || "").slice(0, 300);
  excerpt = String(excerpt || "").slice(0, 800);
  hid = String(hid || "").slice(0, 120) || null;
  groupSelector = String(groupSelector || "").slice(0, 300) || null;
  const clearPending = async (id) => {
    if (tabId != null) await run(tabId, clearPendingScore, [id || null]).catch(() => {});
  };
  const fail = async (msg) => {
    await clearPending(hid);
    await chrome.storage.session.set({ ["scorepicked:" + (host || "?")]: { error: msg, at: Date.now() } });
    await log("bridge", "picked section failed", { host, msg });
    return { error: msg };
  };
  if (!host || !selector || excerpt.length < 25) return fail("bad score request");
  // Tell the panel right away that scoring started (it shows ⏳); the page
  // already shows the light-grey overlay from the picker click.
  await chrome.storage.session.set({ ["scorepicked:" + host]: { scoring: true, at: Date.now() } }).catch(() => {});
  const settings = await getSettings();
  const headers = { "Content-Type": "application/json" };
  if ((settings.typesafeKey || "").trim()) headers["X-Typesafe-Key"] = settings.typesafeKey.trim();
  const memory = await getMemory();
  const model = settings.jevModel || "jev-1.13.0";
  const callJev = async (page, blocks) => {
    let r;
    try {
      r = await fetch((await bridgeBase()) + "/page/score", {
        method: "POST", headers,
        body: JSON.stringify({ page, blocks, rules: (memory.rules || []).slice(0, 12), model }),
        signal: AbortSignal.timeout(90000),
      });
    } catch {
      throw new Error("Bridge unreachable — start ./run (or the bridge).");
    }
    const data = await r.json().catch(() => ({}));
    if (r.status === 402) throw new Error("NO_JEV_KEY");
    if (!r.ok) throw new Error("Section score failed (bridge: " + (data?.error?.message || ("HTTP " + r.status)) + ")");
    return data;
  };
  let data;
  try {
    data = await callJev({ host, title: host, text: excerpt.slice(0, 2000) }, []);
  } catch (e) {
    return fail(e.message);
  }
  const tags = scoreTags(data.dims);
  // Learn the GROUP selector (card + siblings), not the instance one: an
  // `#id` learned alone matches one element forever, so similars would never
  // be scored on revisit. Falls back to the instance selector when the card
  // has no sibling group.
  const gen = generalizeSelector(groupSelector || selector);
  const map = { ...(settings.scoreSelectors || {}) };
  const list = map[host] || [];
  if (gen && !list.includes(gen)) list.push(gen);
  map[host] = list.slice(-20);
  settings.scoreSelectors = map;
  await chrome.storage.local.set({ settings });
  // The picked element always gets its badge, then the similar ones.
  // Trust the picker's hid (the exact clicked element); only fall back to
  // selector lookup when the picker predates the hid field.
  let group = [];
  if (tabId != null && gen) group = await run(tabId, collectGroup, [gen, hid]).catch(() => []);
  let pickedHid = hid;
  if (!pickedHid && tabId != null)
    pickedHid = await run(tabId, ensurePickedId, [selector]).catch(() => null);
  let similar = 0;
  const rest = (group || []).filter((g) => g.hid !== pickedHid);
  if (rest.length) {
    try {
      const gdata = await callJev(
        { host, title: host, text: excerpt.slice(0, 2000) },
        rest.map((g) => ({ id: g.hid, hid: g.hid, heading: "", excerpt: g.excerpt })));
      const items = Object.entries(gdata.blocks || {}).map(([bhid, b]) => ({
        hid: bhid, score: b.usefulness.value, tags: tagLines(scoreTags(b.dims)), ai: [],
      }));
      if (items.length && tabId != null) {
        const drawn = await run(tabId, showBlockScores, [items, { keep: true }]).catch(() => null);
        similar = (drawn && drawn.shown) || 0;
      }
    } catch (e) {
      await log("bridge", "picked group failed", e.message);
    }
  }
  // Guarantee: the picked badge lands even when the group call failed or
  // returned nothing. showBlockScores also drops the pending overlay.
  if (pickedHid && tabId != null) {
    await run(tabId, showBlockScores,
      [[{ hid: pickedHid, score: data.usefulness.value, tags: tagLines(tags), ai: [] }],
       { keep: true }]).catch(() => {});
    await clearPending(pickedHid);
  } else {
    await clearPending(hid);
  }
  const result = { score: data.usefulness.value, tags: tagLines(tags), selector: gen,
    learned: map[host].length, similar, at: Date.now() };
  await chrome.storage.session.set({ ["scorepicked:" + host]: result });
  await log("bridge", "picked section scored", { host, score: result.score, selector: gen, similar });
  return result;
}

async function scoreClear({ host }) {
  const settings = await getSettings();
  if (host) {
    const map = { ...(settings.scoreSelectors || {}) };
    delete map[host];
    settings.scoreSelectors = map;
    await chrome.storage.local.set({ settings });
  }
  return { ok: true };
}

/* Re-apply cached marks without any AI call (marks toggle back on). */
async function restoreMarks(tabId, url) {
  const base = String(url || "").split("#")[0];
  if (!(await samePage(tabId, base))) return { marked: 0, badges: 0 };
  const sess = await chrome.storage.session.get(["pagescore:" + base, "analysis:" + base]);
  const a = sess["analysis:" + base];
  let marked = [];
  if (a?.highlights?.length) {
    if (!(await samePage(tabId, base))) return { marked: 0, badges: 0 };
    const memory = await getMemory();
    marked = await run(tabId, highlightQuotes, [a.highlights, memory.categories]).catch(() => []);
  }
  const badges = await showBlocks(tabId, url);
  return { marked: (marked || []).length, badges };
}

/* Master on/off switch: when OFF the extension touches no page (no scoring,
   badges, pickers or ad-blocking). The panel + options flip settings.enabled;
   every page-touching handler below goes through needOn. `clear` stays
   available so turning off can wipe marks off the current tab. */
async function ensureEnabled() {
  if ((await getSettings()).enabled === false) throw new Error("Blabla Meter is off — turn it on with the ⏻ toggle.");
}
const needOn = (fn) => async (m, sender) => { await ensureEnabled(); return fn(m, sender); };

async function extGet() {
  return { enabled: (await getSettings()).enabled !== false };
}

async function extSet({ enabled }) {
  const settings = await getSettings();
  settings.enabled = !!enabled;
  await chrome.storage.local.set({ settings });
  return { enabled: settings.enabled };
}

const handlers = {
  analyze: needOn((m) => analyze(m.tabId, m.force)),
  pageScore: needOn((m) => pageScore(m.tabId)),
  pageStats: needOn((m) => pageStats(m.tabId)),
  showBlocks: needOn((m) => showBlocks(m.tabId, m.url)),
  focus: needOn((m) => run(m.tabId, focusHighlight, [m.idx])),
  focusHeading: needOn((m) => run(m.tabId, focusHeading, [m.id])),
  pick: needOn((m) => run(m.tabId, startPicker, [m.mode || "block"])),
  blockSelector: needOn((m) => blockSelector(m)),
  blockClear: (m) => blockClear(m),
  scoreElement: needOn((m, sender) => scoreElement(m, sender?.tab?.id)),
  scoreClear: (m) => scoreClear(m),
  restoreMarks: needOn((m) => restoreMarks(m.tabId, m.url)),
  extGet,
  extSet,
  clear: async (m) => {
    await run(m.tabId, clearHighlights).catch(() => {});
    return run(m.tabId, clearBlockScores).catch(() => true);
  },
  feedback: (m) => feedback(m.entry),
  relearn: () => relearn(),
  adsGet,
  adsSet: (m) => adsSet(m),
  adsRun: needOn((m) => adsRun(m.tabId)),
  adsShow: (m) => run(m.tabId, showAdNodes),
  testProvider: async () => {
    const reply = await chat(await getSettings(), [{ role: "user", content: 'Reply with exactly: {"ok": true}' }], { timeoutMs: 90000 });
    return reply.slice(0, 200);
  },
  getLogs: async () => (await chrome.storage.session.get(LOG_KEY))[LOG_KEY] || [],
  clearLogs: async () => {
    await chrome.storage.session.remove(LOG_KEY);
    return { ok: true };
  },
  testJev: async () => {
    // Uses the extension-saved key when present; the bridge falls back to its own file/env key.
    const settings = await getSettings();
    const headers = {};
    if ((settings.typesafeKey || "").trim()) headers["X-Typesafe-Key"] = settings.typesafeKey.trim();
    const r = await fetch((await bridgeBase()) + "/ads/status", { headers, signal: AbortSignal.timeout(10000) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("bridge: HTTP " + r.status);
    return data;
  },
  saveJevKey: async () => {
    // Persist the extension-saved key into the bridge's file (~/.config/bbla/typesafe.key, 0600),
    // so ./run and the news ranker share it — same pattern as news/ settings.
    const settings = await getSettings();
    const key = (settings.typesafeKey || "").trim();
    if (!key) throw new Error("No TypeSafe key in the options to save.");
    const r = await fetch((await bridgeBase()) + "/ads/key", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(10000) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data?.error?.message || ("bridge: HTTP " + r.status));
    return data;
  },
};

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  h(msg, sender).then((result) => send({ ok: true, result }), (e) => send({ ok: false, error: e.message || String(e) }));
  return true; // async response
});

/* Keep blocking on every new page while the toggle stays ON (needs the
   all-sites permission from the options page; skipped silently otherwise).
   Per-site manual blocks (Unclutter-style) always re-apply, toggle or not. */
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== "complete" || !/^https?:/.test(tab?.url || "")) return;
  try {
    const settings = await getSettings();
    if (settings.enabled === false) return; // master switch OFF: touch nothing
    const host = new URL(tab.url).host;
    const blocks = (settings.customBlocks || {})[host] || [];
    if (!settings.adsEnabled) {
      if (blocks.length) await run(tabId, applyCustomBlocks, [blocks]).catch(() => {});
      return;
    }
    await adsRun(tabId);
  } catch {}
});
