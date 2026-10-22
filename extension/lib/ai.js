// AI providers for the extension. Pure functions + fetch, so node tests can import this file.

/* `api: "anthropic"` speaks the Messages API; everything else is OpenAI-style
   chat/completions. `body(model)` adds provider-specific request fields
   (token limit name, reasoning effort); temperature is sent only where
   `temperature` is true, since reasoning models and Anthropic reject it. */
export const PROVIDERS = {
  zen: { label: "OpenCode Zen (API key)", url: "https://opencode.ai/zen/v1/chat/completions", model: "deepseek-v4.1-flash", needsKey: true, temperature: true },
  go: { label: "OpenCode Go (subscription key)", url: "https://opencode.ai/zen/go/v1/chat/completions", model: "glm-5.3-flash", needsKey: true, temperature: true },
  openrouter: { label: "OpenRouter", url: "https://openrouter.ai/api/v1/chat/completions", model: "openrouter/free", needsKey: true, temperature: true },
  anthropic: { label: "Anthropic (Claude)", url: "https://api.anthropic.com/v1/messages", model: "claude-opus-5-5", needsKey: true, api: "anthropic" },
  openai: { label: "OpenAI", url: "https://api.openai.com/v1/chat/completions", model: "gpt-5.4-mini", needsKey: true,
    body: () => ({ max_completion_tokens: 16000 }) },
  gemini: { label: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-flash-latest", needsKey: true,
    body: () => ({ max_tokens: 8000, reasoning_effort: "low" }) },
  groq: { label: "Groq", url: "https://api.groq.com/openai/v1/chat/completions", model: "openai/gpt-oss-120b", needsKey: true, temperature: true,
    body: (model) => ({ max_tokens: 8000, ...(/gpt-oss/.test(model) ? { reasoning_effort: "low" } : {}) }) },
  mistral: { label: "Mistral", url: "https://api.mistral.ai/v1/chat/completions", model: "mistral-small-latest", needsKey: true, temperature: true },
  deepseek: { label: "DeepSeek", url: "https://api.deepseek.com/chat/completions", model: "deepseek-chat", needsKey: true, temperature: true },
  ollama: { label: "Ollama (local models)", url: "http://127.0.0.1:11434/v1/chat/completions", model: "", needsKey: false, needsModel: true, temperature: true },
  bridge: { label: "Local bridge (installed opencode, free models)", url: "http://127.0.0.1:8804/v1/chat/completions", model: "", needsKey: false, temperature: true },
  custom: { label: "Custom OpenAI-compatible endpoint", url: "", model: "", needsKey: false, temperature: true },
};

export const DEFAULT_SETTINGS = { provider: "zen", model: "", key: "", keys: {}, baseUrl: "", bridgeUrl: "http://127.0.0.1:8804", adsEnabled: false, enabled: true,
  typesafeKey: "", jevModel: "jev-1.13.0",
  adsThresholds: { hideAt: 0.55, hideAtDisrupt: 0.35, disruptAt: 0.6 },
  customBlocks: {}, scoreSelectors: {} };

export const ANTHROPIC_VERSION = "2026-10-21";

/** API key for the selected provider. Keys are stored per provider so switching
    providers never sends one vendor's key to another; the single legacy `key`
    (pre-0.9.1) counts as the current provider's until per-provider keys exist. */
export function keyFor(settings) {
  const keys = settings.keys && typeof settings.keys === "object" ? settings.keys : {};
  if (Object.keys(keys).length) return String(keys[settings.provider] || "").trim();
  return String(settings.key || "").trim();
}

export function endpointFor(settings) {
  const p = PROVIDERS[settings.provider] || PROVIDERS.zen;
  if (settings.provider === "bridge") return (settings.bridgeUrl || "http://127.0.0.1:8804").replace(/\/+$/, "") + "/v1/chat/completions";
  if (settings.provider === "custom") {
    const base = (settings.baseUrl || "").replace(/\/+$/, "");
    return base.endsWith("/chat/completions") ? base : base + "/chat/completions";
  }
  return p.url;
}

/** First JSON object in a model reply (tolerates ``` fences and chatter). */
export function extractJson(text) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("the AI did not return JSON");
  return JSON.parse(t.slice(start, end + 1));
}

/** Request headers + body for one call (exported for tests). */
export function buildRequest(settings, messages) {
  const p = PROVIDERS[settings.provider] || PROVIDERS.zen;
  const key = keyFor(settings);
  const model = settings.model || p.model;
  const headers = { "Content-Type": "application/json" };
  if (p.api === "anthropic") {
    // Raw fetch (no build step → no SDK). The browser-access header is required
    // because extension requests carry a chrome-extension:// Origin.
    headers["x-api-key"] = key;
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    headers["anthropic-dangerous-direct-browser-access"] = "true";
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const rest = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
    return { headers, body: { model, max_tokens: 16000, ...(system ? { system } : {}), messages: rest } };
  }
  if (key) headers.Authorization = `Bearer ${key}`;
  if (settings.provider === "go") headers["x-opencode-session"] = "bbla-" + Math.random().toString(36).slice(2, 12);
  const body = { model, messages, ...(p.body ? p.body(model) : { max_tokens: 3000 }) };
  if (p.temperature) body.temperature = 0.2;
  return { headers, body };
}

/** Text of a provider reply, whichever API shape it uses. */
export function replyText(settings, data) {
  const p = PROVIDERS[settings.provider] || PROVIDERS.zen;
  if (p.api === "anthropic") {
    if (data?.stop_reason === "refusal") throw new Error(`${p.label} declined to analyze this page.`);
    const text = (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    if (!text) throw new Error("Unexpected answer from the AI provider.");
    return text;
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content) {
    if (data?.choices?.[0]?.finish_reason === "length") throw new Error(`${p.label} ran out of tokens before answering — try a non-reasoning model.`);
    throw new Error("Unexpected answer from the AI provider.");
  }
  return content;
}

export async function chat(settings, messages, { fetchImpl = fetch, timeoutMs = 120000 } = {}) {
  const p = PROVIDERS[settings.provider] || PROVIDERS.zen;
  const url = endpointFor(settings);
  if (!url || !/^https?:\/\//.test(url)) throw new Error("Set the endpoint URL in the bbla options.");
  if (p.needsKey && !keyFor(settings)) throw new Error(`No API key for ${p.label}. Open the bbla options.`);
  if (p.needsModel && !settings.model) throw new Error(`Set a model for ${p.label} in the bbla options.`);
  const { headers, body } = buildRequest(settings, messages);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "The AI took too long to answer." : `Cannot reach ${p.label}: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* handled below */ }
  if (!res.ok) {
    const err = Array.isArray(data) ? data[0]?.error : data?.error; // Gemini wraps errors in an array
    const msg = err?.message || data?.message || (typeof data?.detail === "string" && data.detail) || raw.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(`${p.label} refused (${res.status}): ${msg}`);
  }
  return replyText(settings, data);
}
