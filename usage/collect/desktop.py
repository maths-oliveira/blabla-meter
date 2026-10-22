"""Desktop Brave history -> visit records.

Reads every Brave profile DB (old Brave + Brave Origin) plus the archived brave_history.db,
drops exact duplicates (same url + microsecond timestamp = imported copy).
Duration = Chromium visit_duration capped at 10 min (background tabs inflate it otherwise).
"""
import pathlib, shutil, sqlite3, tempfile, datetime
from urllib.parse import urlsplit, parse_qs
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Sao_Paulo")
CAP_S = 600
ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCES = [
    ROOT / "brave_history.db",
    pathlib.Path.home() / ".config/BraveSoftware/Brave-Browser/Default/History",
    pathlib.Path.home() / ".config/BraveSoftware/Brave-Origin/Default/History",
]


def chrome_ts(us):
    return datetime.datetime.fromtimestamp(us / 1e6 - 11644473600, TZ)


def site_key(url):
    """Normalized item key; big mixed-use domains are split by path type."""
    if url.startswith("file:"):
        return "local files", None
    try:
        p = urlsplit(url)
    except ValueError:
        return None, None
    if p.scheme not in ("http", "https"):
        return None, None
    host = (p.hostname or "").lower()
    if p.port:
        host = f"{host}:{p.port}"
    for pre in ("www.", "m.", "mobile."):
        if host.startswith(pre):
            host = host[len(pre):]
    path, q = p.path, parse_qs(p.query)
    if host == "youtube.com":
        sub = ("Shorts" if path.startswith("/shorts") else "Watch" if path.startswith("/watch")
               else "Search" if path.startswith("/results") else "Home" if path in ("", "/")
               else "Channel" if path.startswith(("/@", "/channel", "/c/")) else "Other")
        term = q.get("search_query", [None])[0] if sub == "Search" else None
        return f"youtube.com › {sub}", term
    if host == "google.com":
        if path.startswith("/maps"):
            return "google.com › Maps", None
        if path.startswith("/search"):
            return "google.com › Search", q.get("q", [None])[0]
        return "google.com › Other", None
    return host, None


def load():
    """Yield dicts: key, ts (aware datetime), secs, visits=1, title, term."""
    seen = set()
    with tempfile.TemporaryDirectory() as tmp:
        for i, src in enumerate(SOURCES):
            if not src.exists():
                continue
            dst = pathlib.Path(tmp) / f"h{i}.db"
            shutil.copy(src, dst)
            for ext in ("-journal", "-wal"):
                if src.with_name(src.name + ext).exists():
                    shutil.copy(src.with_name(src.name + ext), dst.with_name(dst.name + ext))
            con = sqlite3.connect(dst)
            q = "select u.url, u.title, v.visit_time, v.visit_duration from visits v join urls u on u.id = v.url"
            for url, title, vt, dur in con.execute(q):
                if (url, vt) in seen:
                    continue
                seen.add((url, vt))
                key, term = site_key(url)
                if not key:
                    continue
                yield {"key": key, "ts": chrome_ts(vt), "secs": min(dur or 0, CAP_S * 1_000_000) / 1e6,
                       "title": title or "", "term": term}
            con.close()


def foreground(visits):
    """Collapse overlapping visits onto one timeline (background tabs / two browsers).

    At every instant only the most recently started, still-running visit gets the time.
    Yields (visit, seg_start, seg_end) for each attributed segment.
    """
    import heapq
    vs = sorted(visits, key=lambda v: v["ts"])
    ends = [v["ts"] + datetime.timedelta(seconds=v["secs"]) for v in vs]
    bounds = sorted({t for v, e in zip(vs, ends) for t in (v["ts"], e)})
    heap, i = [], 0                 # (-start_index) of running visits
    for a, b in zip(bounds, bounds[1:]):
        while i < len(vs) and vs[i]["ts"] <= a:
            heapq.heappush(heap, -i); i += 1
        while heap and ends[-heap[0]] <= a:
            heapq.heappop(heap)     # latest-started has ended; fall back to an earlier one
        if heap:
            yield vs[-heap[0]], a, b


if __name__ == "__main__":
    import collections
    c, n = collections.Counter(), 0
    lo = hi = None
    for r in load():
        n += 1; c[r["key"]] += r["secs"]
        lo = min(lo or r["ts"], r["ts"]); hi = max(hi or r["ts"], r["ts"])
    print(n, "visits", lo, "->", hi)
    for k, s in c.most_common(15):
        print(f"{s/3600:7.1f}h  {k}")
