"""Preference rules shared between the page meter (extension) and the news ranker (news/).

Each side distils its own 👍/👎 feedback into short rules; the other side reads them as extra
context, so teaching one teaches both. Stored in ~/.config/bbla/shared-rules.json
(override with BBLA_SHARED_RULES): {"page": [...], "news": [...], "updated": {"page": ts, ...}}.
"""

import json
import os
import tempfile
import time
from pathlib import Path

SOURCES = ("page", "news")


def path() -> Path:
    return Path(os.environ.get("BBLA_SHARED_RULES") or Path.home() / ".config" / "bbla" / "shared-rules.json")


def read() -> dict:
    try:
        data = json.loads(path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    out = {s: [str(r)[:200] for r in data.get(s) or [] if str(r).strip()][:20] for s in SOURCES}
    out["updated"] = data.get("updated") if isinstance(data.get("updated"), dict) else {}
    return out


def write(source: str, rules: list) -> dict:
    if source not in SOURCES:
        raise ValueError(f"source must be one of {SOURCES}")
    if not isinstance(rules, list):
        raise ValueError("rules must be a list")
    data = read()
    data[source] = [str(r).strip()[:200] for r in rules if str(r).strip()][:20]
    data["updated"][source] = int(time.time())
    p = path()
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=p.parent, suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, p)
    return data
