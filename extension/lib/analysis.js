// Prompt building, answer normalization and memory (learning) — pure, testable in node.

export const SEED_CATEGORIES = [
  { id: "sensationalism", name: "Sensationalism", desc: "Dramatic, alarmist or exaggerated framing beyond what the facts justify", color: "#f59e0b" },
  { id: "clickbait", name: "Clickbait", desc: "Teasing or withholding the point to keep you reading/clicking", color: "#fb923c" },
  { id: "tragedy", name: "Tragedy / death as entertainment", desc: "Deaths, crimes, accidents, disasters told for emotion with nothing to act on", color: "#ef4444" },
  { id: "celebrity", name: "Celebrity gossip", desc: "Private lives, feuds and looks of famous people", color: "#ec4899" },
  { id: "political_gossip", name: "Political gossip", desc: "Who-said-what, feuds and horse-race talk about politicians with no policy substance", color: "#a855f7" },
  { id: "hate_bait", name: "Hate / outrage bait", desc: "Content built to make you angry at a group or person", color: "#dc2626" },
  { id: "speculation", name: "Empty speculation", desc: "Guessing about what will happen soon anyway, or claims with no evidence", color: "#8b5cf6" },
  { id: "filler", name: "Filler / fluff", desc: "Padding, repetition, SEO text, long intros that say nothing", color: "#94a3b8" },
  { id: "promo", name: "Ad / promo", desc: "Selling something disguised as information", color: "#14b8a6" },
  { id: "not_actionable", name: "Not actionable for me", desc: "Information the reader can do nothing with and that won't change a decision", color: "#64748b" },
];

export const EMPTY_MEMORY = { rules: [], categories: SEED_CATEGORIES, feedback: [], learnedAt: 0 };
export const MAX_PAGE_CHARS = 14000;

export function buildMessages(page, memory) {
  const cats = memory.categories.map((c) => ({ id: c.id, name: c.name, meaning: c.desc }));
  const examples = memory.feedback.slice(-12).map((f) => ({
    page: f.title?.slice(0, 80), model_score: f.modelScore, my_score: f.userScore ?? undefined,
    verdict: f.vote === 1 ? "good analysis" : f.vote === -1 ? "bad analysis" : undefined,
    note: f.note || undefined, highlight: f.highlight || undefined,
  }));
  const system = "You help one reader avoid wasting attention. You answer ONLY with one JSON object, no markdown.";
  const user = `Reader preferences learned from feedback: ${JSON.stringify(memory.rules)}
${memory.newsRules?.length ? `What this reader finds useful or useless in news (learned in the news ranker): ${JSON.stringify(memory.newsRules)}\n` : ""}Recent feedback from the reader (learn from it): ${JSON.stringify(examples)}

Bullshit categories (use these ids; you may propose a NEW category only if a passage clearly fits none):
${JSON.stringify(cats)}

Page: ${JSON.stringify({ title: page.title, url: page.url })}
Text:
"""
${page.text.slice(0, MAX_PAGE_CHARS)}
"""

Return:
{
  "blabla_score": 0-100,  // how much of this page is ACTUALLY USEFUL to the reader: 100 = dense, actionable, reliable; 0 = pure noise
  "verdict": "one short sentence: is it worth reading?",
  "pareto": ["the 20% of the content that carries 80% of the value, as 3-7 short bullets; say so if nothing is useful"],
  "highlights": [{"quote": "EXACT sentence or phrase copied verbatim from the text (max ~200 chars)", "category": "category id", "why": "short reason"}],
  "new_categories": [{"id": "snake_case", "name": "Short name", "desc": "what it means"}]
}
Mark at most 15 highlights, only real offenders. Write in the language of the page.`;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const str = (v, n) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const slug = (s) => str(s, 40).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

export function normalizeAnalysis(data, memory) {
  if (!data || typeof data !== "object") throw new Error("The AI answer was not an object.");
  const known = new Set(memory.categories.map((c) => c.id));
  const newCats = [];
  for (const c of Array.isArray(data.new_categories) ? data.new_categories : []) {
    const id = slug(c?.id || c?.name);
    if (id && !known.has(id) && str(c?.name, 40)) {
      known.add(id);
      newCats.push({ id, name: str(c.name, 40), desc: str(c.desc, 160), learned: true });
    }
  }
  const highlights = (Array.isArray(data.highlights) ? data.highlights : [])
    .map((h) => ({ quote: str(h?.quote, 300), category: known.has(h?.category) ? h.category : "filler", why: str(h?.why, 200) }))
    .filter((h) => h.quote.length >= 8)
    .slice(0, 20);
  const score = Number(data.blabla_score);
  return {
    score: Number.isFinite(score) ? Math.round(clamp(score, 0, 100)) : null,
    verdict: str(data.verdict, 240),
    pareto: (Array.isArray(data.pareto) ? data.pareto : []).map((p) => str(p, 400)).filter(Boolean).slice(0, 8),
    highlights,
    newCategories: newCats,
  };
}

const PALETTE = ["#0ea5e9", "#84cc16", "#eab308", "#f97316", "#d946ef", "#06b6d4", "#22c55e"];

/** Adds AI-proposed categories to memory (the "document where we learn new categories"). */
/** Imported memory files are untrusted: keep the known shape, drop the rest, cap sizes. */
export function sanitizeMemory(data) {
  if (!data || !Array.isArray(data.categories) || !Array.isArray(data.rules)) throw new Error("not a bbla memory file");
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
  const categories = data.categories.filter((c) => c && typeof c === "object" && str(c.id, 60) && str(c.name, 80))
    .slice(0, 40).map((c) => ({ id: str(c.id, 60), name: str(c.name, 80), desc: str(c.desc, 400),
      color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : PALETTE[0], ...(c.learned ? { learned: true } : {}) }));
  return {
    rules: data.rules.map((r) => str(r, 300).trim()).filter(Boolean).slice(0, 20),
    categories: categories.length ? categories : SEED_CATEGORIES,
    feedback: (Array.isArray(data.feedback) ? data.feedback : []).filter((f) => f && typeof f === "object").slice(-200),
    learnedAt: Number.isFinite(data.learnedAt) ? data.learnedAt : 0,
  };
}

export function mergeCategories(memory, newCats) {
  if (!newCats.length) return memory;
  const cats = [...memory.categories];
  for (const c of newCats) {
    if (!cats.some((x) => x.id === c.id)) cats.push({ ...c, color: PALETTE[cats.length % PALETTE.length], addedAt: Date.now() });
  }
  return { ...memory, categories: cats };
}

export function addFeedback(memory, entry) {
  const fb = [...memory.feedback, { ...entry, at: Date.now() }].slice(-200);
  return { ...memory, feedback: fb };
}

export function needsRelearn(memory, every = 5) {
  const since = memory.feedback.filter((f) => f.at > (memory.learnedAt || 0)).length;
  return since >= every;
}

export function relearnMessages(memory) {
  const items = memory.feedback.slice(-60).map((f) => ({
    page: f.title?.slice(0, 100), url_host: f.host, model_score: f.modelScore, my_score: f.userScore ?? undefined,
    vote: f.vote || undefined, note: f.note || undefined,
    highlight: f.highlight ? `${f.highlight.verdict} highlight [${f.highlight.category}]: ${f.highlight.quote.slice(0, 120)}` : undefined,
  }));
  return [
    { role: "system", content: "You maintain a reader's preference memory. Answer ONLY with JSON." },
    { role: "user", content: `Feedback the reader gave on page analyses (scores, votes, notes, highlight corrections):
${JSON.stringify(items)}

Current rules: ${JSON.stringify(memory.rules)}

Write the updated list of at most 12 short, concrete rules about what this reader considers useful vs blabla,
how strict the score should be, and which highlight categories they disagree with. Keep rules that still hold,
merge duplicates, drop contradicted ones. Return {"rules": ["..."]}.` },
  ];
}

export function applyRules(memory, data) {
  const rules = Array.isArray(data?.rules) ? data.rules.map((r) => str(r, 200)).filter(Boolean).slice(0, 12) : null;
  if (!rules) throw new Error("The AI did not return rules.");
  return { ...memory, rules, learnedAt: Date.now() };
}
