"""Merge desktop Brave + phone apps + phone Brave history into dashboard.html (v1 kept as dashboard_v1.html).

  python3 build_report.py            # use saved phone snapshots
  python3 build_report.py --collect  # also pull a fresh usagestats snapshot over adb first

Sources (each has its own coverage window; per-day averages divide by that source's days):
  desktop    Brave + Brave Origin history, visit_duration capped 10 min
  phone-apps Android usagestats sessions (exact foreground time), Brave excluded
  phone-web  Brave-Android History screen scrape. Visit counts are exact; time per visit is
             estimated: each day's Brave foreground time is split over that day's visits,
             weighted by the desktop's average time per visit for the same site. Days older
             than the usagestats window use the calibrated average ratio and have no hour.
"""
import json, sys, datetime, pathlib, statistics, collections, re
sys.path.insert(0, str(pathlib.Path(__file__).parent / "collect"))
import desktop, phone
from desktop import TZ, site_key

ROOT = pathlib.Path(__file__).parent
SCRAPE = ROOT / "data/phone/brave_history_scrape.json"   # collect/scrape_phone_history.py


class Acc:
    def __init__(self):
        self.items, self.idx = [], {}
        self.rows = collections.defaultdict(lambda: [0.0, 0])   # (src, item, day, hour, est) -> [secs, visits]
        self.titles = collections.defaultdict(lambda: [0.0, 0])  # (item, dev, title) -> [secs, visits]
        self.terms = collections.defaultdict(lambda: [0.0, 0])

    def item(self, key, lab, kind):
        if key not in self.idx:
            self.idx[key] = len(self.items)
            self.items.append({"k": key, "l": lab, "t": kind})
        return self.idx[key]

    def add(self, src, key, lab, kind, day, hour, secs, visits, est=0, title=None, term=None):
        i = self.item(key, lab, kind)
        r = self.rows[(src, i, day, hour, est)]
        r[0] += secs; r[1] += visits
        dev = "phone" if src.startswith("phone") else "desktop"
        if title:
            t = self.titles[(i, dev, title[:120])]; t[0] += secs; t[1] += visits
        if term and (secs or visits):
            t = self.terms[(i, dev, term.strip().lower()[:80])]; t[0] += secs; t[1] += visits


def split_hours(start, end):
    """Yield (date, hour, secs) for a session crossing hour boundaries."""
    t = start
    while t < end:
        nxt = min(end, t.replace(minute=0, second=0, microsecond=0) + datetime.timedelta(hours=1))
        yield t.date(), t.hour, (nxt - t).total_seconds()
        t = nxt


def phone_site(domain, title):
    """History screen shows domain + title only (no path)."""
    key, _ = site_key("https://" + (domain or "unknown"))
    term = None
    if key == "google.com › Other":
        m = re.match(r"^(.*) - (Pesquisa Google|Google Search)$", title)
        if m:
            key, term = "google.com › Search", m.group(1)
        elif title.startswith("Google Maps"):
            key = "google.com › Maps"
    elif key and key.startswith("youtube.com"):
        key = "youtube.com › Mixed (phone)"   # no path: Shorts vs Watch unknowable
    return key or "unknown", term


def build():
    acc = Acc()
    cov = {}

    # ---- desktop
    visits = list(desktop.load())
    eff = collections.defaultdict(float)             # id(visit) -> foreground seconds
    for v, a, b in desktop.foreground(visits):
        for d, h, secs in split_hours(a, b):
            acc.add("desktop", v["key"], v["key"], "site", d, h, secs, 0, title=v["title"] or None, term=v["term"])
        eff[id(v)] += (b - a).total_seconds()
    per_key = collections.defaultdict(list)
    for v in visits:
        ts = v["ts"]
        acc.add("desktop", v["key"], v["key"], "site", ts.date(), ts.hour, 0, 1, title=v["title"] or None, term=v["term"])
        per_key[v["key"]].append(eff[id(v)])
    dmin, dmax = min(v["ts"] for v in visits), max(v["ts"] for v in visits)
    cov["desktop"] = ((dmin + datetime.timedelta(days=1)).date(), (dmax - datetime.timedelta(days=1)).date())

    # desktop average seconds/visit = prior weight for phone visits
    w = {k: statistics.mean(s) for k, s in per_key.items() if len(s) >= 5}
    yt = [s for k, ss in per_key.items() if k.startswith("youtube.com") for s in ss]
    w["youtube.com › Mixed (phone)"] = statistics.mean(yt) if yt else 60
    w_default = statistics.median(w.values()) if w else 30

    # ---- phone apps (skipped when no usagestats snapshot was ever collected)
    sess, cov["phone-apps"] = phone.sessions()
    if cov["phone-apps"] is None:
        del cov["phone-apps"]  # desktop-only report; pack/rows skip it via `s in cov`
    a0, a1 = cov.get("phone-apps") or (None, None)
    brave_secs = collections.defaultdict(float)     # date -> seconds
    brave_sess = collections.defaultdict(list)      # date -> [(start, end)]
    for pkg, s, e in sess:
        if not (a0 <= s.date() <= a1):
            continue
        if pkg == phone.BRAVE:
            for d, h, secs in split_hours(s, e):
                brave_secs[d] += secs
            brave_sess[s.date()].append((s, e))
            continue
        for d, h, secs in split_hours(s, e):
            acc.add("phone-apps", pkg, phone.label(pkg), "app", d, h, secs, 0)
        acc.add("phone-apps", pkg, phone.label(pkg), "app", s.date(), s.hour, 0, 1)  # launches

    # ---- phone web (scrape)
    scrape = json.loads(SCRAPE.read_text()) if SCRAPE.exists() else {"visits": []}
    by_day = collections.defaultdict(list)
    for v in scrape["visits"]:
        by_day[datetime.date.fromisoformat(v["date"])].append(v)
    if by_day:
        days_sorted = sorted(by_day)
        first = days_sorted[0] + datetime.timedelta(days=1) if len(days_sorted) > 1 else days_sorted[0]
        cov["phone-web"] = (first, min(days_sorted[-1], a1 if brave_secs else days_sorted[-1]))
    weight = lambda v: w.get(phone_site(v["domain"], v["title"])[0], w_default)

    # calibration: phone foreground seconds per unit of desktop-weight, from days having both
    num = sum(brave_secs[d] for d in by_day if d in brave_secs)
    den = sum(weight(v) for d in by_day if d in brave_secs for v in by_day[d])
    k_cal = num / den if den else 1.0

    for d in sorted(set(by_day) | set(brave_secs)):
        if "phone-web" in cov and not (cov["phone-web"][0] <= d <= cov["phone-web"][1]) and d not in brave_secs:
            continue
        visits = sorted(by_day.get(d, []), key=lambda v: -v["order"])   # chronological
        if not visits:
            for s, e in brave_sess.get(d, []):
                for dd, h, secs in split_hours(s, e):
                    acc.add("phone-web", "Brave (phone) · unattributed", "Brave (phone) · unattributed", "site", dd, h, secs, 0)
            continue
        ws = [weight(v) for v in visits]
        if d in brave_secs:
            # lay visits end-to-end over the day's Brave sessions, in order, to get their hours
            scale = brave_secs[d] / sum(ws)
            timeline = [seg for s, e in brave_sess[d] for seg in split_hours(s, e)]
            ti, left = 0, timeline[0][2] if timeline else 0
            for v, wt in zip(visits, ws):
                key, term = phone_site(v["domain"], v["title"])
                need = wt * scale
                acc.add("phone-web", key, key, "site", d, timeline[ti][1] if timeline else -1, 0, 1,
                        title=v["title"], term=term)
                while need > 1e-6 and ti < len(timeline):
                    take = min(need, left)
                    acc.add("phone-web", key, key, "site", timeline[ti][0], timeline[ti][1], take, 0,
                            title=v["title"], term=term)
                    need -= take; left -= take
                    if left <= 1e-6:
                        ti += 1
                        left = timeline[ti][2] if ti < len(timeline) else 0
        else:
            for v, wt in zip(visits, ws):
                key, term = phone_site(v["domain"], v["title"])
                acc.add("phone-web", key, key, "site", d, -1, wt * k_cal, 1, est=1, title=v["title"], term=term)

    # ---- pack
    all_days = sorted({k[2] for k in acc.rows})
    day_idx = {d: i for i, d in enumerate(all_days)}
    src_names = ["desktop", "phone-apps", "phone-web"]
    rows = [[src_names.index(s), i, day_idx[d], h, round(v[0]), v[1], est]
            for (s, i, d, h, est), v in acc.rows.items()
            if s in cov and cov[s][0] <= d <= cov[s][1] and (v[0] >= 1 or v[1])]

    def top(table, n):
        g = collections.defaultdict(list)
        for (i, dev, t), (secs, vis) in table.items():
            g[(i, dev)].append([t, round(secs), vis])
        out = collections.defaultdict(dict)
        for (i, dev), lst in g.items():
            lst.sort(key=lambda x: (-x[1], -x[2]))
            out[i][dev] = lst[:n]
        return out

    return {
        "generated": datetime.datetime.now(TZ).isoformat(timespec="minutes"),
        "tz": "America/Sao_Paulo",
        "sources": [{"id": s, "dev": "phone" if s.startswith("phone") else "desktop",
                     "from": cov[s][0].isoformat(), "to": cov[s][1].isoformat()} if s in cov else None
                    for s in src_names],
        "phoneWeb": {"visits": len(scrape["visits"]), "complete": scrape.get("complete", False),
                     "scraped_at": scrape.get("scraped_at"), "k_cal": round(k_cal, 3)},
        "days": [d.isoformat() for d in all_days],
        "items": acc.items,
        "rows": rows,
        "phoneYear": phone.yearly(),
        "titles": top(acc.titles, 12),
        "terms": top(acc.terms, 12),
        # categories.local.json (git-ignored) holds personal rules; categories.json is the shipped default.
        "config": json.loads(next(f for f in (ROOT / "categories.local.json", ROOT / "categories.json") if f.exists()).read_text()),
    }


if __name__ == "__main__":
    if "--collect" in sys.argv:
        phone.snapshot()
    data = build()
    tpl = (ROOT / "report_template.html").read_text()
    blob = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    (ROOT / "dashboard.html").write_text(tpl.replace("/*__DATA__*/null", blob))
    print(f"dashboard.html: {len(data['rows'])} rows, {len(data['items'])} items, "
          f"sources {[s and (s['id'], s['from'], s['to']) for s in data['sources']]}, "
          f"phone-web visits {data['phoneWeb']['visits']} (k={data['phoneWeb']['k_cal']})")
