"""Phone (Android, no root) -> app foreground sessions from `dumpsys usagestats`.

Snapshots accumulate in data/phone/ (Android keeps only ~9 days of daily detail, so each
collection run adds to what is kept). Sessions are rebuilt from ACTIVITY_RESUMED/PAUSED
events; screen-off closes the open session. user=999 is the MIUI dual-app space
(second WhatsApp) and is merged into the same package.
"""
import datetime, json, pathlib, re, subprocess
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Sao_Paulo")
DATA = pathlib.Path(__file__).resolve().parent.parent / "data/phone"
MAX_SESSION_S = 4 * 3600
BRAVE = "com.brave.browser"

LABELS = {
    "com.brave.browser": "Brave (phone)", "com.android.chrome": "Chrome (phone)", "com.whatsapp": "WhatsApp",
    "com.google.android.googlequicksearchbox": "Google app", "com.google.android.apps.maps": "Google Maps", "com.miui.securitycenter": "MIUI Security",
    "com.android.camera": "Camera", "com.android.vending": "Play Store", "com.ubercab": "Uber",
    "com.openai.chatgpt": "ChatGPT", "com.android.settings": "Settings", "com.google.android.deskclock": "Clock",
    "com.google.android.apps.docs": "Google Drive", "com.google.android.apps.wellbeing": "Digital Wellbeing", "com.google.android.youtube": "YouTube app",
    "com.google.android.gms": "Google Play services",
}
# Personal labels (git-ignored): {"package": "Label"} in labels.local.json next to this file.
_LOCAL = pathlib.Path(__file__).with_name("labels.local.json")
if _LOCAL.exists():
    LABELS.update(json.loads(_LOCAL.read_text()))


def label(pkg):
    if pkg in LABELS:
        return LABELS[pkg]
    last = [p for p in pkg.split(".") if p not in ("android", "app", "mobile", "com", "br", "production")]
    return (last[-1] if last else pkg).replace("_", " ").title()


def snapshot():
    """Save a fresh checkin dump (keeps history beyond Android's ~9-day window)."""
    DATA.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M")
    for kind, args in (("checkin", ["--checkin"]), ("full", [])):
        out = subprocess.run(["adb", "shell", "dumpsys", "usagestats", *args],
                             capture_output=True, text=True, timeout=120).stdout
        if "user=0" in out:
            (DATA / f"usagestats-{kind}-{stamp}.txt").write_text(out)


EV = re.compile(r'^\s+time="?([\d\- :]+|\d+)"? type=(\w+)(?: package=(\S+))?')


def events():
    """Deduplicated (ms, user, type, package) from every saved snapshot."""
    seen = set()
    for f in sorted(DATA.glob("usagestats-*.txt")):
        user = None
        for line in f.open(errors="replace"):
            m = re.match(r"\s*user=(\d+)", line)
            if m:
                user = m.group(1)
                continue
            m = EV.match(line)
            if not m or user is None:
                continue
            t, typ, pkg = m.groups()
            if t.isdigit():
                ms = int(t)
            else:                    # full dump prints local wall time, second resolution
                ms = int(datetime.datetime.strptime(t, "%Y-%m-%d %H:%M:%S").replace(tzinfo=TZ).timestamp() * 1000)
            key = (user, ms // 1000, typ, pkg)
            if key not in seen:
                seen.add(key)
                yield ms, user, typ, pkg


def sessions():
    """[(package, start, end)] aware datetimes, plus (first_full_day, last_full_day)."""
    per_user = {}
    for ms, user, typ, pkg in events():
        per_user.setdefault(user, []).append((ms, typ, pkg))
    out, t_min, t_max = [], None, None
    for user, evs in per_user.items():
        evs.sort()
        if user == "0":
            t_min, t_max = evs[0][0], evs[-1][0]
        cur = start = None
        for ms, typ, pkg in evs:
            close = (typ == "ACTIVITY_RESUMED" and cur and pkg != cur) or \
                    (typ in ("ACTIVITY_PAUSED", "ACTIVITY_STOPPED") and pkg == cur) or \
                    typ in ("SCREEN_NON_INTERACTIVE", "DEVICE_SHUTDOWN", "KEYGUARD_SHOWN")
            if close and cur:
                if 0 < ms - start <= MAX_SESSION_S * 1000:
                    out.append((cur, start, ms))
                cur = None
            if typ == "ACTIVITY_RESUMED" and pkg != cur:
                cur, start = pkg, ms
    to_dt = lambda ms: datetime.datetime.fromtimestamp(ms / 1000, TZ)
    if t_min is None or t_max is None:
        return [], None  # no usagestats snapshot ever collected: caller skips phone-apps
    first = (to_dt(t_min) + datetime.timedelta(days=1)).date()   # first/last days are partial
    last = (to_dt(t_max) - datetime.timedelta(days=1)).date()
    return [(p, to_dt(a), to_dt(b)) for p, a, b in sorted(out, key=lambda s: s[1])], (first, last)


def yearly():
    """Android's exact per-app totals for the current yearly bucket (latest full dump)."""
    fulls = sorted(DATA.glob("usagestats-full-*.txt"))
    if not fulls:
        return None
    user = sec = rng = None
    tot = {}
    for line in fulls[-1].open(errors="replace"):
        if m := re.match(r"user=(\d+)", line):
            user = m.group(1)
        elif m := re.search(r"In-memory (\w+) stats", line):
            sec = m.group(1)
        elif sec == "yearly" and (m := re.search(r'timeRange="([^"]+)"', line)):
            rng = rng or m.group(1)            # first block = full-year range (user 0)
        elif sec == "yearly" and (m := re.search(r'package=(\S+) totalTimeUsed="([\d:]+)"', line)):
            parts = [int(x) for x in m.group(2).split(":")]
            secs = sum(v * 60 ** i for i, v in enumerate(reversed(parts)))
            tot[m.group(1)] = tot.get(m.group(1), 0) + secs
    a, b = [datetime.datetime.strptime(x.strip(), "%m/%d/%Y, %H:%M") for x in rng.split("–")]
    return {"from": a.date().isoformat(), "to": b.date().isoformat(), "days": max(1, (b - a).days),
            "apps": sorted(([p, label(p), s] for p, s in tot.items() if s >= 60), key=lambda x: -x[2])}


if __name__ == "__main__":
    import collections
    ss, cov = sessions()
    print(len(ss), "sessions, full days", cov)
    c = collections.Counter()
    for p, a, b in ss:
        if cov[0] <= a.date() <= cov[1]:
            c[p] += (b - a).total_seconds()
    days = (cov[1] - cov[0]).days + 1
    for p, s in c.most_common(12):
        print(f"{s/3600:6.2f}h  {s/days/60:5.1f} min/day  {label(p)}")
