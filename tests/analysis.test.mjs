import { test } from "node:test";
import assert from "node:assert/strict";
import { chat, endpointFor, extractJson } from "../extension/lib/ai.js";
import { EMPTY_MEMORY, addFeedback, applyRules, buildMessages, mergeCategories, needsRelearn, normalizeAnalysis } from "../extension/lib/analysis.js";

test("extractJson tolerates fences and chatter", () => {
  assert.deepEqual(extractJson('Sure:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('x {"a":{"b":2}} y'), { a: { b: 2 } });
  assert.throws(() => extractJson("nope"));
});

test("endpointFor handles bridge and custom", () => {
  assert.equal(endpointFor({ provider: "bridge", bridgeUrl: "http://127.0.0.1:9/" }), "http://127.0.0.1:9/v1/chat/completions");
  assert.equal(endpointFor({ provider: "custom", baseUrl: "https://x/v1" }), "https://x/v1/chat/completions");
  assert.equal(endpointFor({ provider: "zen" }), "https://opencode.ai/zen/v1/chat/completions");
});

test("chat sends key, go session header, and surfaces provider errors", async () => {
  let seen;
  const ok = async (url, opts) => { seen = { url, opts }; return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] })); };
  assert.equal(await chat({ provider: "go", key: "k" }, [{ role: "user", content: "x" }], { fetchImpl: ok }), "hi");
  assert.equal(seen.opts.headers.Authorization, "Bearer k");
  assert.match(seen.opts.headers["x-opencode-session"], /^bbla-/);
  assert.equal(JSON.parse(seen.opts.body).model, "glm-5.3-flash");
  const bad = async () => new Response(JSON.stringify({ error: { message: "Insufficient funds" } }), { status: 402 });
  await assert.rejects(chat({ provider: "zen", key: "k" }, [], { fetchImpl: bad }), /402.*Insufficient funds/);
  await assert.rejects(chat({ provider: "zen", key: "" }, [], { fetchImpl: ok }), /No API key/);
});

test("normalizeAnalysis clamps, filters and learns categories", () => {
  const r = normalizeAnalysis({
    blabla_score: 140, verdict: "meh", pareto: ["a", "", "b"],
    highlights: [{ quote: "A shocking thing happened here", category: "sensationalism", why: "drama" },
      { quote: "short", category: "clickbait" }, { quote: "Sponsored content about vitamins", category: "native_ad", why: "ad" }],
    new_categories: [{ id: "Native Ad", name: "Native ad", desc: "ads as articles" }, { id: "clickbait", name: "dup" }],
  }, EMPTY_MEMORY);
  assert.equal(r.score, 100);
  assert.deepEqual(r.pareto, ["a", "b"]);
  assert.equal(r.highlights.length, 2);
  assert.equal(r.highlights[1].category, "native_ad"); // new category proposed in the same answer
  assert.deepEqual(r.newCategories.map((c) => c.id), ["native_ad"]);
  const r2 = normalizeAnalysis({ highlights: [{ quote: "Sponsored content about vitamins", category: "unknown_thing" }] }, EMPTY_MEMORY);
  assert.equal(r2.highlights[0].category, "filler"); // unknown category, not proposed → filler
  assert.equal(r2.score, null);
  const merged = mergeCategories(EMPTY_MEMORY, r.newCategories);
  assert.equal(merged.categories.length, EMPTY_MEMORY.categories.length + 1);
  assert.ok(merged.categories.at(-1).color);
});

test("memory: feedback, relearn threshold, rules", () => {
  let m = { ...EMPTY_MEMORY };
  for (let i = 0; i < 4; i++) m = addFeedback(m, { vote: 1, title: "t" + i });
  assert.equal(needsRelearn(m), false);
  m = addFeedback(m, { vote: -1, note: "too generous" });
  assert.equal(needsRelearn(m), true);
  m = applyRules(m, { rules: ["Be strict with press releases", ""] });
  assert.deepEqual(m.rules, ["Be strict with press releases"]);
  assert.equal(needsRelearn(m), false);
  assert.throws(() => applyRules(m, {}));
});

test("prompt carries rules, feedback and truncated page", () => {
  const m = addFeedback({ ...EMPTY_MEMORY, rules: ["Hates listicles"] }, { title: "X", vote: -1, note: "fluff" });
  const [sys, user] = buildMessages({ title: "T", url: "https://a", text: "z".repeat(50000) }, m);
  assert.equal(sys.role, "system");
  assert.match(user.content, /Hates listicles/);
  assert.match(user.content, /fluff/);
  assert.ok(user.content.length < 20000);
});

test("buildMessages adds news rules from the news ranker only when present", () => {
  const page = { title: "t", url: "https://x", text: "y".repeat(200) };
  const without = buildMessages(page, EMPTY_MEMORY)[1].content;
  assert.ok(!without.includes("news ranker"));
  const withNews = buildMessages(page, { ...EMPTY_MEMORY, newsRules: ["skips celebrity gossip"] })[1].content;
  assert.ok(withNews.includes("news ranker") && withNews.includes("skips celebrity gossip"));
});

test("sanitizeMemory keeps the known shape and rejects junk", async () => {
  const { sanitizeMemory } = await import("../extension/lib/analysis.js");
  assert.throws(() => sanitizeMemory({ rules: "x" }), /not a bbla memory file/);
  const m = sanitizeMemory({ rules: ["a", 5, "  "], feedback: "nope", learnedAt: "x", evil: 1,
    categories: [{ id: "c", name: "C", color: "red;x", desc: 3 }, null, { name: "no id" }] });
  assert.deepEqual(m.rules, ["a"]);
  assert.deepEqual(m.feedback, []);
  assert.equal(m.learnedAt, 0);
  assert.equal(m.evil, undefined);
  assert.equal(m.categories.length, 1);
  assert.match(m.categories[0].color, /^#[0-9a-f]{6}$/i);
  assert.ok(sanitizeMemory({ rules: [], categories: [] }).categories.length > 5, "falls back to seed categories");
});
