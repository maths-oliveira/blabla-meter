#!/usr/bin/env python3
"""Local bridge: an OpenAI-style /v1/chat/completions endpoint on 127.0.0.1 that answers with the
provider configured in ``ai.py`` — by default the installed ``opencode`` CLI and its free models,
which OpenCode only allows from inside OpenCode (so the extension can't call them directly).

  python3 bridge.py [--port 8804]

Only browser extensions (chrome-extension:// origins) and local tools may call it.

Also serves the time-usage report (usage/, ex ~/src/cchrome):
  GET  /usage                 the dashboard page (usage/dashboard.html)
  GET  /usage/site?url=…      time on that site + its category/usefulness (usage/site_stats.py)
  POST /usage/rebuild         re-run usage/build_report.py (desktop history; phone uses saved snapshots)

and the preference rules shared with the news ranker (news/, ex ~/src/usefulnews), see shared_rules.py:
  GET  /memory/rules          {"page": [...], "news": [...], "updated": {...}}
  POST /memory/rules          {"source": "page"|"news", "rules": [...]}
"""

import argparse
import json
import os
import pathlib
import ipaddress
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from ai import AI, AIError, _write_private

DEFAULT_PORT = 8804
ai = AI("bbla")
try:
    import ads as ads_scorer  # noqa: E402  (Jev ad judgments for the page meter)
except ImportError:  # pragma: no cover
    ads_scorer = None
try:
    import pages as page_scorer  # noqa: E402  (instant Jev page score for the side panel)
except ImportError:  # pragma: no cover
    page_scorer = None
USAGE = pathlib.Path(__file__).resolve().parent.parent / "usage"
sys.path.insert(0, str(USAGE))
import site_stats  # noqa: E402
sys.path.insert(0, str(USAGE.parent))
import shared_rules  # noqa: E402


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


def allowed(origin: str) -> bool:
    # no Origin = curl/local script; extensions send chrome-extension://<id>; web pages are refused
    return not origin or origin.startswith(("chrome-extension://", "moz-extension://"))


def to_prompt(messages: list) -> tuple:
    system = "\n\n".join(str(m.get("content", "")) for m in messages if m.get("role") == "system")
    rest = [m for m in messages if m.get("role") != "system"]
    if len(rest) == 1:
        return str(rest[0].get("content", "")), system
    convo = "\n\n".join(f"{m.get('role', 'user').upper()}: {m.get('content', '')}" for m in rest)
    return convo, system


class Handler(BaseHTTPRequestHandler):
    server_version = "bbla-bridge/1.0"

    def _send(self, code: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(code)
        origin = self.headers.get("Origin", "")
        if origin and allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Typesafe-Key")
            self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _bad_host(self) -> bool:
        if local_host(self.headers.get("Host", "")):
            return False
        self._send(403, {"error": {"message": "host not allowed"}})
        return True

    def do_OPTIONS(self):
        if self._bad_host():
            return None
        if not allowed(self.headers.get("Origin", "")):
            return self._send(403, {"error": {"message": "origin not allowed"}})
        self._send(204, {})

    def do_GET(self):
        if self._bad_host():
            return None
        path, _, query = self.path.partition("?")
        if path.rstrip("/") == "/usage":
            # a normal page view (no Origin header): only this machine can reach 127.0.0.1
            try:
                html = (USAGE / "dashboard.html").read_bytes()
            except FileNotFoundError:
                html = b"<p>Report not built yet: POST /usage/rebuild or run usage/build_report.py</p>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            return self.wfile.write(html)
        if path == "/memory/rules":
            if not allowed(self.headers.get("Origin", "")):
                return self._send(403, {"error": {"message": "origin not allowed"}})
            return self._send(200, shared_rules.read())
        if path == "/usage/site":
            if not allowed(self.headers.get("Origin", "")):
                return self._send(403, {"error": {"message": "origin not allowed"}})
            from urllib.parse import parse_qs
            url = (parse_qs(query).get("url") or [""])[0]
            return self._send(200, site_stats.stats_for_url(url))
        if self.path.rstrip("/") in ("", "/health"):
            cfg = ai.load_config()
            return self._send(200, {"ok": True, "provider": cfg["provider"], "model": cfg["model"]})
        if path == "/ads/status":
            if not allowed(self.headers.get("Origin", "")):
                return self._send(403, {"error": {"message": "origin not allowed"}})
            header_key = (self.headers.get("X-Typesafe-Key") or "").strip()
            key = header_key or (ads_scorer.typesafe_key() if ads_scorer else "")
            return self._send(200, {"ok": True, "jev_available": bool(key),
                                    "model": ads_scorer.JEV_MODEL if ads_scorer else None})
        self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if self._bad_host():
            return None
        if not allowed(self.headers.get("Origin", "")):
            return self._send(403, {"error": {"message": "origin not allowed"}})
        if self.path.rstrip("/") == "/memory/rules":
            try:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(min(length, 200_000)) or b"{}")
                return self._send(200, shared_rules.write(str(body.get("source", "")), body.get("rules")))
            except (ValueError, AttributeError) as exc:
                return self._send(400, {"error": {"message": str(exc)}})
        if self.path.rstrip("/") == "/usage/rebuild":
            try:
                out = subprocess.run([sys.executable, str(USAGE / "build_report.py")], cwd=USAGE,
                                     capture_output=True, text=True, timeout=600)
            except subprocess.TimeoutExpired:
                return self._send(504, {"ok": False, "error": "build_report.py took over 10 min"})
            ok = out.returncode == 0
            return self._send(200 if ok else 500, {"ok": ok, "output": (out.stdout + out.stderr)[-2000:]})
        if self.path.rstrip("/") not in ("/v1/chat/completions", "/chat/completions"):
            if self.path.rstrip("/") == "/ads/score":
                try:
                    length = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(min(length, 500_000)) or b"{}")
                except (ValueError, AttributeError):
                    return self._send(400, {"error": {"message": "bad request"}})
                if ads_scorer is None:
                    return self._send(500, {"error": {"message": "ads scorer not installed"}})
                request_key = (self.headers.get("X-Typesafe-Key") or "").strip() or str(body.get("typesafeKey") or "")
                model = str(body.get("model") or "").strip()[:60] or ads_scorer.JEV_MODEL
                thresholds = ads_scorer.normalize_thresholds(body.get("thresholds"))
                try:
                    scorer = ads_scorer.AdsScorer(ads_scorer.typesafe_key(request_key), model)
                except ads_scorer.AdsError as exc:
                    return self._send(402, {"error": {"message": str(exc)}})
                try:
                    decisions = scorer.score(body.get("candidates") or [],
                                             body.get("page") or {}, body.get("rules") or [],
                                             thresholds=thresholds)
                except ads_scorer.AdsError as exc:
                    return self._send(502, {"error": {"message": str(exc)}})
                return self._send(200, {"ok": True, "model": scorer.model, "decisions": decisions,
                                        "thresholds": thresholds})
            if self.path.rstrip("/") == "/page/score":
                # Instant Jev page score (one typed-judgment call, no generative AI).
                # Key lookup mirrors /ads/score: per-request key, then file/env.
                try:
                    length = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(min(length, 500_000)) or b"{}")
                except (ValueError, AttributeError):
                    return self._send(400, {"error": {"message": "bad request"}})
                if page_scorer is None:
                    return self._send(500, {"error": {"message": "page scorer not installed"}})
                request_key = (self.headers.get("X-Typesafe-Key") or "").strip() or str(body.get("typesafeKey") or "")
                key = request_key or (ads_scorer.typesafe_key() if ads_scorer else "")
                if not key:
                    return self._send(402, {"error": {"message": "no TypeSafe key — set TYPESAFE_API_KEY or save one in settings"}})
                model = str(body.get("model") or "").strip()[:60] or page_scorer.PAGE_JEV_MODEL
                try:
                    scorer = page_scorer.PageScorer(key, model)
                    result = scorer.score_page(body.get("page") or {}, body.get("rules") or [])
                    blocks = scorer.score_blocks(body.get("blocks") or [], body.get("rules") or [])
                except page_scorer.PageError as exc:
                    return self._send(502, {"error": {"message": str(exc)}})
                return self._send(200, {"ok": True, "model": model,
                                        "dims": result["dims"], "usefulness": result["usefulness"],
                                        "blocks": blocks})
            if self.path.rstrip("/") == "/ads/key":
                # Persist the extension-configured TypeSafe key (same pattern as news/ settings).
                try:
                    length = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(min(length, 10_000)) or b"{}")
                except (ValueError, AttributeError):
                    return self._send(400, {"error": {"message": "bad request"}})
                key = str(body.get("key") or "").strip()
                if not key or len(key) > 500:
                    return self._send(400, {"error": {"message": "missing or invalid key"}})
                _write_private(ai.config_dir / "typesafe.key", key)
                return self._send(200, {"ok": True})
            return self._send(404, {"error": {"message": "not found"}})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(min(length, 2_000_000)) or b"{}")
            prompt, system = to_prompt(body.get("messages") or [])
        except (ValueError, AttributeError):
            return self._send(400, {"error": {"message": "bad request"}})
        cfg = ai.load_config()
        if body.get("model"):
            cfg["model"] = str(body["model"])
        try:
            text = ai.ask(prompt, system, cfg)
        except AIError as exc:
            return self._send(502, {"error": {"message": str(exc)}})
        self._send(200, {"object": "chat.completion", "model": cfg["model"],
                         "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                                      "finish_reason": "stop"}]})

    def log_message(self, fmt, *args):
        if os.environ.get("BBLA_BRIDGE_LOG"):
            super().log_message(fmt, *args)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("BBLA_BRIDGE_PORT", DEFAULT_PORT)))
    args = ap.parse_args()
    cfg = ai.load_config()
    print(f"bbla bridge on http://127.0.0.1:{args.port}  (provider {cfg['provider']}, model {cfg['model']})")
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
