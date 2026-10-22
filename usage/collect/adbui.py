"""Minimal uiautomator helpers over adb (no root needed)."""
import subprocess, xml.etree.ElementTree as ET, re

def run(args, timeout=20, tries=3):
    """adb occasionally wedges a call; time it out and retry instead of hanging the scrape."""
    for i in range(tries):
        try:
            return subprocess.run(["adb", *args], capture_output=True, text=True, timeout=timeout).stdout
        except subprocess.TimeoutExpired:
            if i == tries - 1:
                raise


def sh(*a):
    return run(["shell", *a])

def dump():
    """Return parsed rows of the Brave history list: (kind, top_y, bottom_y, text, domain)."""
    raw = run(["exec-out", "uiautomator dump --compressed /dev/tty"])
    raw = raw[raw.find("<?xml"):raw.rfind(">") + 1]
    root = ET.fromstring(raw)
    rows = []
    for n in root.iter("node"):
        rid = n.get("resource-id", "").split("/")[-1]
        t = n.get("text", "")
        y1, y2 = map(int, re.findall(r"\d+", n.get("bounds"))[1::2])
        if rid == "title":
            rows.append(["item", y1, y2, t, None])
        elif rid == "description" and rows and rows[-1][0] == "item" and rows[-1][4] is None:
            rows[-1][4] = t
        elif not rid and re.match(r"^(Today - |Yesterday - )?[A-Z][a-z]{2} \d{1,2}, \d{4}$", t):
            rows.append(["date", y1, y2, t, None])
    return rows

def swipe(y_from, y_to, ms=1200, x=540):
    sh("input", "swipe", str(x), str(y_from), str(x), str(y_to), str(ms))

def drag(y_from, y_to, x=540, steps=6):
    """Fling-free scroll: move in steps, hold still, then lift -> scroll == distance - touch slop."""
    ys = [y_from + (y_to - y_from) * i // steps for i in range(1, steps + 1)]
    cmd = f"input motionevent DOWN {x} {y_from};" + "".join(f"input motionevent MOVE {x} {y};" for y in ys)
    cmd += f"input motionevent MOVE {x} {y_to}; sleep 0.25; input motionevent UP {x} {y_to}"
    try:                             # never retry a drag: it may have scrolled already
        run(["shell", cmd], timeout=15, tries=1)
    except subprocess.TimeoutExpired:
        run(["shell", f"input motionevent UP {x} {y_to}"])

def nodes():
    raw = run(["exec-out", "uiautomator dump --compressed /dev/tty"])
    raw = raw[raw.find("<?xml"):raw.rfind(">") + 1]
    return list(ET.fromstring(raw).iter("node"))

def tap_where(pred):
    for n in nodes():
        if pred(n):
            x1, y1, x2, y2 = map(int, re.findall(r"\d+", n.get("bounds")))
            sh("input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))
            return True
    return False

def open_history(pkg="com.brave.browser"):
    import time
    sh("monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1")
    time.sleep(3)
    assert tap_where(lambda n: n.get("resource-id", "").split("/")[-1] in ("menu_button", "menu_button_wrapper")), "menu button not found"
    time.sleep(1.5)
    assert tap_where(lambda n: n.get("text") == "History"), "History item not found"
    time.sleep(3)
