import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPagePayload, FLAG_TAG_AT, generalizeSelector, hashExcerpt, PAGE_EXCERPT_CHARS, scoreTags, settledEnough, tagLines } from "../extension/lib/pagescore.js";

test("buildPagePayload trims fields and derives host from url", () => {
  const p = buildPagePayload(
    { url: "https://ex.com/a", title: "T".repeat(500), text: "x".repeat(9000) },
    ["r1", "r2"], { model: "jev-9" });
  assert.equal(p.page.host, "ex.com");
  assert.ok(p.page.title.length <= 200);
  assert.equal(p.page.text.length, PAGE_EXCERPT_CHARS);
  assert.deepEqual(p.rules, ["r1", "r2"]);
  assert.equal(p.model, "jev-9");
});

test("buildPagePayload defaults model and tolerates junk", () => {
  const p = buildPagePayload({}, null);
  assert.equal(p.model, "jev-1.13.0");
  assert.deepEqual(p.rules, []);
  assert.equal(p.page.host, "");
});

test("scoreTags chips only flags at or above threshold", () => {
  const tags = scoreTags({
    topic: "tech_tool",
    scores: { actionable: 0.8, relevance: 0.5, impact: 0.2, depth: 1.2 },
    flags: { clickbait: 0.9, sensational: 0.1, tragedy: FLAG_TAG_AT, speculation: 0, gossip: 0 },
  });
  assert.equal(tags.topic, "tech_tool");
  assert.equal(tags.scores.length, 4);
  assert.equal(tags.scores[3].value, 1); // clamped
  assert.deepEqual(tags.flags.map((f) => f.flag), ["clickbait", "tragedy"]);
});

test("scoreTags tolerates missing dimensions", () => {
  const tags = scoreTags(null);
  assert.equal(tags.topic, "other");
  assert.equal(tags.scores.length, 4);
  assert.deepEqual(tags.flags, []);
});

test("buildPagePayload carries capped blocks with anchors", () => {
  const blocks = Array.from({ length: 10 }, (_, i) => ({
    hid: "h" + i, heading: "H" + i, excerpt: "e".repeat(1000),
  }));
  blocks.push({ hid: "", excerpt: "e".repeat(500) }); // no anchor → dropped
  const p = buildPagePayload({ url: "https://ex.com/", text: "t", blocks }, []);
  assert.equal(p.blocks.length, 8);
  assert.equal(p.blocks[0].id, "h0");
  assert.ok(p.blocks[0].excerpt.length <= 800);
});

test("settledEnough waits while thin or growing", () => {
  assert.equal(settledEnough(50, 0), false);    // shell: too thin
  assert.equal(settledEnough(5000, 0), true);   // first look with plenty: go
  assert.equal(settledEnough(5000, 1000), false); // still hydrating: wait
  assert.equal(settledEnough(5100, 5000), true);  // stable: go
  assert.equal(settledEnough(300, 5000), false); // shrank to thin (mid-transition?): keep waiting
});
test("buildPagePayload keeps short card excerpts, drops thin ones", () => {
  const p = buildPagePayload({ url: "https://ex.com/", text: "t",
    blocks: [
      { hid: "h0", heading: "H", excerpt: "e".repeat(60) },
      { hid: "h1", heading: "H", excerpt: "e".repeat(30) },
      { hid: "h2", heading: "H", excerpt: "e".repeat(20) },
    ] }, []);
  assert.equal(p.blocks.length, 2);
  assert.equal(p.blocks[0].id, "h0");
});
test("tagLines lists topic, dimensions and raised flags", () => {
  const lines = tagLines(scoreTags({
    topic: "tech_tool",
    scores: { actionable: 0.8, relevance: 0.5, impact: 0.2, depth: 0.6 },
    flags: { clickbait: 0.9, sensational: 0.1, tragedy: 0, speculation: 0, gossip: 0 },
  }));
  assert.ok(lines[0].includes("tech tool"));
  assert.ok(lines.some((l) => l.startsWith("Actionable: 0.8")));
  assert.ok(lines.some((l) => l.includes("Clickbait")));
  assert.deepEqual(tagLines(null), []);
});

test("generalizeSelector drops instance steps, keeps shape", () => {
  assert.equal(generalizeSelector("body > div:nth-child(3) > div.card"),
    "body > div > div.card");
  assert.equal(generalizeSelector(""), "");
});
test("hashExcerpt is stable and discriminating", () => {
  assert.equal(hashExcerpt("same text"), hashExcerpt("same text"));
  assert.notEqual(hashExcerpt("text A"), hashExcerpt("text B"));
  assert.equal(typeof hashExcerpt(""), "string");
});
