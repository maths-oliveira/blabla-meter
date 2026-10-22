"""Usefulness judgments for news articles.

Each article gets the same set of *dimensions* from either scorer:

  scores (0..1)  actionable, relevance, impact, depth
  flags  (0..1)  clickbait, sensational, tragedy, speculation, gossip   (probability it applies)
  topic          one of TOPICS

``JevScorer`` asks TypeSafe's Jev (typed judgments + probabilities, one request per article, all
questions in parallel). ``LLMScorer`` asks a generative model through ``ai.py`` (batched JSON).
The final 0-100 usefulness is computed here in code from those raw judgments, the weights and
what the memory learned from feedback — changing weights never needs re-scoring.
"""

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

from ai import AI, AIError

TYPESAFE_API = "https://api.typesafe.ai/v1/systemone"
JEV_MODEL = os.environ.get("USEFULNEWS_JEV_MODEL", "jev-1.13.0")  # pinned: weights tuned on it

TOPICS = {
    "tech_tool": "A new technology, tool, app or feature people can actually use",
    "local_event": "An event, course, workshop, fair or service in a specific city or neighborhood",
    "local_news": "Regional news about a specific city/state: traffic, works, public services, weather alerts",
    "personal_finance": "Prices, taxes, benefits, interest rates, deadlines that affect a person's money",
    "economy_analysis": "Analysis or discussion of economic or market trends",
    "politics": "Politicians, parties, elections, government disputes",
    "crime": "Murders, robberies, police cases, trials of crimes",
    "disaster_accident": "Accidents, disasters, fires, crashes, deaths",
    "war_conflict": "Wars, armed conflicts, terrorism, geopolitics",
    "celebrity_entertainment": "Celebrities, TV, reality shows, gossip, entertainment industry",
    "sports": "Sports results, transfers, athletes",
    "science_health": "Science findings, medicine, health guidance",
    "business": "Companies, deals, product launches seen from the business side",
    "other": "None of the above",
}

SCORES = {
    "actionable": {
        "instructions": "Could the reader in `reader` actually DO something useful because of `article`: use a "
                        "tool, attend something, change a purchase or decision, avoid a concrete risk, meet a deadline?",
        "criteria": [
            "Nothing to do: the reader can only watch or feel something about it",
            "Weak or indirect: at most a vague, general takeaway",
            "Some concrete action is possible for people like the reader",
            "Clear, timely action the reader can take soon (use, attend, apply, buy, avoid, decide)",
        ],
    },
    "relevance": {
        "instructions": "How well does `article` match the interests, location, work and learned preferences of `reader`? "
                        "Topics listed under `reader.avoid` count as not relevant.",
        "criteria": [
            "Unrelated to the reader, or something the reader asked to avoid",
            "Loosely related",
            "Clearly related to one of the reader's interests, work or region",
            "Squarely about the reader's main interests, work or own city",
        ],
    },
    "impact": {
        "instructions": "How much could the situation in `article` affect the life, money, work, health or safety of `reader`, "
                        "directly or indirectly (not how big the news is for the world)?",
        "criteria": [
            "No realistic effect on the reader",
            "Small or remote effect",
            "Noticeable effect on the reader's life, money or work",
            "Large, direct effect on the reader",
        ],
    },
    "depth": {
        "instructions": "Judging from the title and summary of `article`, what is the quality of the information?",
        "criteria": [
            "Propaganda, rumor or one-sided outrage with no critical thinking",
            "Shallow: a headline-level fact or opinion with no context",
            "Informative: clear facts with useful context",
            "Critical, well-argued analysis: experts, evidence, several views, open to debate",
        ],
    },
}

FLAGS = {
    "clickbait": ("Is the title of `article` clickbait: withholding the key fact, teasing, exaggerating or baiting curiosity "
                  "to get a click?"),
    "sensational": "Is `article` sensationalist: dramatic, alarmist or outrage-driven framing beyond what the facts justify?",
    "tragedy": ("Is `article` mainly a tragedy, death, crime or disaster story consumed as entertainment, with nothing the "
                "reader can do or learn from it?"),
    "speculation": ("Is `article` mainly speculation or prediction about something that will soon happen and resolve anyway "
                    "(poll horse-race, 'what could happen next week', rumors)?"),
    "gossip": "Is `article` gossip about the private life, feuds or statements of celebrities or politicians?",
}

DEFAULT_WEIGHTS = {
    "actionable": 0.35, "relevance": 0.30, "impact": 0.20, "depth": 0.15,
    # a flag with probability p multiplies the score by (1 - weight * p)
    "clickbait": 0.35, "sensational": 0.30, "tragedy": 0.50, "speculation": 0.30, "gossip": 0.45,
}


# ------------------------------------------------------------------ composite

def usefulness(dims: dict, weights: dict = None, memory: dict = None, source: str = "") -> dict:
    """0-100 usefulness + the parts that produced it (shown in the UI)."""
    w = {**DEFAULT_WEIGHTS, **(weights or {})}
    positive = sum(w[k] for k in SCORES) or 1.0
    base = 100.0 * sum(w[k] * float(dims["scores"].get(k, 0)) for k in SCORES) / positive
    penalty = 1.0
    for k in FLAGS:
        penalty *= 1.0 - min(1.0, w[k]) * float(dims["flags"].get(k, 0))
    memory = memory or {}
    topic_adj = float((memory.get("topic_bias") or {}).get(dims.get("topic", "other"), 0))
    source_adj = float((memory.get("source_bias") or {}).get(source, 0))
    value = max(0.0, min(100.0, base * penalty + topic_adj + source_adj))
    return {"value": round(value), "base": round(base), "penalty": round(penalty, 2),
            "topic_adj": round(topic_adj, 1), "source_adj": round(source_adj, 1)}


# ------------------------------------------------------------------ Jev

def typesafe_key(config_dir: Path) -> str:
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if key:
        return key
    # own key first; the mercado app's key (same user, same machine) as a fallback
    for path in (config_dir / "typesafe.key", Path.home() / ".config" / "mercado" / "typesafe.key"):
        try:
            key = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if key:
            return key
    return ""


def jev_questions() -> dict:
    q = {k: {"type": "score", **v} for k, v in SCORES.items()}
    for k, text in FLAGS.items():
        q[k] = {"type": "noul", "instructions": text}
    q["topic"] = {"type": "choice", "instructions": "What is `article` mainly about?", "criteria": TOPICS}
    return q


def reader_state(profile: dict, memory: dict) -> dict:
    reader = {k: v for k, v in {
        "location": profile.get("location", ""),
        "work": profile.get("work", ""),
        "interests": profile.get("interests", ""),
        "avoid": profile.get("avoid", ""),
        "learned_preferences": memory.get("rules") or [],
        "learned_from_web_pages": memory.get("page_rules") or [],
    }.items() if v}
    return reader


def article_state(article: dict) -> dict:
    return {"title": article["title"], "summary": article.get("summary", "")[:600],
            "source": article.get("source", "")}


class JevScorer:
    name = "jev"

    def __init__(self, key: str, model: str = JEV_MODEL):
        if not key:
            raise AIError("no TypeSafe key — set TYPESAFE_API_KEY or save one in settings")
        self.key = key
        self.model = model
        self.tokens = 0

    def _post(self, body: dict) -> dict:
        req = urllib.request.Request(TYPESAFE_API, json.dumps(body).encode(), {
            "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    return json.load(resp)
            except urllib.error.HTTPError as exc:
                if exc.code in (429, 500, 502, 503, 504) and attempt < 3:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise AIError(f"TypeSafe HTTP {exc.code}: {exc.read().decode()[:200]}") from None
            except (urllib.error.URLError, TimeoutError) as exc:
                if attempt < 3:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise AIError(f"TypeSafe unreachable: {exc}") from None
        raise AIError("TypeSafe: retries exhausted")

    def score_one(self, article: dict, profile: dict, memory: dict) -> dict:
        state = {"reader": reader_state(profile, memory), "article": article_state(article)}
        data = self._post({"model": self.model, "state": state, "questions": jev_questions()})
        self.tokens += (data.get("usage") or {}).get("input_tokens", 0)
        ans = data["answers"]
        scores = {}
        for k, spec in SCORES.items():
            top = len(spec["criteria"]) - 1
            scores[k] = round(float(ans[k]["score"]) / top, 3)
        return {
            "scores": scores,
            "flags": {k: round(float(ans[k]["noul"]), 3) for k in FLAGS},
            "topic": ans["topic"]["choice"],
            "confidence": round(min(ans[k]["confidence"] for k in (*SCORES, "topic")), 2),
        }

    def score(self, articles: list, profile: dict, memory: dict, workers: int = 8) -> dict:
        """{article_id: dims} — failures are skipped (reported in "_errors")."""
        from concurrent.futures import ThreadPoolExecutor
        out, errors = {}, []

        def run(a):
            try:
                return a["id"], self.score_one(a, profile, memory)
            except (AIError, KeyError, TypeError, ValueError) as exc:
                errors.append(f"{a['title'][:60]}: {exc}")
                return a["id"], None

        with ThreadPoolExecutor(max_workers=workers) as pool:
            for aid, dims in pool.map(run, articles):
                if dims:
                    out[aid] = dims
        if errors:
            out["_errors"] = errors
        return out


# ------------------------------------------------------------------ generative LLM (OpenCode etc.)

LLM_SYSTEM = "You rate news usefulness for one reader. Answer ONLY with JSON, no prose."


def llm_prompt(batch: list, profile: dict, memory: dict) -> str:
    dims = {k: {"question": v["instructions"], "levels (0..%d)" % (len(v["criteria"]) - 1): v["criteria"]}
            for k, v in SCORES.items()}
    items = [{"id": a["id"], **article_state(a)} for a in batch]
    return (
        "Reader: " + json.dumps(reader_state(profile, memory), ensure_ascii=False) + "\n\n"
        "For each article give:\n"
        "- levels for these dimensions (integer level index):\n" + json.dumps(dims, ensure_ascii=False) + "\n"
        "- probabilities 0..1 that each flag applies: " + json.dumps(FLAGS, ensure_ascii=False) + "\n"
        "- topic, one of: " + ", ".join(TOPICS) + "\n\n"
        "Articles:\n" + json.dumps(items, ensure_ascii=False) + "\n\n"
        'Return {"results": [{"id": "...", "actionable": 0, "relevance": 0, "impact": 0, "depth": 0, '
        '"clickbait": 0.0, "sensational": 0.0, "tragedy": 0.0, "speculation": 0.0, "gossip": 0.0, '
        '"topic": "other"}]} with one entry per article id.'
    )


def _clip(value, hi: float) -> float:
    try:
        return max(0.0, min(hi, float(value)))
    except (TypeError, ValueError):
        return 0.0


class LLMScorer:
    name = "llm"

    def __init__(self, ai: AI, batch_size: int = 8):
        self.ai = ai
        self.batch_size = batch_size

    def score(self, articles: list, profile: dict, memory: dict, workers: int = 3) -> dict:
        from concurrent.futures import ThreadPoolExecutor
        batches = [articles[i:i + self.batch_size] for i in range(0, len(articles), self.batch_size)]
        out, errors = {}, []

        def run(batch):
            try:
                data = self.ai.ask_json(llm_prompt(batch, profile, memory), LLM_SYSTEM)
            except AIError as exc:
                errors.append(str(exc))
                return {}
            rows = data.get("results") if isinstance(data, dict) else data
            ids = {a["id"] for a in batch}
            got = {}
            for r in rows or []:
                if not isinstance(r, dict) or r.get("id") not in ids:
                    continue
                got[r["id"]] = {
                    "scores": {k: round(_clip(r.get(k), len(v["criteria"]) - 1) / (len(v["criteria"]) - 1), 3)
                               for k, v in SCORES.items()},
                    "flags": {k: round(_clip(r.get(k), 1.0), 3) for k in FLAGS},
                    "topic": r.get("topic") if r.get("topic") in TOPICS else "other",
                    "confidence": None,
                }
            return got

        with ThreadPoolExecutor(max_workers=workers) as pool:
            for got in pool.map(run, batches):
                out.update(got)
        if errors:
            out["_errors"] = errors
        return out


# ------------------------------------------------------------------ learning from feedback

def learn_biases(feedback: list) -> dict:
    """Per-topic and per-source score adjustments from thumbs (±15 / ±8 at most).

    ``feedback``: [{"vote": 1|-1|0, "topic": str, "source": str, "user_score": int|None, "model_score": int|None}]
    A manual score counts as a vote in its direction relative to what the model gave.
    """
    def signal(f):
        if f.get("user_score") is not None and f.get("model_score") is not None:
            diff = (f["user_score"] - f["model_score"]) / 50.0
            return max(-1.0, min(1.0, diff))
        return float(f.get("vote") or 0)

    def bias(key, cap):
        acc = {}
        for f in feedback:
            k = f.get(key)
            if not k:
                continue
            s, n = acc.get(k, (0.0, 0))
            acc[k] = (s + signal(f), n + 1)
        # shrink towards 0 with few votes
        return {k: round(cap * s / (n + 3), 1) for k, (s, n) in acc.items() if s}

    return {"topic_bias": bias("topic", 15.0), "source_bias": bias("source", 8.0)}


def distill_rules(ai: AI, feedback: list, current_rules: list) -> list:
    """Turn the user's votes and notes into a short list of reading preferences (memory)."""
    examples = [{"title": f["title"], "vote": {1: "useful", -1: "useless"}.get(f.get("vote"), ""),
                 "my_score": f.get("user_score"), "note": f.get("note", "")} for f in feedback[-60:]]
    prompt = (
        "Here is feedback a reader gave on news articles (vote, their own 0-100 score, and notes):\n"
        + json.dumps(examples, ensure_ascii=False) + "\n\nCurrent learned preferences:\n"
        + json.dumps(current_rules, ensure_ascii=False) + "\n\n"
        "Write the updated list of at most 12 short, concrete preference rules about what this reader "
        "finds useful or useless in news (e.g. 'Values free local cooking workshops', 'Does not care about "
        "national election polls'). Keep rules that still hold, merge duplicates, drop contradicted ones. "
        'Return {"rules": ["..."]}.'
    )
    data = ai.ask_json(prompt, "You maintain a reader's news preference memory. Answer only with JSON.")
    rules = data.get("rules") if isinstance(data, dict) else None
    if not isinstance(rules, list):
        raise AIError("the AI did not return a rules list")
    return [str(r).strip()[:200] for r in rules if str(r).strip()][:12]
