"""Time spent on one site, from the usage report (dashboard.html), for the bbla side panel.

The report embeds its data as ``const D=<json>;`` (build_report.py). This module reads it back,
maps a URL to the report's item key with the same ``site_key`` the collectors use, and resolves
the category and usefulness score the same way the dashboard does (categories.json: per-device
item override → regex rules → "Other"; score override → category score → 55).
"""

import datetime
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent
DASHBOARD = ROOT / "dashboard.html"
sys.path.insert(0, str(ROOT / "collect"))
from desktop import TZ, site_key  # noqa: E402

SOURCES = ["desktop", "phone-apps", "phone-web"]
_cache = {"mtime": None, "data": None}


def load():
    """Report data, re-read only when dashboard.html changes. None if the report was never built."""
    try:
        mtime = DASHBOARD.stat().st_mtime
    except FileNotFoundError:
        return None
    if _cache["mtime"] != mtime:
        html = DASHBOARD.read_text(encoding="utf-8")
        m = re.search(r"const D=(\{.*?\});\n", html, re.S)
        _cache["data"] = json.loads(m.group(1).replace("<\\/", "</")) if m else None
        _cache["mtime"] = mtime
    return _cache["data"]


def category(cfg, key, dev):
    cat = (cfg["items"].get(dev) or {}).get(key) or (cfg["items"].get("all") or {}).get(key)
    if not cat:
        for r in cfg["rules"]:
            if (not r.get("device") or r["device"] == dev) and re.search(r["match"], key, re.I):
                cat = r["cat"]
                break
    cat = cat or "Other"
    meta = next((c for c in cfg["categories"] if c["name"] == cat), {"score": 55})
    override = (cfg["scores"].get(dev) or {}).get(cat)
    score = float(override) if override not in (None, "") else meta.get("score", 55)
    return cat, score


def stats_for_url(url, until=None):
    """Seconds on the site: on the report's last day, in its last 7 days, and in the whole window.

    Counted back from the report's last day (``until``), not from today: the report is rebuilt by
    hand, so "today" would read as zero between rebuilds."""
    data = load()
    if data is None:
        return {"ok": False, "error": "usage report not built yet: run usage/build_report.py"}
    key, _ = site_key(url)
    if not key:
        return {"ok": False, "error": "not a website"}
    cfg = data["config"]
    cat, score = category(cfg, key, "desktop")
    idx = next((i for i, it in enumerate(data["items"]) if it["k"] == key), None)
    days = [datetime.date.fromisoformat(d) for d in data["days"]]
    until = until or days[-1]
    week_from = until - datetime.timedelta(days=6)
    out = {"ok": True, "key": key, "category": cat, "score": score, "generated": data["generated"],
           "until": until.isoformat(), "since": days[0].isoformat(), "last_day": 0, "week": 0, "total": 0,
           "visits": 0, "by_device": {"desktop": 0, "phone": 0}, "rank_week": None}
    if idx is None:
        return out
    week_by_item = {}
    for src, item, day, _hour, secs, visits, _est in data["rows"]:
        d = days[day]
        if week_from <= d <= until:
            week_by_item[item] = week_by_item.get(item, 0) + secs
        if item != idx:
            continue
        out["total"] += secs
        out["visits"] += visits
        out["by_device"]["phone" if SOURCES[src].startswith("phone") else "desktop"] += secs
        if d == until:
            out["last_day"] += secs
        if week_from <= d <= until:
            out["week"] += secs
    if idx in week_by_item:
        ranked = sorted(week_by_item, key=week_by_item.get, reverse=True)
        out["rank_week"] = ranked.index(idx) + 1
    return out
