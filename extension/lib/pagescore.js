// Instant Jev page score: payload builder + tag chips. Pure, testable in node.
// The bridge computes the 0-100 score from Jev's typed judgments
// (bridge/pages.py); here we only shape the request and turn the returned
// dimensions into the "why the score" chips shown under the gauge.

import { DEFAULT_JEV_MODEL } from "./ads.js";

export const PAGE_EXCERPT_CHARS = 2000;
/** Flags at or above this probability get a chip under the score. */
export const FLAG_TAG_AT = 0.5;
/** Per-section excerpts scored for badges (mirrors bridge/pages.py caps). */
export const MAX_BLOCKS = 8;
export const BLOCK_EXCERPT_CHARS = 800;
/** Cards carry little text; Jev judges headlines fine (clickbait/gossip first).
    Headline-anchored blocks go down to 25 chars, bare containers need 50. */
export const MIN_BLOCK_CHARS = 25;

/** FNV-1a hash: cache key for block excerpts, so identical sections
    (recurring rails, syndicated cards) reuse one Jev judgment. */
export function hashExcerpt(text) {  let h = 0x811c9dc5;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Flags → chips. `cat` reuses a bullshit-category id for its colour. */
export const FLAG_TAGS = [
  { flag: "clickbait", cat: "clickbait", label: "Clickbait" },
  { flag: "sensational", cat: "sensationalism", label: "Sensationalism" },
  { flag: "tragedy", cat: "tragedy", label: "Tragedy as entertainment" },
  { flag: "speculation", cat: "speculation", label: "Speculation" },
  { flag: "gossip", cat: "gossip", label: "Gossip" },
];

export const SCORE_DIMS = [
  { id: "actionable", label: "Actionable" },
  { id: "relevance", label: "Relevant to you" },
  { id: "impact", label: "Impact on you" },
  { id: "depth", label: "Depth" },
];

/** Payload the background sends to POST /page/score on the bridge. */
export function buildPagePayload(page, rules, opts = {}) {
  const host = String(page?.host ?? newHost(page?.url)).slice(0, 80);
  return {
    page: {
      host,
      title: String(page?.title ?? "").slice(0, 200),
      text: String(page?.text ?? "").slice(0, PAGE_EXCERPT_CHARS),
    },
    blocks: (Array.isArray(page?.blocks) ? page.blocks : []).slice(0, MAX_BLOCKS).map((b, i) => ({
      id: String(b?.hid ?? ("b" + i)),
      hid: String(b?.hid ?? ""),
      heading: String(b?.heading ?? "").slice(0, 80),
      excerpt: String(b?.excerpt ?? "").slice(0, BLOCK_EXCERPT_CHARS),
    })).filter((b) => b.hid && b.excerpt.length >= MIN_BLOCK_CHARS),
    rules: Array.isArray(rules) ? rules.slice(0, 12) : [],
    model: String(opts.model || DEFAULT_JEV_MODEL).slice(0, 60) || DEFAULT_JEV_MODEL,
  };
}

function newHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Settlement rule for hydrating pages: enough text AND (first look or barely
    grown since the last look). Pure so node tests can pin the thresholds. */
export const SETTLE_MIN_CHARS = 400;
export const SETTLE_GROWTH = 0.25;
export function settledEnough(len, prev) {
  return len >= SETTLE_MIN_CHARS && (prev <= 0 || (len - prev) / prev <= SETTLE_GROWTH);
}

/** Generalize a picked selector so it matches similar cards next time:
    drop instance-specific :nth-child() steps, keep classes and ids. */
export function generalizeSelector(sel) {
  return String(sel || "").replace(/:nth-child\(\d+\)/g, "").replace(/\s*>\s*/g, " > ")
    .replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Tooltip lines for a block badge: topic + dimensions + raised flags. */
export function tagLines(tags) {
  if (!tags) return [];
  const lines = [`Topic: ${String(tags.topic || "other").replace(/_/g, " ")}`];
  for (const d of tags.scores || []) lines.push(`${d.label}: ${d.value.toFixed(1)}`);
  for (const f of tags.flags || []) lines.push(`⚑ ${f.label} (${f.p.toFixed(2)})`);
  return lines;
}
/** {topic, scores, flags} chips for the returned dimensions. */
export function scoreTags(dims) {
  const num = (v) => (Number.isFinite(+v) ? +v : 0);
  return {
    topic: typeof dims?.topic === "string" ? dims.topic : "other",
    scores: SCORE_DIMS.map((d) => ({ ...d, value: Math.max(0, Math.min(1, num(dims?.scores?.[d.id]))) })),
    flags: FLAG_TAGS.filter((f) => num(dims?.flags?.[f.flag]) >= FLAG_TAG_AT)
      .map((f) => ({ ...f, p: Math.max(0, Math.min(1, num(dims.flags[f.flag]))) })),
  };
}
