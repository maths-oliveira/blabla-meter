"""Instant page scores for the bbla side panel, via TypeSafe's Jev.

The panel shows this within seconds of opening: one Jev call judges the page
on the same dimensions as the news ranker (same keys and weights as
news/scoring.py — keep in sync), and the 0-100 score is computed here in code.
The slow generative pass (verdict prose, pareto summary, verbatim highlights)
stays behind the panel's "AI summary" button, so the reader decides when to
wait for it.
"""

import json
import os
import time
import urllib.error
import urllib.request

PAGE_JEV_MODEL = os.environ.get("BBLA_PAGE_JEV_MODEL", "jev-1.13.0")
EXCERPT_CHARS = 2000

# Same weights as news/scoring.py DEFAULT_WEIGHTS (duplicated: this module stays
# dependency-free, like bridge/ads.py).
WEIGHTS = {
    "actionable": 0.35, "relevance": 0.30, "impact": 0.20, "depth": 0.15,
    "clickbait": 0.35, "sensational": 0.30, "tragedy": 0.50, "speculation": 0.30, "gossip": 0.45,
}

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


class PageError(Exception):
    """A failure that can be shown to the user as-is."""


MAX_BLOCKS = 8


def page_questions() -> dict:
    q = {
        "actionable": {
            "type": "score",
            "instructions": "Could the reader in `reader` actually DO something useful because of `page`: use a "
                            "tool, attend something, change a purchase or decision, avoid a concrete risk, meet a deadline?",
            "criteria": [
                "Nothing to do: the reader can only watch or feel something about it",
                "Weak or indirect: at most a vague, general takeaway",
                "Some concrete action is possible for people like the reader",
                "Clear, timely action the reader can take soon (use, attend, apply, buy, avoid, decide)",
            ],
        },
        "relevance": {
            "type": "score",
            "instructions": "How well does `page` match the interests, location, work and learned preferences of `reader`? "
                            "Topics listed under `reader.avoid` count as not relevant.",
            "criteria": [
                "Unrelated to the reader, or something the reader asked to avoid",
                "Loosely related",
                "Clearly related to one of the reader's interests, work or region",
                "Squarely about the reader's main interests, work or own city",
            ],
        },
        "impact": {
            "type": "score",
            "instructions": "How much could the situation in `page` affect the life, money, work, health or safety of `reader`, "
                            "directly or indirectly (not how big the topic is for the world)?",
            "criteria": [
                "No realistic effect on the reader",
                "Small or remote effect",
                "Noticeable effect on the reader's life, money or work",
                "Large, direct effect on the reader",
            ],
        },
        "depth": {
            "type": "score",
            "instructions": "Judging from the title and excerpt of `page`, what is the quality of the information?",
            "criteria": [
                "Propaganda, rumor or one-sided outrage with no critical thinking",
                "Shallow: a headline-level fact or opinion with no context",
                "Informative: clear facts with useful context",
                "Critical, well-argued analysis: experts, evidence, several views, open to debate",
            ],
        },
        "clickbait": {"type": "noul", "instructions": "Is the title of `page` clickbait: withholding the key fact, teasing, exaggerating or baiting curiosity to get a click?"},
        "sensational": {"type": "noul", "instructions": "Is `page` sensationalist: dramatic, alarmist or outrage-driven framing beyond what the facts justify?"},
        "tragedy": {"type": "noul", "instructions": "Is `page` mainly a tragedy, death, crime or disaster story consumed as entertainment, with nothing the reader can do or learn from it?"},
        "speculation": {"type": "noul", "instructions": "Is `page` mainly speculation or prediction about something that will soon happen and resolve anyway, or claims with no evidence?"},
        "gossip": {"type": "noul", "instructions": "Is `page` gossip about the private life, feuds or statements of celebrities or politicians?"},
        "topic": {"type": "choice", "instructions": "What is `page` mainly about?", "criteria": TOPICS},
    }
    return q


def page_state(page: dict) -> dict:
    text = str((page or {}).get("text", ""))
    return {
        "title": str((page or {}).get("title", ""))[:200],
        "excerpt": text[:EXCERPT_CHARS],
        "source": str((page or {}).get("host", ""))[:80],
    }


def usefulness(dims: dict) -> dict:
    """0-100 usefulness + parts (same formula as news/scoring.py)."""
    scores = dims.get("scores", {})
    flags = dims.get("flags", {})
    positive = sum(WEIGHTS[k] for k in ("actionable", "relevance", "impact", "depth")) or 1.0
    base = 100.0 * sum(WEIGHTS[k] * float(scores.get(k, 0)) for k in ("actionable", "relevance", "impact", "depth")) / positive
    penalty = 1.0
    for k in ("clickbait", "sensational", "tragedy", "speculation", "gossip"):
        penalty *= 1.0 - min(1.0, WEIGHTS[k]) * float(flags.get(k, 0))
    value = max(0.0, min(100.0, base * penalty))
    return {"value": round(value), "base": round(base), "penalty": round(penalty, 2)}


class PageScorer:
    name = "jev-page"

    def __init__(self, key: str, model: str = PAGE_JEV_MODEL):
        if not key:
            raise PageError("no TypeSafe key — set TYPESAFE_API_KEY or save one in settings")
        self.key = key
        self.model = model
        self.tokens = 0

    def _post(self, body: dict) -> dict:
        req = urllib.request.Request("https://api.typesafe.ai/v1/systemone",
                                     json.dumps(body).encode(),
                                     {"Authorization": f"Bearer {self.key}",
                                      "Content-Type": "application/json"})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=45) as resp:
                    return json.load(resp)
            except urllib.error.HTTPError as exc:
                if exc.code in (429, 500, 502, 503, 504) and attempt < 2:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise PageError(f"TypeSafe HTTP {exc.code}: {exc.read().decode()[:200]}") from None
            except (urllib.error.URLError, TimeoutError) as exc:
                if attempt < 2:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise PageError(f"TypeSafe unreachable: {exc}") from None
        raise PageError("TypeSafe: retries exhausted")

    def score_page(self, page: dict, rules: list) -> dict:
        state = {
            "reader": {"learned_preferences": rules or []},
            "page": page_state(page),
        }
        data = self._post({"model": self.model, "state": state, "questions": page_questions()})
        self.tokens += (data.get("usage") or {}).get("input_tokens", 0)
        ans = data["answers"]
        dims = {
            "scores": {k: round(float(ans[k]["score"]) / 3, 3)
                       for k in ("actionable", "relevance", "impact", "depth")},
            "flags": {k: round(float(ans[k]["noul"]), 3)
                      for k in ("clickbait", "sensational", "tragedy", "speculation", "gossip")},
            "topic": ans["topic"]["choice"],
            "confidence": round(min(ans[k]["confidence"]
                                    for k in ("actionable", "relevance", "impact", "depth", "topic")), 2),
        }
        return {"dims": dims, "usefulness": usefulness(dims)}

    def score_blocks(self, blocks: list, rules: list, workers: int = 6) -> dict:
        """{block_id: {dims, usefulness}} — one Jev call per block, in parallel
        (same pattern as AdsScorer.score). Failures are skipped silently; the
        panel simply shows no badge for those blocks."""
        from concurrent.futures import ThreadPoolExecutor
        valid = [b for b in (blocks or []) if isinstance(b, dict)
                 and str(b.get("excerpt", ""))][:MAX_BLOCKS]
        out = {}

        def run(b):
            try:
                page = {"title": str(b.get("heading", ""))[:80],
                        "text": str(b.get("excerpt", "")),
                        "host": ""}
                return str(b.get("id", "")), self.score_page(page, rules)
            except (PageError, KeyError, TypeError, ValueError):
                return str(b.get("id", "")), None

        with ThreadPoolExecutor(max_workers=workers) as pool:
            for bid, res in pool.map(run, valid):
                if res:
                    out[bid] = res
        return out
