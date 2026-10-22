"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const PROFILE_FIELDS = [
  ["location", "Where you live (city / neighborhood)", "e.g. Curitiba, bairro Batel"],
  ["work", "Work / what you do", "e.g. software engineer, small business owner"],
  ["interests", "What is useful to you", "e.g. AI tools I can use, local free events, personal finance, cooking"],
  ["avoid", "What is useless to you", "e.g. celebrity news, crime stories, election polls, far-away wars"],
];
const DIM_LABEL = { actionable: "actionable", relevance: "relevant to you", impact: "impact on you", depth: "depth / quality" };
const FLAG_LABEL = { clickbait: "clickbait", sensational: "sensational", tragedy: "tragedy as entertainment", speculation: "speculation", gossip: "gossip" };

let S = null;          // /api/state
let articles = [];
let topicFilter = null;
let pollTimer = null;

async function api(path, body) {
  const opts = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data, status: res.status });
  return data;
}

function ago(ts) {
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  if (m < 60) return `${Math.max(m, 0)} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}

/* ------------------------------------------------------------ state */
async function loadState() {
  S = await api("/api/state");
  document.querySelectorAll("[data-profile-form]").forEach((box) => {
    box.innerHTML = PROFILE_FIELDS.map(([k, label, ph]) =>
      `<label>${esc(label)}<textarea data-pf="${k}" rows="2" placeholder="${esc(ph)}">${esc(S.settings.profile[k])}</textarea></label>`).join("");
  });
  const p = S.settings.profile;
  $("onboard").hidden = !!(p.location || p.work || p.interests || p.avoid);
  showJob(S.job);
}

function profileFrom(root) {
  const out = {};
  root.querySelectorAll("[data-pf]").forEach((t) => { out[t.dataset.pf] = t.value.trim(); });
  return out;
}

/* ------------------------------------------------------------ news list */
async function loadNews() {
  const res = await api("/api/news");
  articles = res.articles;
  renderTopics();
  render();
  if (!articles.length && !S.job.running) {
    $("list").innerHTML = `<div class="empty">No scored news yet — press <b>↻ Refresh</b>.${res.unscored ? ` (${res.unscored} fetched, not scored with ${esc(res.scorer)} yet)` : ""}</div>`;
  }
}

function renderTopics() {
  const counts = {};
  articles.forEach((a) => { counts[a.dims.topic] = (counts[a.dims.topic] || 0) + 1; });
  const keys = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  $("topics").innerHTML = [`<button type="button" data-topic="" class="${topicFilter ? "" : "on"}">all</button>`]
    .concat(keys.map((k) => `<button type="button" data-topic="${k}" class="${topicFilter === k ? "on" : ""}" title="${esc(S.topics[k] || "")}">${esc(k.replace(/_/g, " "))} · ${counts[k]}</button>`)).join("");
}

function render() {
  const min = +$("min").value;
  const q = $("search").value.trim().toLowerCase();
  let list = articles.filter((a) => (!topicFilter || a.dims.topic === topicFilter) && (!q || a.title.toLowerCase().includes(q)));
  if ($("sort").value === "date") list = [...list].sort((a, b) => b.published - a.published);
  const shown = list.filter((a) => a.useful.value >= min);
  const hidden = list.filter((a) => a.useful.value < min);
  $("list").replaceChildren(...shown.map(card));
  $("counts").textContent = `${shown.length} shown · ${hidden.length} below ${min}`;
  $("hidden-wrap").hidden = !hidden.length;
  $("hidden-sum").textContent = `${hidden.length} filtered out (below ${min}) — peek`;
  $("hidden-list").replaceChildren(...($("hidden-wrap").open ? hidden.map(card) : []));
  if (!shown.length && articles.length) $("list").innerHTML = `<div class="empty">Nothing at or above ${min}. Lower the slider or refresh.</div>`;
}

function card(a) {
  const el = $("tpl-article").content.firstElementChild.cloneNode(true);
  const v = a.useful.value;
  const badge = el.querySelector(".badge");
  badge.textContent = v;
  badge.className = "badge " + (v >= 60 ? "hi" : v >= 35 ? "mid" : "lo") + (a.stale ? " stale" : "");
  if (a.stale) badge.title = "judged with an older profile — refresh to re-score";
  const t = el.querySelector(".title");
  t.textContent = a.title;
  t.href = a.url;
  el.querySelector(".meta").textContent = `${a.source} · ${ago(a.published)} · ${a.dims.topic.replace(/_/g, " ")}`;
  el.querySelector(".summary").textContent = a.summary;
  el.querySelector(".why-body").innerHTML = whyHtml(a);
  const fb = a.feedback || {};
  const up = el.querySelector(".up"), down = el.querySelector(".down");
  up.classList.toggle("on", fb.vote === 1);
  down.classList.toggle("on", fb.vote === -1);
  el.querySelector(".myscore").value = fb.user_score ?? "";
  el.querySelector(".note").value = fb.note || "";
  const send = async (vote) => {
    const body = { id: a.id, vote: vote ?? (fb.vote || 0), user_score: el.querySelector(".myscore").value, note: el.querySelector(".note").value.trim() };
    try {
      const r = await api("/api/feedback", body);
      a.feedback = { vote: body.vote, user_score: body.user_score === "" ? null : +body.user_score, note: body.note };
      fb.vote = body.vote;
      up.classList.toggle("on", body.vote === 1);
      down.classList.toggle("on", body.vote === -1);
      el.querySelector(".saved").textContent = "saved ✓";
      S.memory = r.memory;
    } catch (e) {
      el.querySelector(".saved").textContent = e.message;
    }
  };
  up.onclick = () => send(fb.vote === 1 ? 0 : 1);
  down.onclick = () => send(fb.vote === -1 ? 0 : -1);
  el.querySelector(".save").onclick = () => send();
  el.querySelector(".note").onkeydown = (e) => { if (e.key === "Enter") send(); };
  return el;
}

function whyHtml(a) {
  const d = a.dims, u = a.useful;
  const bars = Object.keys(DIM_LABEL).map((k) => {
    const p = Math.round((d.scores[k] || 0) * 100);
    return `<div class="bar"><span>${DIM_LABEL[k]}</span><div class="track"><div class="fill" style="width:${p}%"></div></div><span>${p}</span></div>`;
  }).join("");
  const flags = Object.keys(FLAG_LABEL).map((k) => {
    const p = Math.round((d.flags[k] || 0) * 100);
    return `<span class="flag ${p >= 50 ? "on" : ""}">${FLAG_LABEL[k]} ${p}%</span>`;
  }).join("");
  const adj = [u.topic_adj ? ` ${u.topic_adj > 0 ? "+" : ""}${u.topic_adj} (topic, learned)` : "", u.source_adj ? ` ${u.source_adj > 0 ? "+" : ""}${u.source_adj} (source, learned)` : ""].join("");
  const conf = d.confidence != null ? ` · model confidence ${Math.round(d.confidence * 100)}%` : "";
  return `${bars}<div class="flags">${flags}</div><div class="formula">${u.base} × ${u.penalty} (flags)${adj} = ${u.value}${conf}</div>`;
}

/* ------------------------------------------------------------ refresh job */
function showJob(j) {
  if (!j) return;
  const txt = j.running ? `${j.stage}${j.total ? ` ${j.done}/${j.total}` : ""}…` : j.stage === "error" ? `⚠ ${j.errors[0] || "error"}` : j.finished ? `updated ${ago(j.finished)}` : "";
  $("job").textContent = txt;
  $("job").title = (j.errors || []).join("\n");
  $("btn-refresh").disabled = !!j.running;
}

async function refresh(rescore = false) {
  try {
    const r = await api("/api/refresh", { rescore });
    showJob(r.job);
  } catch (e) {
    if (e.status !== 409) return alert(e.message);
  }
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const j = await api("/api/job");
    S.job = j;
    showJob(j);
    if (j.done && j.running) loadNews();
    if (!j.running) { clearInterval(pollTimer); loadNews(); }
  }, 1500);
}

/* ------------------------------------------------------------ settings */
function openSettings() {
  const s = S.settings;
  $("s-scorer").value = s.scorer;
  $("s-ts").value = "";
  $("s-ts-src").textContent = S.typesafe_key ? "A TypeSafe key is available." : "No TypeSafe key yet (get one at typesafe.ai).";
  $("s-provider").innerHTML = Object.entries(S.ai.providers).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join("");
  $("s-provider").value = S.ai.provider;
  $("s-model").value = S.ai.model;
  $("s-url").value = S.ai.base_url || "";
  $("s-key").value = "";
  $("s-weights").innerHTML = Object.entries(s.weights).map(([k, v]) =>
    `<label>${esc(DIM_LABEL[k] || FLAG_LABEL[k] || k)}<input type="number" step="0.05" min="0" max="1" data-w="${k}" value="${v}"></label>`).join("");
  $("s-feeds").value = s.feeds.map((f) => `${f.name} | ${f.url}`).join("\n");
  $("s-local").checked = !!s.local_feed;
  $("s-days").value = s.days;
  syncProviderFields();
  $("dlg-settings").showModal();
}

function syncProviderFields() {
  const p = S.ai.providers[$("s-provider").value];
  $("s-key-wrap").hidden = !p.needs_key;
  $("s-url-wrap").hidden = $("s-provider").value !== "custom";
  $("s-model").placeholder = p.default_model || "model id";
}

async function saveSettings(ev) {
  if (ev.submitter?.value !== "save") return;
  ev.preventDefault();
  const weights = {};
  document.querySelectorAll("[data-w]").forEach((i) => { weights[i.dataset.w] = +i.value; });
  const feeds = $("s-feeds").value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [name, url] = l.includes("|") ? l.split("|").map((x) => x.trim()) : [l, l];
    return { name, url };
  });
  try {
    const aiBody = { provider: $("s-provider").value, model: $("s-model").value, base_url: $("s-url").value };
    if ($("s-key").value.trim()) aiBody.key = $("s-key").value.trim();
    await api("/api/ai/config", aiBody);
    const scorerChanged = $("s-scorer").value !== S.settings.scorer;
    S = await api("/api/settings", {
      profile: profileFrom($("dlg-settings")), scorer: $("s-scorer").value, typesafe_key: $("s-ts").value.trim(),
      weights, feeds, local_feed: $("s-local").checked, days: +$("s-days").value,
    });
    $("dlg-settings").close();
    await loadState();
    await loadNews();
    if (scorerChanged) refresh();
  } catch (e) {
    alert(e.message);
  }
}

/* ------------------------------------------------------------ memory */
function openMemory() {
  const m = S.memory;
  $("m-rules").value = (m.rules || []).join("\n");
  $("m-page-wrap").hidden = !(m.page_rules || []).length;
  $("m-page-rules").innerHTML = (m.page_rules || []).map((r) => `<li>${esc(r)}</li>`).join("");
  const when = m.learned_at ? `Last learned ${ago(m.learned_at)} from ${m.feedback_at_learn} feedback items.` : "Nothing learned yet — give some 👍/👎 with notes.";
  $("m-info").textContent = when + (m.learn_error ? ` ⚠ ${m.learn_error}` : "");
  const chip = (k, v, kind) => `<span class="flag ${v < 0 ? "on" : ""}">${kind} ${esc(k.replace(/_/g, " "))} ${v > 0 ? "+" : ""}${v}</span>`;
  $("m-bias").innerHTML = Object.entries(m.topic_bias || {}).map(([k, v]) => chip(k, v, "topic")).join("")
    + Object.entries(m.source_bias || {}).map(([k, v]) => chip(k, v, "source")).join("");
  $("dlg-memory").showModal();
}

async function saveMemory(ev) {
  if (ev.submitter?.value !== "save") return;
  ev.preventDefault();
  const r = await api("/api/memory", { rules: $("m-rules").value.split("\n") });
  S.memory = r.memory;
  $("dlg-memory").close();
  if (confirm("Rules changed. Re-score the news with them now?")) refresh();
}

async function learnNow() {
  $("m-learn").disabled = true;
  $("m-info").textContent = "Learning from your feedback…";
  try {
    const r = await api("/api/learn", {});
    S.memory = r.memory;
    openMemory();
  } catch (e) {
    $("m-info").textContent = e.message;
  } finally {
    $("m-learn").disabled = false;
  }
}

/* ------------------------------------------------------------ wiring */
$("btn-refresh").onclick = () => refresh();
$("btn-settings").onclick = openSettings;
$("btn-memory").onclick = openMemory;
$("settings-form").addEventListener("submit", saveSettings);
$("memory-form").addEventListener("submit", saveMemory);
$("m-learn").onclick = learnNow;
$("s-provider").onchange = () => { $("s-model").value = ""; syncProviderFields(); };
$("min").oninput = () => {
  $("min-val").textContent = $("min").value;
  try { localStorage.setItem("un-min", $("min").value); } catch { /* optional */ }
  render();
};
$("search").oninput = render;
$("sort").onchange = render;
$("hidden-wrap").addEventListener("toggle", render);
$("topics").onclick = (e) => {
  if (e.target.dataset.topic === undefined) return;
  topicFilter = e.target.dataset.topic || null;
  renderTopics();
  render();
};
$("onboard-save").onclick = async () => {
  S = await api("/api/settings", { profile: profileFrom($("onboard")) });
  await loadState();
  refresh();
};

try { const m = localStorage.getItem("un-min"); if (m) { $("min").value = m; $("min-val").textContent = m; } } catch { /* optional */ }
loadState().then(loadNews).then(() => { if (S.job.running) refresh(); });
