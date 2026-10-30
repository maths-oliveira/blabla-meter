"""Preference rules shared between the page meter (extension) and the news ranker (news/).

Each side distils its own 👍/👎 feedback into short rules; the other side reads them as extra
context, so teaching one teaches both. Stored in ~/.config/bbla/shared-rules.json
(override with BBLA_SHARED_RULES): {"page": [...], "news": [...], "updated": {"page": ts, ...}}.
"""

import contextlib
import json
import os
import tempfile
import time
from pathlib import Path

try:
    import fcntl
except ImportError:   # Windows: no cross-process lock, last writer wins
    fcntl = None

SOURCES = ("page", "news")


def path() -> Path:
    return Path(os.environ.get("BBLA_SHARED_RULES") or Path.home() / ".config" / "bbla" / "shared-rules.json")


def _rules(value) -> list:
    # Only a list of rules counts; a bare string would otherwise be split into letters.
    if not isinstance(value, list):
        return []
    return [str(r).strip()[:200] for r in value if str(r).strip()][:20]


@contextlib.contextmanager
def _locked():
    """Serialise read-modify-write between the bridge and the news app (both write this file)."""
    p = path()
    p.parent.mkdir(parents=True, exist_ok=True)
    if fcntl is None:
        yield
        return
    with open(p.with_name(p.name + ".lock"), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def read() -> dict:
    try:
        data = json.loads(path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    out = {s: _rules(data.get(s)) for s in SOURCES}
    out["updated"] = data.get("updated") if isinstance(data.get("updated"), dict) else {}
    return out


def write(source: str, rules: list) -> dict:
    if source not in SOURCES:
        raise ValueError(f"source must be one of {SOURCES}")
    if not isinstance(rules, list):
        raise ValueError("rules must be a list")
    with _locked():
        data = read()
        data[source] = _rules(rules)
        data["updated"][source] = int(time.time())
        p = path()
        fd, tmp = tempfile.mkstemp(dir=p.parent, suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, p)
    return data
