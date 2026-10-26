import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAdsPayload, DEFAULT_ADS_THRESHOLDS, normalizeThresholds, OBVIOUS_SELECTORS, shouldHide } from "../extension/lib/ads.js";

test("shouldHide mirrors bridge/ads.py thresholds", () => {
  assert.equal(shouldHide(0.9, 0.0), true);    // clearly an ad
  assert.equal(shouldHide(0.55, 0.0), true);   // at threshold
  assert.equal(shouldHide(0.54, 0.0), false);  // just under
  assert.equal(shouldHide(0.4, 0.7), true);    // borderline + disruptive
  assert.equal(shouldHide(0.4, 0.5), false);   // borderline, not disruptive
  assert.equal(shouldHide(0.1, 0.9), false);   // disruptive but not an ad
});

test("shouldHide accepts a thresholds object (extension options)", () => {
  const t = { hideAt: 0.9, hideAtDisrupt: 0.1, disruptAt: 0.5 };
  assert.equal(shouldHide(0.9, 0.0, t), true);
  assert.equal(shouldHide(0.85, 0.0, t), false);
  assert.equal(shouldHide(0.2, 0.9, t), true);
  assert.equal(shouldHide(0.5, 0.0, null), false); // null → defaults
});

test("normalizeThresholds clamps user input", () => {
  assert.deepEqual(normalizeThresholds(undefined), DEFAULT_ADS_THRESHOLDS);
  assert.deepEqual(normalizeThresholds({ hideAt: 99, hideAtDisrupt: -5 }),
    { hideAt: 1, hideAtDisrupt: 0, disruptAt: 0.6 });
});

test("obvious selectors cover the classic ad markers", () => {
  const all = OBVIOUS_SELECTORS.join(",");
  assert.ok(all.includes("div-gpt-ad") && all.includes("adsbygoogle") && all.includes("doubleclick"));
});

test("obvious selectors do not treat generic data-testid values as ads", () => {
  const all = OBVIOUS_SELECTORS.join(",");
  assert.ok(!all.includes('[data-testid*="ad"]'));
  assert.ok(all.includes('[data-testid^="ad-"]'));
  assert.ok(all.includes('[data-testid$="-ad"]'));
});

test("buildAdsPayload caps candidates and trims fields", () => {
  const cands = Array.from({ length: 30 }, (_, i) => ({
    id: i, tag: "div", id_class: "x".repeat(500), size: "300x250",
    text: "y".repeat(900), html_hint: "z".repeat(900),
  }));
  const p = buildAdsPayload(cands, { host: "ex.com", title: "T" }, ["r1"]);
  assert.equal(p.candidates.length, 20);
  assert.ok(p.candidates[0].text.length <= 300 && p.candidates[0].id_class.length <= 200);
  assert.deepEqual(p.page, { host: "ex.com", title: "T" });
  assert.deepEqual(p.rules, ["r1"]);
  assert.deepEqual(p.thresholds, DEFAULT_ADS_THRESHOLDS);
  assert.equal(p.model, "jev-1.13.0");
  const custom = buildAdsPayload([], {}, [], { thresholds: { hideAt: 0.9 }, model: "jev-9" });
  assert.equal(custom.thresholds.hideAt, 0.9);
  assert.equal(custom.thresholds.disruptAt, 0.6); // unspecified → default
  assert.equal(custom.model, "jev-9");
});
