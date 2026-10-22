"""Ad-element judgments for the bbla page meter, via TypeSafe's Jev.

Same shape as news/scoring.py: many small typed judgments with probabilities,
composed in code. The extension collects *candidate* ad nodes (heuristic CSS
selectors + promo-text sniffing, see extension/lib/ads.js and the
``collectAdCandidates`` function in extension/lib/page.js), POSTs them to the
bridge ``/ads/score``, and hides the ones Jev confirms.

Two noul questions per candidate, asked in parallel in one request:

  is_ad     probability the node is an ad / sponsored slot / promo / popup /
            monetization widget rather than the page's main content
  disrupts  probability it actively disrupts reading (overlay, sticky cover,
            autoplay video, big in-content promo block)

The hide decision is computed here in code (``should_hide``), so the threshold
can change without re-scoring. Obvious matches (selector ids like ``#ads``)
are hidden by the extension without calling Jev at all — Jev is for the
ambiguous cases, where calibrated probabilities beat regexes.
"""

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

JEV_API = "https://api.typesafe.ai/v1/systemone"
JEV_MODEL = os.environ.get("BBLA_ADS_JEV_MODEL", "jev-1.13.0")  # same pin as news/
MAX_CANDIDATES = 20
HIDE_AT = 0.55          # is_ad >= this → hide
HIDE_AT_DISRUPT = 0.35  # is_ad >= this + disrupts >= DISRUPT_AT → hide
DISRUPT_AT = 0.60


def normalize_thresholds(t) -> dict:
    """Clamp extension-provided thresholds (never trust the client blindly)."""
    def num(v, d):
        try:
            return float(v)
        except (TypeError, ValueError):
            return d

    def clamp(n, lo, hi):
        return max(lo, min(hi, n))

    t = t if isinstance(t, dict) else {}
    return {
        "hideAt": clamp(num(t.get("hideAt"), HIDE_AT), 0, 1),
        "hideAtDisrupt": clamp(num(t.get("hideAtDisrupt"), HIDE_AT_DISRUPT), 0, 1),
        "disruptAt": clamp(num(t.get("disruptAt"), DISRUPT_AT), 0, 1),
    }


class AdsError(Exception):
    """A failure that can be shown to the user as-is."""


def typesafe_key(request_key: str = "") -> str:
    """Same lookup order as news/: per-request key (from the extension options),
    env, bbla key, usefulnews key, mercado key."""
    if isinstance(request_key, str) and request_key.strip():
        return request_key.strip()
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if key:
        return key
    home = Path.home()
    paths = [home / ".config" / "bbla" / "typesafe.key",
             home / ".config" / "usefulnews" / "typesafe.key",
             home / ".config" / "mercado" / "typesafe.key"]
    env_dir = os.environ.get("BBLA_CONFIG_DIR", "").strip()  # tests / custom setups
    if env_dir:
        paths.insert(0, Path(env_dir) / "typesafe.key")
    for path in paths:
        try:
            key = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if key:
            return key
    return ""


def jev_questions() -> dict:
    return {
        "is_ad": {
            "type": "noul",
            "instructions": "Is `element` an advertisement, sponsored slot, promo banner, "
                            "newsletter signup popup, cookie-wall upsell, or other monetization "
                            "widget — rather than the page's main content the reader came for?",
        },
        "disrupts": {
            "type": "noul",
            "instructions": "Does `element` disrupt reading: overlay or modal dialog, sticky "
                            "header/footer covering content, autoplay video, or a large "
                            "in-content promo block breaking the article flow?",
        },
    }


def element_state(candidate: dict) -> dict:
    return {
        "tag": str(candidate.get("tag", ""))[:20],
        "id_class": str(candidate.get("id_class", ""))[:200],
        "size": str(candidate.get("size", ""))[:40],
        "text": str(candidate.get("text", ""))[:300],
        "html_hint": str(candidate.get("html_hint", ""))[:300],
    }


def should_hide(is_ad: float, disrupts: float, thresholds=None) -> bool:
    """Hide decision in code — thresholds change without re-scoring."""
    t = normalize_thresholds(thresholds)
    return is_ad >= t["hideAt"] or (is_ad >= t["hideAtDisrupt"] and disrupts >= t["disruptAt"])


class AdsScorer:
    name = "jev-ads"

    def __init__(self, key: str, model: str = JEV_MODEL):
        if not key:
            raise AdsError("no TypeSafe key — set TYPESAFE_API_KEY or save one in settings")
        self.key = key
        self.model = model
        self.tokens = 0

    def _post(self, body: dict) -> dict:
        req = urllib.request.Request(JEV_API, json.dumps(body).encode(), {
            "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=45) as resp:
                    return json.load(resp)
            except urllib.error.HTTPError as exc:
                if exc.code in (429, 500, 502, 503, 504) and attempt < 2:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise AdsError(f"TypeSafe HTTP {exc.code}: {exc.read().decode()[:200]}") from None
            except (urllib.error.URLError, TimeoutError) as exc:
                if attempt < 2:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise AdsError(f"TypeSafe unreachable: {exc}") from None
        raise AdsError("TypeSafe: retries exhausted")

    def score_one(self, candidate: dict, page: dict, rules: list, thresholds=None) -> dict:
        state = {
            "element": element_state(candidate),
            "page": {"host": str(page.get("host", ""))[:80],
                     "title": str(page.get("title", ""))[:120]},
            "reader": {"learned_preferences": rules or []},
        }
        data = self._post({"model": self.model, "state": state, "questions": jev_questions()})
        self.tokens += (data.get("usage") or {}).get("input_tokens", 0)
        ans = data["answers"]
        is_ad = round(float(ans["is_ad"]["noul"]), 3)
        disrupts = round(float(ans["disrupts"]["noul"]), 3)
        return {"id": candidate.get("id"), "is_ad": is_ad, "disrupts": disrupts,
                "hide": should_hide(is_ad, disrupts, thresholds)}

    def score(self, candidates: list, page: dict, rules: list, workers: int = 6, thresholds=None) -> dict:
        """{candidate_id: judgment} — capped, failures reported in "_errors"."""
        from concurrent.futures import ThreadPoolExecutor
        cands = (candidates or [])[:MAX_CANDIDATES]
        out, errors = {}, []

        def run(c):
            try:
                return c.get("id"), self.score_one(c, page or {}, rules or [], thresholds)
            except (AdsError, KeyError, TypeError, ValueError) as exc:
                errors.append(f"{str(c.get('id'))}: {exc}")
                return c.get("id"), None

        with ThreadPoolExecutor(max_workers=workers) as pool:
            for cid, dims in pool.map(run, cands):
                if dims:
                    out[cid] = dims
        if errors:
            out["_errors"] = errors
        return out
