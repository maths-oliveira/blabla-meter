#!/usr/bin/env python3
"""usefulnews: a news aggregator that ranks articles by how useful they are to *you*.

Run: python3 app.py [--port 8805]  →  http://127.0.0.1:8805
"""

import argparse
import ipaddress
import os
import sys
import threading
import time
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import shared_rules  # noqa: E402  (rules shared with the bbla page meter)
import feeds as feedlib
import scoring
from ai import AI, AIError
from store import Store, profile_hash

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
DEFAULT_PORT = 8805  # 8801 was the standalone usefulnews; it is now part of bbla

app = Flask(__name__, static_folder=None)
ai = AI("usefulnews")
store = Store(Path(os.environ.get("USEFULNEWS_DATA_DIR") or ROOT / "data"))

DEFAULT_SETTINGS = {
    "profile": {"location": "", "work": "", "interests": "", "avoid": ""},
    "feeds": feedlib.DEFAULT_FEEDS,
    "local_feed": True,
    "scorer": "jev",
    "weights": scoring.DEFAULT_WEIGHTS,
    "days": 3,
}
LEARN_EVERY = 5  # re-distill the preference rules after this many new feedback items

job = {"running": False, "stage": "", "done": 0, "total": 0, "errors": [], "finished": 0}
job_lock = threading.Lock()
learn_lock = threading.Lock()


def settings() -> dict:
    s = {**DEFAULT_SETTINGS, **store.read_json("settings.json", {})}
    s["profile"] = {**DEFAULT_SETTINGS["profile"], **(s.get("profile") or {})}
    s["weights"] = {**scoring.DEFAULT_WEIGHTS, **(s.get("weights") or {})}
    return s


def memory() -> dict:
    mem = {"rules": [], "topic_bias": {}, "source_bias": {}, "feedback_at_learn": 0,
           **store.read_json("memory.json", {})}
    mem["page_rules"] = shared_rules.read()["page"]  # learned from page feedback in the extension
    return mem


def save_memory(mem: dict) -> None:
    """page_rules is read live from the shared file, never stored in news memory."""
    store.write_json("memory.json", {k: v for k, v in mem.items() if k != "page_rules"})


def active_feeds(s: dict) -> list:
    out = list(s["feeds"])
    if s.get("local_feed") and s["profile"].get("location"):
        out.append(feedlib.local_feed(s["profile"]["location"]))
    return out


def make_scorer(name: str):
    if name == "jev":
        return scoring.JevScorer(scoring.typesafe_key(ai.config_dir))
    return scoring.LLMScorer(ai)


# ------------------------------------------------------------------ background refresh

def _set_job(**kw):
    with job_lock:
        job.update(kw)


def refresh(rescore_all: bool = False) -> None:
    s = settings()
    mem = memory()
    try:
        _set_job(stage="fetching feeds", done=0, total=0, errors=[])
        articles, errors = feedlib.fetch_all(active_feeds(s))
        store.add_articles(articles)
        recent = store.recent(s["days"])
        phash = profile_hash(s["profile"], mem)
        have = store.judgments(s["scorer"], [a["id"] for a in recent])
        todo = [a for a in recent if rescore_all or a["id"] not in have or have[a["id"]]["profile_hash"] != phash]
        _set_job(stage=f"scoring with {s['scorer']}", total=len(todo), errors=errors)
        scorer = make_scorer(s["scorer"])
        step = 24 if s["scorer"] == "jev" else 8
        for i in range(0, len(todo), step):
            chunk = todo[i:i + step]
            results = scorer.score(chunk, s["profile"], mem)
            errors.extend(results.get("_errors", []))
            store.save_judgments(s["scorer"], phash, results)
            _set_job(done=min(len(todo), i + step), errors=errors[-20:])
        _set_job(stage="done")
    except AIError as exc:
        _set_job(stage="error", errors=[str(exc)])
    except Exception as exc:  # keep the server alive; show the failure on the page
        _set_job(stage="error", errors=[f"{type(exc).__name__}: {exc}"])
    finally:
        _set_job(running=False, finished=int(time.time()))


def relearn() -> dict:
    """Recompute biases (cheap, always) and, when there are notes/votes, the rules (AI call)."""
    with learn_lock:
        fb = store.feedback()
        mem = memory()
        mem.update(scoring.learn_biases(fb))
        if fb:
            try:
                mem["rules"] = scoring.distill_rules(ai, fb, mem.get("rules") or [])
                mem["feedback_at_learn"] = len(fb)
                mem["learned_at"] = int(time.time())
                mem.pop("learn_error", None)
                shared_rules.write("news", mem["rules"])
            except AIError as exc:
                mem["learn_error"] = str(exc)
        save_memory(mem)
        return mem


# ------------------------------------------------------------------ routes

def local_host(host_header: str) -> bool:
    """DNS-rebinding guard: a rebound page reaches us under its own domain name,
    so only IP literals and localhost are accepted in the Host header."""
    host = (host_header or "").strip().lower()
    host = host[1:host.find("]")] if host.startswith("[") else host.rsplit(":", 1)[0]
    if host == "localhost":
        return True
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


@app.before_request
def _same_origin_posts():
    if not local_host(request.host):
        return jsonify({"error": "host not allowed"}), 403
    if request.method == "POST":
        origin = request.headers.get("Origin")
        if origin and origin.rstrip("/") != request.host_url.rstrip("/"):
            return jsonify({"error": "origin not allowed"}), 403
    return None


@app.route("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.route("/<path:name>")
def static_file(name):
    return send_from_directory(WEB, name)


@app.route("/api/state")
def state():
    s = settings()
    key = scoring.typesafe_key(ai.config_dir)
    return jsonify({"settings": s, "memory": memory(), "topics": scoring.TOPICS,
                    "typesafe_key": bool(key), "ai": ai.public_config(), "job": dict(job)})


@app.route("/api/settings", methods=["POST"])
def save_settings():
    data = request.get_json(silent=True) or {}
    s = settings()
    if isinstance(data.get("profile"), dict):
        s["profile"] = {k: str(data["profile"].get(k, s["profile"][k]) or "")[:600] for k in DEFAULT_SETTINGS["profile"]}
    if isinstance(data.get("feeds"), list):
        s["feeds"] = [{"name": str(f.get("name") or f.get("url"))[:60], "url": str(f["url"]).strip()}
                      for f in data["feeds"] if isinstance(f, dict) and str(f.get("url", "")).startswith("http")]
    if "local_feed" in data:
        s["local_feed"] = bool(data["local_feed"])
    if data.get("scorer") in ("jev", "llm"):
        s["scorer"] = data["scorer"]
    if isinstance(data.get("weights"), dict):
        for k, v in data["weights"].items():
            if k in scoring.DEFAULT_WEIGHTS:
                try:
                    s["weights"][k] = max(0.0, min(1.0, float(v)))
                except (TypeError, ValueError):
                    pass
    if "days" in data:
        s["days"] = max(1, min(14, int(data.get("days") or 3)))
    store.write_json("settings.json", s)
    key = str(data.get("typesafe_key") or "").strip()
    if key:
        from ai import _write_private
        _write_private(ai.config_dir / "typesafe.key", key)
    return state()


@app.route("/api/ai/config", methods=["POST"])
def ai_config():
    try:
        return jsonify(ai.save_config(request.get_json(silent=True) or {}))
    except AIError as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/refresh", methods=["POST"])
def start_refresh():
    rescore = bool((request.get_json(silent=True) or {}).get("rescore"))
    with job_lock:
        if job["running"]:
            return jsonify({"job": dict(job)}), 409
        job["running"] = True
    threading.Thread(target=refresh, args=(rescore,), daemon=True).start()
    return jsonify({"job": dict(job)})


@app.route("/api/job")
def job_status():
    return jsonify(dict(job))


@app.route("/api/news")
def news():
    s = settings()
    mem = memory()
    recent = store.recent(s["days"])
    judged = store.judgments(s["scorer"], [a["id"] for a in recent])
    fb = {f["article_id"]: f for f in store.feedback()}
    phash = profile_hash(s["profile"], mem)
    out = []
    for a in recent:
        j = judged.get(a["id"])
        if not j:
            continue
        u = scoring.usefulness(j["dims"], s["weights"], mem, a["source"])
        f = fb.get(a["id"])
        out.append({**a, "dims": j["dims"], "useful": u, "stale": j["profile_hash"] != phash,
                    "feedback": {k: f[k] for k in ("vote", "user_score", "note")} if f else None})
    out.sort(key=lambda x: (-x["useful"]["value"], -x["published"]))
    return jsonify({"articles": out, "unscored": len(recent) - len(out), "scorer": s["scorer"]})


@app.route("/api/feedback", methods=["POST"])
def feedback():
    data = request.get_json(silent=True) or {}
    aid = str(data.get("id") or "")
    if not store.article(aid):
        return jsonify({"error": "unknown article"}), 404
    if data.get("clear"):
        store.delete_feedback(aid)
    else:
        vote = data.get("vote") if data.get("vote") in (1, -1) else 0
        try:
            user_score = None if data.get("user_score") in (None, "") else max(0, min(100, int(data["user_score"])))
        except (TypeError, ValueError):
            return jsonify({"error": "score must be 0-100"}), 400
        s = settings()
        judged = store.judgments(s["scorer"], [aid]).get(aid)
        model_score = scoring.usefulness(judged["dims"], s["weights"], memory())["value"] if judged else None
        topic = judged["dims"].get("topic", "") if judged else ""
        store.save_feedback(aid, vote, user_score, str(data.get("note") or "")[:1000], model_score, topic)
    fb = store.feedback()
    mem = memory()
    mem.update(scoring.learn_biases(fb))
    save_memory(mem)
    if len(fb) - int(mem.get("feedback_at_learn") or 0) >= LEARN_EVERY and not learn_lock.locked():
        threading.Thread(target=relearn, daemon=True).start()
    return jsonify({"ok": True, "memory": memory()})


@app.route("/api/learn", methods=["POST"])
def learn_now():
    return jsonify({"memory": relearn()})


@app.route("/api/memory", methods=["POST"])
def edit_memory():
    rules = (request.get_json(silent=True) or {}).get("rules")
    if not isinstance(rules, list):
        return jsonify({"error": "rules must be a list"}), 400
    mem = memory()
    mem["rules"] = [str(r).strip()[:200] for r in rules if str(r).strip()][:20]
    save_memory(mem)
    return jsonify({"memory": mem})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("USEFULNEWS_PORT", DEFAULT_PORT)))
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    print(f"usefulnews on http://{args.host}:{args.port}")
    app.run(host=args.host, port=args.port, threaded=True)


if __name__ == "__main__":
    main()
