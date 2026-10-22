import { test } from "node:test";
import assert from "node:assert/strict";
import { ANTHROPIC_VERSION, PROVIDERS, buildRequest, chat, endpointFor, keyFor } from "../extension/lib/ai.js";

const msgs = [{ role: "system", content: "sys" }, { role: "user", content: "page" }];
const reply = (data, status = 200) => async () => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });

test("keyFor uses per-provider keys and never leaks one vendor's key to another", () => {
  assert.equal(keyFor({ provider: "zen", key: "legacy" }), "legacy");
  assert.equal(keyFor({ provider: "zen", key: "legacy", keys: {} }), "legacy");
  assert.equal(keyFor({ provider: "openai", key: "legacy", keys: { zen: "z" } }), "");
  assert.equal(keyFor({ provider: "zen", keys: { zen: " z ", openai: "o" } }), "z");
});

test("every hosted provider has an https endpoint and a default model", () => {
  for (const [id, p] of Object.entries(PROVIDERS)) {
    if (id === "custom" || id === "bridge" || id === "ollama") continue;
    assert.match(endpointFor({ provider: id }), /^https:\/\//, id);
    assert.ok(p.model, id);
  }
});

test("anthropic request: system split out, version + browser headers, no temperature", () => {
  const { headers, body } = buildRequest({ provider: "anthropic", keys: { anthropic: "sk" } }, msgs);
  assert.equal(headers["x-api-key"], "sk");
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers["anthropic-version"], ANTHROPIC_VERSION);
  assert.equal(headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(body.system, "sys");
  assert.deepEqual(body.messages, [{ role: "user", content: "page" }]);
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.temperature, undefined);
  assert.ok(body.max_tokens >= 4000);
});

test("openai uses max_completion_tokens and no temperature; others keep max_tokens", () => {
  const o = buildRequest({ provider: "openai", keys: { openai: "k" } }, msgs).body;
  assert.equal(o.temperature, undefined);
  assert.ok(o.max_completion_tokens);
  assert.equal(o.max_tokens, undefined);
  const z = buildRequest({ provider: "zen", key: "k" }, msgs).body;
  assert.equal(z.temperature, 0.2);
  assert.equal(z.max_tokens, 3000);
  const g = buildRequest({ provider: "groq", keys: { groq: "k" }, model: "qwen/qwen3-32b" }, msgs).body;
  assert.equal(g.reasoning_effort, undefined);
});

test("chat parses anthropic replies and surfaces refusals", async () => {
  const s = { provider: "anthropic", keys: { anthropic: "sk" } };
  const ok = reply({ content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"a":1}' }], stop_reason: "end_turn" });
  assert.equal(await chat(s, msgs, { fetchImpl: ok }), '{"a":1}');
  await assert.rejects(chat(s, msgs, { fetchImpl: reply({ content: [], stop_reason: "refusal" }) }), /declined/);
  await assert.rejects(chat(s, msgs, { fetchImpl: reply({ error: { message: "invalid x-api-key" } }, 401) }), /401.*invalid x-api-key/);
});

test("chat needs a model for ollama and reads Gemini's array errors", async () => {
  await assert.rejects(chat({ provider: "ollama" }, msgs, { fetchImpl: reply({}) }), /Set a model/);
  const bad = reply([{ error: { message: "API key not valid" } }], 400);
  await assert.rejects(chat({ provider: "gemini", keys: { gemini: "k" } }, msgs, { fetchImpl: bad }), /400.*API key not valid/);
});
