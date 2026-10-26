// Ad candidates: heuristic selectors + Jev payload helpers. Pure, testable in node.
// The DOM-touching functions live in page.js (they must stay self-contained for
// chrome.scripting.executeScript); the selector lists here mirror those.

export const OBVIOUS_SELECTORS = [
  '[id^="div-gpt-ad"]',
  '[id*="-ad-"]',
  '[id$="-ad"]',
  '[id*="google_ads"]',
  '[class*="gpt-ad"]',
  'ins.adsbygoogle',
  '[data-ad-slot]',
  '[data-ad-client]',
  '[data-testid="ad"]',
  '[data-testid="advertisement"]',
  '[data-testid^="ad-"]',
  '[data-testid$="-ad"]',
  '[data-testid*="ad-slot"]',
  '[data-testid*="advert"]',
  'iframe[src*="doubleclick.net"]',
  'iframe[src*="googlesyndication.com"]',
  'iframe[src*="amazon-adsystem.com"]',
  'iframe[src*="outbrain.com"]',
  'iframe[src*="taboola.com"]',
  'iframe[src*="criteo.com"]',
];

export const CANDIDATE_SELECTORS = [
  ...OBVIOUS_SELECTORS,
  'aside[aria-label*="ad" i]',
  '[class*="sponsor"]',
  '[class*="promo"]',
  '[class*="adsbox"]',
  '[class*="ad-container"]',
  '[class*="advert"]',
  '[id*="sponsor"]',
  '[id*="promo"]',
  '[id*="popup"]',
  '[class*="popup"]',
  '[class*="overlay-ad"]',
  '[class*="sticky-ad"]',
  'div[class*="newsletter"][class*="popup"]',
];

export const PROMO_TEXT = /(sponsored|advertisement|promoted content|subscribe to our newsletter|special offer|limited time offer|click here to buy)/i;

export const MAX_JEV_CANDIDATES = 20;

/** Tunable hide decision. hideAt: is_ad ≥ this → hide. Below that,
 *  is_ad ≥ hideAtDisrupt + disrupts ≥ disruptAt → hide (Unclutter-style:
 *  borderline promo is fine until it disrupts reading). */
export const DEFAULT_ADS_THRESHOLDS = { hideAt: 0.55, hideAtDisrupt: 0.35, disruptAt: 0.6 };

export const DEFAULT_JEV_MODEL = "jev-1.13.0";

/** Clamp user-edited thresholds into sane ranges (never trust stored settings). */
export function normalizeThresholds(t) {
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const d = DEFAULT_ADS_THRESHOLDS;
  return {
    hideAt: clamp(num(t?.hideAt, d.hideAt), 0, 1),
    hideAtDisrupt: clamp(num(t?.hideAtDisrupt, d.hideAtDisrupt), 0, 1),
    disruptAt: clamp(num(t?.disruptAt, d.disruptAt), 0, 1),
  };
}

/** Payload the background sends to POST /ads/score on the bridge. */
export function buildAdsPayload(candidates, page, rules, opts = {}) {
  return {
    candidates: (candidates || []).slice(0, MAX_JEV_CANDIDATES).map((c) => ({
      id: String(c.id ?? ""),
      tag: String(c.tag ?? "").slice(0, 20),
      id_class: String(c.id_class ?? "").slice(0, 200),
      size: String(c.size ?? "").slice(0, 40),
      text: String(c.text ?? "").slice(0, 300),
      html_hint: String(c.html_hint ?? "").slice(0, 300),
    })),
    page: { host: String(page?.host ?? "").slice(0, 80), title: String(page?.title ?? "").slice(0, 120) },
    rules: Array.isArray(rules) ? rules.slice(0, 12) : [],
    thresholds: normalizeThresholds(opts.thresholds),
    model: String(opts.model || DEFAULT_JEV_MODEL).slice(0, 60) || DEFAULT_JEV_MODEL,
  };
}

/** Client-side mirror of bridge/ads.py should_hide (kept in sync, tested).
 *  Thresholds may be passed as an object; the old positional form still works. */
export function shouldHide(isAd, disrupts, hideAt = 0.55, disruptAt = 0.6, hideAtDisrupt = 0.35) {
  let h, d, hd;
  if (hideAt && typeof hideAt === "object") ({ hideAt: h, disruptAt: d, hideAtDisrupt: hd } = normalizeThresholds(hideAt));
  else if (hideAt == null) ({ hideAt: h, disruptAt: d, hideAtDisrupt: hd } = DEFAULT_ADS_THRESHOLDS);
  else { h = hideAt; d = disruptAt; hd = hideAtDisrupt; }
  return isAd >= h || (isAd >= hd && disrupts >= d);
}
