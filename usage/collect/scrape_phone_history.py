"""Scrape a Chromium-Android browser's History screen (Brave, Chrome) over adb (no root, no sync).

Every visit is listed (repeats included) under date headers, newest first; no time of day.
Rows are stitched by absolute scroll position: fling-free drags give a deterministic offset,
re-measured from rows that are unique on both screens.

Output: data/phone/{brave,chrome}_history_scrape.json  [{date, order, title, domain}]
"""
import json, time, re, datetime, pathlib, sys, statistics
from collections import Counter
import adbui

DATA = pathlib.Path(__file__).resolve().parent.parent / "data/phone"
OUT = None   # set in main(): data/phone/<browser>_history_scrape.json
FULL_H = {"item": 61, "date": 53}  # unclipped heights of title / date header text
DRAG = (2200, 250)


def visible(rows):
    return [r for r in rows if r[2] - r[1] == FULL_H[r[0]]]


def uniq_pos(rows):
    c = Counter((r[0], r[3], r[4]) for r in rows)
    return {(r[0], r[3], r[4]): r[1] for r in rows if c[(r[0], r[3], r[4])] == 1}


def parse_date(s):
    s = re.sub(r"^(Today|Yesterday) - ", "", s)
    return datetime.datetime.strptime(s, "%b %d, %Y").date().isoformat()


def save(placed, done):
    rows = sorted(placed.items())
    out, cur, order = [], None, 0
    for _, (kind, title, domain) in rows:
        if kind == "date":
            cur, order = parse_date(title), 0
        elif cur:
            out.append({"date": cur, "order": order, "title": title, "domain": domain})
            order += 1
    OUT.write_text(json.dumps({"scraped_at": datetime.datetime.now().isoformat(timespec="seconds"),
                               "complete": done, "visits": out}, ensure_ascii=False))
    return out


def main(pkg="com.brave.browser", max_steps=5000):
    global OUT
    OUT = DATA / f"{'chrome' if 'chrome' in pkg else 'brave'}_history_scrape.json"
    adbui.sh("settings", "put", "system", "accelerometer_rotation", "0")   # coordinates assume portrait
    adbui.sh("settings", "put", "system", "user_rotation", "0")
    adbui.open_history(pkg)
    placed = {}                      # abs_y -> (kind, text, domain)
    offset, measured, guessed = 0, [], 0
    prev = visible(adbui.dump())
    for r in prev:
        placed[r[1]] = (r[0], r[3], r[4])
    stalls = 0
    for step in range(max_steps):
        adbui.drag(*DRAG)
        time.sleep(0.25)
        cur = visible(adbui.dump())
        a, b = uniq_pos(prev), uniq_pos(cur)
        shifts = Counter(a[k] - b[k] for k in a if k in b)
        typical = int(statistics.median(measured)) if len(measured) >= 3 else None
        if shifts:
            d, votes = shifts.most_common(1)[0]
            if typical and votes < 2 and abs(d - typical) > 40:   # lone coincidental match
                shifts = None
        if shifts:
            if step:                 # step 0 also collapses the header, not a normal scroll
                measured.append(d)
        else:                        # screen of identical rows: assume the typical scroll
            d = int(statistics.median(measured)) if measured else DRAG[0] - DRAG[1] - 200
            guessed += 1
        if [r[1:] for r in cur] == [r[1:] for r in prev]:
            stalls += 1
            if stalls >= 3:
                break
            time.sleep(1.5)          # maybe loading the next page
            continue
        stalls = 0
        offset += d
        for r in cur:
            placed.setdefault(r[1] + offset, (r[0], r[3], r[4]))
        prev = cur
        if step % 20 == 0:
            out = save(placed, False)
            print(f"step {step} shift {d} guessed {guessed} visits {len(out)} at {out[-1]['date'] if out else '-'}", flush=True)
    out = save(placed, True)
    print(f"shifts {Counter(measured).most_common(5)} guessed {guessed}")
    print(f"DONE visits {len(out)} days {len({v['date'] for v in out})} "
          f"{out[-1]['date'] if out else ''} .. {out[0]['date'] if out else ''}", flush=True)


if __name__ == "__main__":
    main(*(sys.argv[1:2] or ["com.brave.browser"]), *[int(a) for a in sys.argv[2:3]])
