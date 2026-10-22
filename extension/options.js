import { DEFAULT_SETTINGS, PROVIDERS, endpointFor } from "./lib/ai.js";
import { EMPTY_MEMORY, sanitizeMemory } from "./lib/analysis.js";
import { DEFAULT_ADS_THRESHOLDS } from "./lib/ads.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const KEY_HELP = {
  zen: "Your OpenCode Zen key (opencode.ai → Zen). Pay per use.",
  go: "Your OpenCode Go key (needs an active Go subscription).",
  openrouter: "OpenRouter key; model openrouter/free picks a free model.",
  anthropic: "Anthropic API key (console.anthropic.com → API keys). Pay per use; claude-haiku-5-5 is the cheapest model.",
  openai: "OpenAI API key (platform.openai.com → API keys). Pay per use.",
  gemini: "Google AI Studio key (aistudio.google.com → Get API key). Has a free tier.",
  groq: "Groq key (console.groq.com → API keys). Has a free tier, very fast.",
  mistral: "Mistral key (console.mistral.ai → API keys). Has a free tier.",
  deepseek: "DeepSeek key (platform.deepseek.com → API keys). Pay per use, cheap.",
  ollama: "Free, runs on this computer. Type a model you pulled (e.g. llama3.2). A 403 means Ollama refuses the extension: start it with OLLAMA_ORIGINS=chrome-extension://*.",
  bridge: "Runs the free OpenCode models through the opencode installed on this computer: start bridge/bridge.py (see README).",
  custom: "Any OpenAI-compatible server (key optional).",
};

let settings = { ...DEFAULT_SETTINGS };
let memory = { ...EMPTY_MEMORY };

function send(msg) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(msg, (res) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    res?.ok ? resolve(res.result) : reject(new Error(res?.error || "no answer"));
  }));
}

async function load() {
  const data = await chrome.storage.local.get(["settings", "memory"]);
  settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  if (settings.enabled === undefined) settings.enabled = true;
  settings.enabled = settings.enabled !== false;
  settings.adsThresholds = { ...DEFAULT_ADS_THRESHOLDS, ...(settings.adsThresholds || {}) };
  if (!settings.customBlocks || typeof settings.customBlocks !== "object") settings.customBlocks = {};
  if (!settings.scoreSelectors || typeof settings.scoreSelectors !== "object") settings.scoreSelectors = {};
  memory = { ...EMPTY_MEMORY, ...(data.memory || {}) };
  // Pre-0.9.1 installs kept one key for every provider: file it under the
  // provider it was saved with, so switching providers can't leak it.
  if (!settings.keys || typeof settings.keys !== "object") settings.keys = {};
  if (settings.key && !Object.keys(settings.keys).length) settings.keys = { [settings.provider]: settings.key };
  $("provider").innerHTML = Object.entries(PROVIDERS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join("");
  $("provider").value = settings.provider;
  $("model").value = settings.model;
  $("baseUrl").value = settings.baseUrl;
  $("bridgeUrl").value = settings.bridgeUrl;
  syncFields();
  syncAds();
  paintEnabled();
  renderMemory();
  renderBlocks();
  renderScoreAreas();
  const all = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  $("perm-state").textContent = all ? "✓ all sites allowed" : "";
  $("perm").textContent = all ? "Revoke all-sites access" : "Allow all sites";
  // Extension + bridge versions, so it's always clear which code is running.
  $("ext-version").textContent = "v" + chrome.runtime.getManifest().version;
  try {
    const base = ($("bridgeUrl").value || DEFAULT_SETTINGS.bridgeUrl).replace(/\/+$/, "");
    const r = await fetch(base + "/health", { signal: AbortSignal.timeout(3000) });
    const h = await r.json().catch(() => ({}));
    $("ext-version").textContent += r.ok ? ` · bridge ${h.provider || "?"} / ${h.model || "?"}` : " · bridge down";
  } catch {
    $("ext-version").textContent += " · bridge down";
  }
}

function syncFields() {
  const k = $("provider").value;
  const p = PROVIDERS[k];
  $("key-wrap").hidden = !p.needsKey && k !== "custom";
  $("url-wrap").hidden = k !== "custom";
  $("bridge-wrap").hidden = k !== "bridge";
  $("model").placeholder = p.model || (p.needsModel ? "required, e.g. llama3.2" : "provider default");
  $("key").value = (settings.keys || {})[k] || "";
  $("key-help").textContent = KEY_HELP[k];
}

function renderMemory() {
  $("rules").value = memory.rules.join("\n");
  $("mem-info").textContent = memory.learnedAt ? `last learned ${new Date(memory.learnedAt).toLocaleString()}` : "not learned yet";
  $("cats").innerHTML = memory.categories.map((c, i) => `
    <tr data-i="${i}">
      <td><input type="color" data-f="color" value="${esc(c.color || "#f59e0b")}"></td>
      <td><input type="text" data-f="name" value="${esc(c.name)}">${c.learned ? '<span class="muted small">learned</span>' : ""}</td>
      <td><textarea data-f="desc" rows="2">${esc(c.desc)}</textarea></td>
      <td><button type="button" data-del="${i}" title="delete">✕</button></td>
    </tr>`).join("");
  $("feedback").innerHTML = memory.feedback.slice(-15).reverse().map((f) => {
    const what = f.highlight ? `${f.highlight.verdict === "right" ? "✓" : "✗"} highlight “${esc(f.highlight.quote.slice(0, 60))}”`
      : `${f.vote === 1 ? "👍" : f.vote === -1 ? "👎" : ""} model ${f.modelScore ?? "?"}${f.userScore != null ? ` → mine ${f.userScore}` : ""}`;
    return `<li><b>${esc(f.host || "")}</b> ${what}${f.note ? ` — “${esc(f.note)}”` : ""}</li>`;
  }).join("") || '<li class="muted">No feedback yet.</li>';
}

async function saveMemory() {
  await chrome.storage.local.set({ memory });
  renderMemory();
}

async function saveSettings() {
  const provider = $("provider").value;
  const keys = { ...(settings.keys || {}), [provider]: $("key").value.trim() };
  settings = { ...settings, provider, model: $("model").value.trim(), key: "", keys, baseUrl: $("baseUrl").value.trim(), bridgeUrl: $("bridgeUrl").value.trim() || DEFAULT_SETTINGS.bridgeUrl };
  const url = endpointFor(settings);
  if (/^https?:\/\//.test(url)) {
    try {
      // Hosts outside the manifest's host_permissions (custom, OpenAI, Anthropic…)
      // are granted once here; already-granted origins resolve without a prompt.
      const origin = new URL(url).origin + "/*";
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) throw new Error("permission denied");
    } catch (e) {
      $("saved").textContent = "Could not get access to that endpoint: " + e.message;
      return false;
    }
  }
  await chrome.storage.local.set({ settings });
  $("saved").textContent = "saved ✓";
  return true;
}

/* --- Master on/off switch --- */
function paintEnabled() {
  $("btn-enabled").textContent = settings.enabled !== false ? "⏻ on" : "⏻ off";
  $("btn-enabled").classList.toggle("on", settings.enabled !== false);
}
$("btn-enabled").onclick = async () => {
  settings = { ...settings, enabled: !(settings.enabled !== false) };
  await chrome.storage.local.set({ settings });
  paintEnabled();
};

/* --- Jev ad-block: key, model, thresholds --- */
function syncAds() {
  $("typesafeKey").value = settings.typesafeKey || "";
  $("jevModel").value = settings.jevModel || "";
  for (const k of ["hideAt", "hideAtDisrupt", "disruptAt"]) {
    $(k).value = settings.adsThresholds[k];
    $(k + "-val").textContent = (+settings.adsThresholds[k]).toFixed(2);
  }
}

for (const k of ["hideAt", "hideAtDisrupt", "disruptAt"]) {
  document.getElementById(k).oninput = (e) => document.getElementById(k + "-val").textContent = (+e.target.value).toFixed(2);
}

function readThresholds() {
  const num = (id, d) => {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d;
  };
  return { hideAt: num("hideAt", 0.55), hideAtDisrupt: num("hideAtDisrupt", 0.35), disruptAt: num("disruptAt", 0.6) };
}

/* Test buttons hit the network; a cold bridge takes 30-60 s while opencode
   boots its private server. Disable while running so repeated clicks don't
   stack slow requests, and show elapsed time so it doesn't look hung. */
async function withProgress(btn, el, fn) {
  btn.disabled = true;
  const t0 = Date.now();
  el.textContent = "testing…";
  const tick = setInterval(() => { el.textContent = `testing… (${Math.round((Date.now() - t0) / 1000)} s)`; }, 500);
  try {
    return await fn();
  } finally {
    clearInterval(tick);
    btn.disabled = false;
  }
}
$("save-ads").onclick = async () => {
  settings = { ...settings, typesafeKey: $("typesafeKey").value.trim(),
    jevModel: $("jevModel").value.trim() || "jev-1.13.0", adsThresholds: readThresholds() };
  await chrome.storage.local.set({ settings });
  syncAds();
  $("ads-saved").textContent = "saved ✓";
};
$("reset-thr").onclick = async () => {
  settings = { ...settings, adsThresholds: { ...DEFAULT_ADS_THRESHOLDS } };
  await chrome.storage.local.set({ settings });
  syncAds();
  $("ads-saved").textContent = "defaults restored — press Save ad-block";
};
$("test-jev").onclick = async () => {
  try {
    const st = await withProgress($("test-jev"), $("ads-saved"), () => send({ type: "testJev" }));
    $("ads-saved").textContent = st.jev_available ? `✓ Jev available (model ${st.model || "?"})` : "✗ no TypeSafe key — paste one above or start ./run with TYPESAFE_API_KEY";
  } catch (e) {
    $("ads-saved").textContent = "✗ " + e.message;
  }
};
$("save-jev-key").onclick = async () => {
  $("ads-saved").textContent = "saving…";
  try {
    settings = { ...settings, typesafeKey: $("typesafeKey").value.trim() };
    await chrome.storage.local.set({ settings });
    await send({ type: "saveJevKey" });
    $("ads-saved").textContent = "saved ✓ (extension + bridge file)";
  } catch (e) {
    $("ads-saved").textContent = "✗ " + e.message;
  }
};

/* --- Per-site manual blocks --- */
function renderBlocks() {
  const blocks = settings.customBlocks || {};
  const hosts = Object.keys(blocks);
  $("blocks").innerHTML = hosts.length ? hosts.map((h) =>
    `<li><b>${esc(h)}</b> — ${blocks[h].length} selector${blocks[h].length > 1 ? "s" : ""} ` +
    `<button type="button" data-host="${esc(h)}">clear</button></li>`).join("")
    : '<li class="muted">None yet — use ⛔ block in the side panel.</li>';
}
$("blocks").onclick = async (e) => {
  const host = e.target.dataset?.host;
  if (!host) return;
  await send({ type: "blockClear", host });
  const data = await chrome.storage.local.get("settings");
  settings = { ...settings, ...(data.settings || {}) };
  renderBlocks();
};

/* --- Per-site learned score areas (◉ score picker) --- */
function renderScoreAreas() {
  const areas = settings.scoreSelectors || {};
  const hosts = Object.keys(areas);
  $("scoreareas").innerHTML = hosts.length ? hosts.map((h) =>
    `<li><b>${esc(h)}</b> — ${areas[h].length} area${areas[h].length > 1 ? "s" : ""} ` +
    `<button type="button" data-host="${esc(h)}">clear</button></li>`).join("")
    : '<li class="muted">None yet — use ◉ score in the side panel.</li>';
}
$("scoreareas").onclick = async (e) => {
  const host = e.target.dataset?.host;
  if (!host) return;
  await send({ type: "scoreClear", host });
  const data = await chrome.storage.local.get("settings");
  settings = { ...settings, ...(data.settings || {}) };
  renderScoreAreas();
};

$("provider").onchange = () => { $("model").value = ""; syncFields(); };
$("save").onclick = saveSettings;
$("test").onclick = async () => {
  if (!(await saveSettings())) return;
  try {
    const reply = await withProgress($("test"), $("saved"), () => send({ type: "testProvider" }));
    $("saved").textContent = "✓ answered: " + reply;
  } catch (e) {
    $("saved").textContent = "✗ " + e.message;
  }
};
$("perm").onclick = async () => {
  const all = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  if (all) await chrome.permissions.remove({ origins: ["<all_urls>"] });
  else await chrome.permissions.request({ origins: ["<all_urls>"] });
  load();
};
$("save-rules").onclick = async () => {
  memory.rules = $("rules").value.split("\n").map((r) => r.trim()).filter(Boolean).slice(0, 20);
  await saveMemory();
};
$("relearn").onclick = async () => {
  $("mem-info").textContent = "learning…";
  try {
    memory = await send({ type: "relearn" });
    renderMemory();
  } catch (e) {
    $("mem-info").textContent = "✗ " + e.message;
  }
};
$("cats").oninput = (e) => {
  const tr = e.target.closest("tr[data-i]");
  if (tr && e.target.dataset.f) memory.categories[+tr.dataset.i][e.target.dataset.f] = e.target.value;
};
$("cats").onclick = (e) => {
  if (e.target.dataset.del === undefined) return;
  memory.categories.splice(+e.target.dataset.del, 1);
  renderMemory();
};
$("add-cat").onclick = () => {
  memory.categories.push({ id: "custom_" + Date.now().toString(36), name: "New category", desc: "", color: "#0ea5e9" });
  renderMemory();
};
$("save-cats").onclick = saveMemory;
$("export").onclick = () => {
  // Learned ◉-score areas travel with the backup so a reinstall/import
  // restores them too (they live in settings, not memory).
  const doc = { ...memory, scoreSelectors: settings.scoreSelectors || {} };
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `blabla-meter-memory-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
};
/* Never trust an imported file: keep host→[selector] shape, cap sizes. */
function sanitizeScoreSelectors(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = {};
  for (const [h, list] of Object.entries(v).slice(0, 100)) {
    if (!Array.isArray(list)) continue;
    const clean = list.filter((s) => typeof s === "string" && s.trim())
      .map((s) => s.slice(0, 300)).slice(-20);
    if (clean.length) out[String(h).slice(0, 120)] = clean;
  }
  return out;
}
$("import").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    memory = sanitizeMemory(data);
    const { scoreSelectors } = data;
    await saveMemory();
    const areas = sanitizeScoreSelectors(scoreSelectors);
    if (areas) {
      settings = { ...settings, scoreSelectors: areas };
      await chrome.storage.local.set({ settings });
      renderScoreAreas();
      paintEnabled();
    }
  } catch (err) {
    alert("Import failed: " + err.message);
  }
};
$("reset").onclick = async () => {
  if (!confirm("Forget all rules, learned categories and feedback?")) return;
  memory = { ...EMPTY_MEMORY };
  await saveMemory();
};
$("reload-ext").onclick = () => chrome.runtime.reload();
chrome.storage.onChanged.addListener((changes) => {
  if (changes.memory) { memory = { ...EMPTY_MEMORY, ...changes.memory.newValue }; renderMemory(); }
  if (changes.settings) { settings = { ...settings, ...changes.settings.newValue }; renderBlocks(); renderScoreAreas(); paintEnabled(); }
});

load();
