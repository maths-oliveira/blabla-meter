// Functions injected into the page with chrome.scripting.executeScript({func}).
// Each must be self-contained (no closures over module scope).

export function extractPage(opts) {
  const skip = "script,style,noscript,svg,form,button,[aria-hidden=true],.bbla-badge,mark.bbla-mark";
  const textOf = (root) => {
    try {
      const clone = root.cloneNode(true);
      clone.querySelectorAll(skip).forEach((n) => n.remove());
      // Chrome removal is structural, not tag-based: <header> also wraps hero
      // stories and <aside> wraps related rails. Drop <nav> always; drop
      // header/footer/aside only when top-level or containing navigation
      // (the masthead), never the nested hero/section wrappers.
      clone.querySelectorAll("nav").forEach((n) => n.remove());
      clone.querySelectorAll("header,footer,aside").forEach((n) => {
        try { if (n.parentElement === clone || n.querySelector("nav")) n.remove(); } catch {}
      });
      return (clone.innerText || clone.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
    } catch { return ""; }
  };
  // Feed front pages bury the feed next to (or without) any article element:
  // analyze whichever container holds the most text, not the first match.
  // Ties go to the later (larger) candidate: on feeds main ties body while the
  // hero section lives outside main, so body must win for badges to land where
  // the reader looks.
  const cands = [document.querySelector("article"), document.querySelector("main"),
    document.querySelector("[role=main]"), document.body].filter(Boolean);
  let pick = document.body, text = "";
  for (const c of cands) {
    const t = textOf(c);
    if (t.length >= text.length) { pick = c; text = t; }
  }
  if (text.length < 400 && pick !== document.body) text = (document.body.innerText || "").trim();
  const sel = String(window.getSelection() || "").trim();
  // Unclutter-style outline + reading time: headings in document order, word count.
  // Single selector (the old "article h1, …, h1" list matched the same element
  // twice), scoped to the analyzed container, chrome (nav/header/…) skipped;
  // badges from a previous scoring pass are stripped so they never pollute the
  // text, and anchors use the element id for badge placement.
  const headings = [];
  // Same structural rule as the text clone: only top-level (or nav-bearing)
  // header/footer/aside counts as chrome; nested hero/section wrappers keep
  // their headings and badges.
  const inChrome = (h) => {
    try {
      const c = h.closest("nav,header,footer,aside");
      if (!c) return false;
      if (c.tagName === "NAV") return true;
      const p = c.parentElement;
      return !!p && (p === pick || p === document.body);
    } catch { return false; }
  };
  try {
    pick.querySelectorAll("h1, h2, h3").forEach((h, i) => {
      if (inChrome(h)) return;
      const t = (h.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120);
      if (!t || headings.length >= 40) return;
      if (!h.id) h.id = "bbla-h" + i;
      headings.push({ level: +h.tagName.slice(1), text: t, id: h.id });
    });
  } catch {}
  // Scoreable blocks for the section badges, capped to keep the Jev request
  // small: learned ◉-score areas first (the reader taught them), then headed
  // sections, standalone cards (article/section), and content divs — feed
  // front pages are mostly bare headline cards.
  const blocks = [];
  const seenText = new Set();
  const pushBlock = (el, headingText, min = 50) => {
    if (!el || blocks.length >= 8) return;
    const t = (el.innerText || "").replace(/\s+/g, " ").trim();
    if (t.length < min || seenText.has(t.slice(0, 100))) return; // thin, or same card via two paths
    if (!el.id) el.id = "bbla-b" + blocks.length;
    seenText.add(t.slice(0, 100));
    blocks.push({ hid: el.id, heading: String(headingText || t.slice(0, 80)), excerpt: t.slice(0, 800) });
  };
  try {
    // Learned score areas FIRST: selectors the reader taught with ◉ score
    // (passed in opts — injected code can't read settings). Priority over
    // auto blocks, so re-scoring keeps what was taught even on dense pages
    // where headings alone would already fill the 8-block cap.
    // Document scope (not pick): generalized selectors are rooted at body
    // and miss when pick is article/main. Cards can be short — accept ≥25
    // chars like the picker does.
    try {
      const learned = ((opts && opts.extraBlocks && opts.extraBlocks[location.host]) || []).slice(0, 20);
      for (const sel of learned) {
        let els = [];
        try { els = [...document.querySelectorAll(String(sel))].slice(0, 4); } catch { els = []; }
        for (const el of els) {
          if (!pick.contains(el)) continue;
          if (inChrome(el)) continue;
          pushBlock(el, "", 25);
          if (blocks.length >= 8) break;
        }
        if (blocks.length >= 8) break;
      }
    } catch {}
    const inView = (h) => {
      try {
        const r = h.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < (window.innerHeight || 800);
      } catch { return false; }
    };
    // Above-the-fold headings first: badges land where the reader is looking,
    // not on stories far below. Document order within each group.
    const vis = [], rest = [];
    for (const h of pick.querySelectorAll("h1, h2, h3")) {
      if (inChrome(h)) continue;
      (inView(h) ? vis : rest).push(h);
    }
    const heads = [...vis, ...rest].slice(0, 12);
    for (const h of heads) {
      let excerpt = "";
      for (let el = h.nextElementSibling; el && !/^H[1-3]$/.test(el.tagName); el = el.nextElementSibling) {
        if (el.querySelectorAll) excerpt += " " + (el.innerText || "");
        if (excerpt.length >= 800) break;
      }
      excerpt = excerpt.replace(/\s+/g, " ").trim();
      if (excerpt.length < 50) {
        // card-style markup: closest section/article/div container text instead
        let p = h.parentElement;
        for (let up = 0; up < 3 && p && p !== pick && p !== document.body; up++, p = p.parentElement) {
          if (/^(SECTION|ARTICLE|DIV|LI|MAIN)$/.test(p.tagName)) {
            const t = (p.innerText || "").replace(/\s+/g, " ").trim();
            if (t.length >= 50) { excerpt = t.slice(0, 800); break; }
          }
        }
      }
      // Headline first: attaching it enriches thin sections, and a bare
      // headline alone (≥25 chars) is still worth a clickbait/gossip verdict.
      const hText = (h.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (excerpt.length < 50) excerpt = (hText + " " + excerpt).trim();
      if (excerpt.length >= 25) {
        if (!h.id) h.id = "bbla-hx-" + blocks.length;
        const key = excerpt.slice(0, 100);
        if (!seenText.has(key)) {
          seenText.add(key);
          blocks.push({ hid: h.id, heading: hText, excerpt: excerpt.slice(0, 800) });
        }
      }
      if (blocks.length >= 8) break;
    }
    if (blocks.length < 8) {
      for (const el of pick.querySelectorAll("article, section")) {
        if (inChrome(el)) continue;
        pushBlock(el);
        if (blocks.length >= 8) break;
      }
    }
    if (blocks.length < 8) {
      for (const el of pick.children) {
        if (!el.tagName || /^(SCRIPT|STYLE|NOSCRIPT|NAV|HEADER|FOOTER|ASIDE|FORM|BUTTON)$/.test(el.tagName)) continue;
        pushBlock(el);
        if (blocks.length >= 8) break;
      }
    }
  } catch {}
  const words = text.split(/\s+/).filter(Boolean).length;
  return { title: document.title, url: location.href, text: sel.length > 200 ? sel : text, selection: sel.length > 200, headings, words, blocks };
}

export function focusHeading(id) {
  const el = document.getElementById(String(id || ""));
  if (!el) return false;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

export function clearHighlights() {
  document.querySelectorAll("mark.bbla-mark").forEach((m) => {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  });
  document.getElementById("bbla-style")?.remove();
  return true;
}

export function highlightQuotes(highlights, categories) {
  // remove old marks first
  document.querySelectorAll("mark.bbla-mark").forEach((m) => {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  });
  if (!document.getElementById("bbla-style")) {
    const st = document.createElement("style");
    st.id = "bbla-style";
    st.textContent = "mark.bbla-mark{background:var(--bbla-c)!important;background:color-mix(in srgb,var(--bbla-c) 32%,transparent)!important;color:inherit!important;border-bottom:2px solid var(--bbla-c);border-radius:2px;cursor:help;padding:0 1px}"
      + "mark.bbla-mark.bbla-focus{outline:3px solid var(--bbla-c);outline-offset:2px}";
    document.head.appendChild(st);
  }
  const colors = Object.fromEntries(categories.map((c) => [c.id, c.color || "#f59e0b"]));
  const names = Object.fromEntries(categories.map((c) => [c.id, c.name]));

  // Concatenate visible text nodes; remember where each node starts.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (p.closest("script,style,noscript,textarea,input,select,mark.bbla-mark")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  let full = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: full.length });
    full += n.nodeValue;
  }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = (q) => new RegExp(esc(q.trim()).replace(/[\s ]+/g, "[\\s\\u00a0]+").replace(/["“”]/g, "[\"“”]").replace(/['‘’]/g, "['‘’]"), "i");

  const found = [];
  highlights.forEach((h, idx) => {
    let m = pattern(h.quote).exec(full);
    if (!m && h.quote.length > 70) m = pattern(h.quote.slice(0, 60)).exec(full); // model trimmed/paraphrased the tail
    if (!m) return;
    found.push({ idx, start: m.index, end: m.index + m[0].length, h });
  });
  // wrap from the end so earlier offsets stay valid
  found.sort((a, b) => b.start - a.start);
  let lastStart = Infinity;
  const ok = new Set();
  for (const f of found) {
    if (f.end > lastStart) continue; // overlapping another highlight
    lastStart = f.start;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const { node, start } = nodes[i];
      const nEnd = start + node.nodeValue.length;
      if (nEnd <= f.start || start >= f.end) continue;
      const a = Math.max(0, f.start - start);
      const b = Math.min(node.nodeValue.length, f.end - start);
      const range = document.createRange();
      range.setStart(node, a);
      range.setEnd(node, b);
      const mark = document.createElement("mark");
      mark.className = "bbla-mark";
      mark.dataset.bbla = String(f.idx);
      mark.style.setProperty("--bbla-c", colors[f.h.category] || "#f59e0b");
      mark.title = `Blabla Meter · ${names[f.h.category] || f.h.category}: ${f.h.why}`;
      try { range.surroundContents(mark); } catch { continue; }
    }
    ok.add(f.idx);
  }
  return [...ok];
}

export function focusHighlight(idx) {
  document.querySelectorAll("mark.bbla-mark.bbla-focus").forEach((m) => m.classList.remove("bbla-focus"));
  const marks = document.querySelectorAll(`mark.bbla-mark[data-bbla="${idx}"]`);
  marks.forEach((m) => m.classList.add("bbla-focus"));
  marks[marks.length - 1]?.scrollIntoView({ behavior: "smooth", block: "center" });
  return marks.length > 0;
}

// --- Per-block score badges: a small circle with the section's Jev score,
// anchored to its heading. Hover (title) shows the Jev tags, plus any AI
// deep-dive insights matched to that block. Self-contained like the rest. ---

export function clearBlockScores() {
  document.querySelectorAll(".bbla-badge").forEach((b) => b.remove());
  document.getElementById("bbla-badge-style")?.remove();
  return true;
}

/* Resolve a picked element by selector and ensure it has an id for badge
   anchoring. Self-contained; the badge itself goes through showBlockScores. */
export function ensurePickedId(selector) {
  let el = null;
  try { el = document.querySelector(String(selector)); } catch {}
  if (!el) return null;
  if (!el.id) el.id = "bbla-picked-" + Date.now().toString(36);
  return el.id;
}

/* All elements matching a learned group selector (capped): assigns stable-ish
   ids and returns [{hid, excerpt}] for scoring. Self-contained. */
export function collectGroup(selector, hid) {
  let els = [];
  try { els = [...document.querySelectorAll(String(selector))].slice(0, 7); } catch {}
  // Unique-id selectors (e.g. #bbla-h3) match only the picked element:
  // fall back to same-tag siblings so "similar items" still get scored.
  if (els.length <= 1 && hid) {
    try {
      const picked = document.getElementById(String(hid));
      const parent = picked?.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === picked.tagName && c !== picked).slice(0, 6);
        els = picked ? [picked, ...sibs] : sibs;
      }
    } catch {}
  }
  const out = [];
  for (const el of els) {
    const t = ((el.innerText || el.textContent || "").replace(/\s+/g, " ").trim()).slice(0, 800);
    if (t.length < 25) continue;
    if (!el.id) el.id = "bbla-g" + out.length + "-" + Date.now().toString(36);
    out.push({ hid: el.id, excerpt: t });
    if (out.length >= 7) break;
  }
  return out;
}

/* Remove the light-grey scoring overlay (pending state). Pass the picked hid
   to clear just it, or nothing to clear all. Self-contained. */
export function clearPendingScore(hid) {
  try {
    if (hid) document.getElementById(String(hid))?.removeAttribute("data-bbla-scoring");
    else document.querySelectorAll("[data-bbla-scoring]").forEach((el) => el.removeAttribute("data-bbla-scoring"));
    if (!document.querySelector("[data-bbla-scoring]")) document.getElementById("bbla-scoring-style")?.remove();
  } catch {}
  return true;
}

export function showBlockScores(items, opts) {
  // Fully self-contained: nothing but args and the DOM exists in-page
  // (sibling module functions are NOT available to injected code).
  // keep:true adds badges without clearing existing ones (picked/group flow);
  // the default full refresh clears first.
  if (!(opts && opts.keep)) {
    document.querySelectorAll(".bbla-badge").forEach((b) => b.remove());
    document.getElementById("bbla-badge-style")?.remove();
  }
  if (!items || !items.length) return { shown: 0, missing: 0 };
  if (!document.getElementById("bbla-badge-style")) {
    const st = document.createElement("style");
    st.id = "bbla-badge-style";
    st.textContent = ".bbla-badge{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;border-radius:999px;color:#fff;font:700 12px/1 system-ui,sans-serif;padding:0 5px;margin-right:6px;vertical-align:2px;cursor:help}.bbla-badge::before{content:attr(data-score)}h1>.bbla-badge,h2>.bbla-badge,h3>.bbla-badge,h4>.bbla-badge,h5>.bbla-badge,h6>.bbla-badge{vertical-align:middle;margin-right:8px}";
    document.head.appendChild(st);
  }
  let shown = 0, missing = 0;
  for (const it of items) {
    const h = document.getElementById(String(it.hid || ""));
    if (!h) { missing++; continue; }
    // The score arrived: drop the light-grey pending overlay on this element.
    try { h.removeAttribute("data-bbla-scoring"); } catch {}
    if (!document.querySelector("[data-bbla-scoring]")) document.getElementById("bbla-scoring-style")?.remove();
    const s = Math.max(0, Math.min(100, Math.round(+it.score)));
    const b = document.createElement("span");
    b.className = "bbla-badge";
    // The number is CSS-generated (::before), so it never leaks into innerText
    // when headings and section excerpts are re-read for the next scoring.
    b.dataset.score = Number.isFinite(s) ? String(s) : "?";
    b.style.background = !Number.isFinite(s) ? "#64748b" : s >= 60 ? "#16a34a" : s >= 35 ? "#d97706" : "#dc2626";
    const lines = [`Blabla Meter · section score ${b.dataset.score}/100`];
    for (const t of it.tags || []) lines.push(`· ${t}`);
    for (const a of it.ai || []) lines.push(`AI: ${a}`);
    b.title = lines.join("\n");
    // Inside real headings, so the badge sits on the heading line instead of
    // reading as the end of the previous section. Card headlines with
    // line-clamp/ellipsis would clip an inner badge: those get it just before.
    const cs = getComputedStyle(h);
    const clamped = (cs.webkitLineClamp && cs.webkitLineClamp !== "none") || cs.textOverflow === "ellipsis" || cs.overflow === "hidden";
    if (/^H[1-6]$/.test(h.tagName) && !clamped) h.insertBefore(b, h.firstChild);
    else if (h.parentElement) h.parentElement.insertBefore(b, h);
    else h.insertBefore(b, h.firstChild);
    shown++;
  }
  return { shown, missing };
}

// --- Ad-block (injected the same way; each function stays self-contained) ---

export function collectAdCandidates() {
  const OBVIOUS = [
    '[id^="div-gpt-ad"]', '[id*="-ad-"]', '[id$="-ad"]', '[id*="google_ads"]',
    '[class*="gpt-ad"]', 'ins.adsbygoogle', '[data-ad-slot]', '[data-ad-client]',
    '[data-testid*="ad"]', 'iframe[src*="doubleclick.net"]',
    'iframe[src*="googlesyndication.com"]', 'iframe[src*="amazon-adsystem.com"]',
    'iframe[src*="outbrain.com"]', 'iframe[src*="taboola.com"]', 'iframe[src*="criteo.com"]',
  ];
  const EXTRA = [
    '[class*="sponsor"]', '[class*="promo"]', '[class*="adsbox"]',
    '[class*="ad-container"]', '[class*="advert"]', '[id*="sponsor"]',
    '[id*="promo"]', '[id*="popup"]', '[class*="popup"]',
    '[class*="overlay-ad"]', '[class*="sticky-ad"]',
  ];
  const PROMO = /(sponsored|advertisement|promoted content|subscribe to our newsletter|special offer|limited time offer|click here to buy)/i;
  const seen = new Set();
  const out = [];
  const push = (el, obvious) => {
    if (!el || el.nodeType !== 1 || seen.has(el)) return;
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
    if (r.width === 0 && r.height === 0 && !el.textContent) return; // detached/hidden
    seen.add(el);
    const idx = out.length;
    el.setAttribute("data-bbla-ad", String(idx));
    const cls = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 5).join(".");
    const text = ((el.innerText || el.textContent || "").replace(/\s+/g, " ").trim()).slice(0, 300);
    let hint = "";
    const src = el.getAttribute("src") || el.querySelector?.("iframe")?.getAttribute("src") || "";
    if (src) { try { hint = "iframe:" + new URL(src, location.href).host; } catch { hint = "iframe:" + src.slice(0, 60); } }
    else if (el.getAttribute("role")) hint = "role:" + el.getAttribute("role");
    else if (/fixed|sticky/i.test(getComputedStyle(el).position || "")) hint = "position:" + getComputedStyle(el).position;
    out.push({
      id: String(idx), tag: el.tagName.toLowerCase(),
      id_class: ((el.id ? "#" + el.id : "") + (cls ? "." + cls : "")).slice(0, 200),
      size: Math.round(r.width) + "x" + Math.round(r.height),
      text, html_hint: hint.slice(0, 300), obvious: !!obvious,
      promoText: PROMO.test(text.slice(0, 500)),
    });
    if (out.length >= 60) return;
  };
  document.querySelectorAll(OBVIOUS.join(",")).forEach((el) => push(el, true));
  if (out.length < 60) document.querySelectorAll(EXTRA.join(",")).forEach((el) => push(el, false));
  return { url: location.href, host: location.host, title: document.title, candidates: out };
}

export function hideAdNodes(ids) {
  let n = 0;
  for (const id of ids || []) {
    const el = document.querySelector(`[data-bbla-ad="${CSS.escape(String(id))}"]`);
    if (!el || el.hasAttribute("data-bbla-ad-hidden")) continue;
    el.setAttribute("data-bbla-ad-was-display", el.style.display || "");
    el.style.setProperty("display", "none", "important");
    el.setAttribute("data-bbla-ad-hidden", "1");
    n++;
  }
  return n;
}

export function showAdNodes() {
  const els = document.querySelectorAll("[data-bbla-ad-hidden]");
  els.forEach((el) => {
    el.style.display = el.getAttribute("data-bbla-ad-was-display") || "";
    el.removeAttribute("data-bbla-ad-hidden");
    el.removeAttribute("data-bbla-ad-was-display");
    el.removeAttribute("data-bbla-ad");
  });
  // elements collected but never hidden still carry the marker: clean them too
  document.querySelectorAll("[data-bbla-ad]").forEach((el) => el.removeAttribute("data-bbla-ad"));
  return els.length;
}

export function countHiddenAds() {
  return document.querySelectorAll("[data-bbla-ad-hidden]").length;
}

// --- Manual element blocking (Unclutter-style "block element") ---
// Saved per site: settings.customBlocks = {host: [selector, ...]}.

export function applyCustomBlocks(selectors) {
  let n = 0;
  for (const sel of selectors || []) {
    try {
      document.querySelectorAll(String(sel)).forEach((el) => {
        if (el.hasAttribute("data-bbla-blocked")) return;
        el.setAttribute("data-bbla-blocked", "1");
        el.style.setProperty("display", "none", "important");
        n++;
      });
    } catch {}
  }
  return n;
}

export function clearCustomBlocks() {
  const els = document.querySelectorAll("[data-bbla-blocked]");
  els.forEach((el) => {
    el.style.display = "";
    el.removeAttribute("data-bbla-blocked");
  });
  return els.length;
}

export function startPicker(mode) {
  const scoring = String(mode || "") === "score";
  if (document.getElementById("bbla-picker-style")) return "already";
  const st = document.createElement("style");
  st.id = "bbla-picker-style";
  st.textContent = ".bbla-pick-hover{outline:3px solid #7c3aed!important;outline-offset:2px;cursor:crosshair!important}"
    + "#bbla-picker-hint{position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1c1917;color:#fff;padding:8px 14px;border-radius:8px;font:14px system-ui}";
  document.head.appendChild(st);
  const hint = document.createElement("div");
  hint.id = "bbla-picker-hint";
  hint.textContent = scoring ? "Click a section to score it (learned for this site) · Esc to cancel"
    : "Click an element to block it on this site · Esc to cancel";
  document.body.appendChild(hint);
  const cssPath = (el) => {
    if (!el || el === document.body) return "body";
    if (el.id) return "#" + CSS.escape(el.id);
    const cls = (el.getAttribute("class") || "").split(/\s+/).filter((c) => c && !c.startsWith("bbla-")).slice(0, 2);
    if (cls.length) return el.tagName.toLowerCase() + "." + cls.map((c) => CSS.escape(c)).join(".");
    let sib = el, nth = 1;
    while ((sib = sib.previousElementSibling)) nth++;
    return cssPath(el.parentElement) + " > " + el.tagName.toLowerCase() + ":nth-child(" + nth + ")";
  };
  let hovered = null;
  const over = (e) => {
    e.preventDefault(); e.stopPropagation();
    hovered?.classList.remove("bbla-pick-hover");
    hovered = e.target.closest("div,section,aside,iframe,ins,header,footer,figure,video") || e.target;
    hovered.classList.add("bbla-pick-hover");
  };
  const click = (e) => {
    e.preventDefault(); e.stopPropagation();
    const el = hovered || e.target;
    const selector = cssPath(el);
    if (scoring) {
      // Assign the badge anchor BEFORE stopping: the background badges this
      // exact hid, so a generic selector (e.g. #dismissible matching many
      // cards) can't land the badge on the wrong card via querySelector.
      let hid = null;
      try {
        // Duplicate ids exist in the wild (e.g. YouTube reuses
        // id="dismissible" per card): getElementById would resolve to the
        // first card, not the clicked one. Force a unique id then.
        if (!el.id || document.getElementById(el.id) !== el) el.id = "bbla-picked-" + Date.now().toString(36);
        hid = el.id;
      } catch { try { hid = el.id || null; } catch {} }
      const excerpt = ((el.innerText || el.textContent || "").replace(/\s+/g, " ").trim()).slice(0, 800);
      // Group selector for learning: matches the picked card AND its
      // siblings on the next visit. An instance selector alone (often just
      // `#some-id`) would only ever match this one element again.
      let groupSelector = null;
      try {
        const parent = el.parentElement;
        if (parent) {
          const sibs = [...parent.children].filter((c) => c.tagName === el.tagName);
          if (sibs.length >= 2) {
            const myCls = (el.getAttribute("class") || "").split(/\s+/).filter((c) => c && !c.startsWith("bbla-"));
            const shared = myCls.filter((c) => sibs.every((s) => { try { return s.classList.contains(c); } catch { return false; } })).slice(0, 1);
            groupSelector = cssPath(parent) + " > " + el.tagName.toLowerCase() + shared.map((c) => "." + CSS.escape(c)).join("");
          }
        }
      } catch {}
      // Immediate feedback, kept until the score badge replaces it: light-grey
      // overlay + loading sign on the exact clicked element (cleared by the
      // background via clearPendingScore / showBlockScores, success or fail).
      try {
        el.setAttribute("data-bbla-scoring", "1");
        if (!document.getElementById("bbla-scoring-style")) {
          const s = document.createElement("style");
          s.id = "bbla-scoring-style";
          s.textContent = "[data-bbla-scoring]{outline:3px solid #7c3aed!important;outline-offset:2px;background:rgba(148,163,184,0.35)!important;position:relative!important}"
            + "[data-bbla-scoring]::after{content:\"\\23F3 scoring…\";position:absolute;top:4px;right:4px;z-index:2147483646;background:#1c1917;color:#fff;font:700 12px/1.4 system-ui,sans-serif;padding:3px 8px;border-radius:999px;pointer-events:none}";
          document.head.appendChild(s);
        }
      } catch {}
      stop();
      try { chrome.runtime.sendMessage({ type: "scoreElement", host: location.host, selector, excerpt, hid, groupSelector }); }
      catch {}
      return false;
    }
    stop();
    try {
      el.style.setProperty("display", "none", "important");
      el.setAttribute("data-bbla-blocked", "1");
    } catch {}
    chrome.runtime.sendMessage({ type: "blockSelector", host: location.host, selector });
    return false;
  };
  const key = (e) => { if (e.key === "Escape") stop(); };
  function stop() {
    document.removeEventListener("mouseover", over, true);
    document.removeEventListener("click", click, true);
    document.removeEventListener("keydown", key, true);
    hovered?.classList.remove("bbla-pick-hover");
    document.getElementById("bbla-picker-style")?.remove();
    document.getElementById("bbla-picker-hint")?.remove();
  }
  document.addEventListener("mouseover", over, true);
  document.addEventListener("click", click, true);
  document.addEventListener("keydown", key, true);
  return "picking";
}
