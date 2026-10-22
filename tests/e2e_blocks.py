#!/usr/bin/env python3
"""E2E check for bbla section badges, using the REAL extension code.

Runs extension/lib/page.js functions inside a real Chromium page (same
self-contained functions the extension injects), scores via the local bridge
POST /page/score, injects badges, and counts them.

  python3 tests/e2e_blocks.py [URL]   (default: local buzzfeed-like fixture)
"""
import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE_DIR = Path("/tmp/opencode/bbla-e2e")


def extract_func(source: str, name: str) -> str:
    """Full `function name(...) {...}` text (brace-matched, comment/string aware)."""
    start = source.index(f"function {name}")
    i = source.index("{", start)
    depth, j = 0, i
    in_str, in_tpl, in_line, in_block, esc = None, False, False, False, False
    s = source
    while j < len(s):
        c = s[j]
        if in_line:
            if c == "\n":
                in_line = False
        elif in_block:
            if c == "*" and s[j + 1:j + 2] == "/":
                in_block, j = False, j + 1
        elif in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == in_str:
                in_str = None
        elif in_tpl:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == "`":
                in_tpl = False
        else:
            if c == "/" and s[j + 1:j + 2] == "/":
                in_line = True
            elif c == "/" and s[j + 1:j + 2] == "*":
                in_block = True
                j += 1
            elif c in "\"'":
                in_str = c
            elif c == "`":
                in_tpl = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return s[start:j + 1].replace("export function", "function", 1)
        j += 1
    raise ValueError(f"unbalanced braces in {name}")


def bridge_post(path: str, body: dict, timeout: int = 120) -> dict:
    req = urllib.request.Request(f"http://127.0.0.1:8804{path}",
                                 json.dumps(body).encode(),
                                 {"Content-Type": "application/json",
                                  "Origin": "chrome-extension://e2e"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


async def main(url: str) -> int:
    from playwright.async_api import async_playwright

    page_js = (ROOT / "extension" / "lib" / "page.js").read_text()
    extract_src = extract_func(page_js, "extractPage")
    badges_src = extract_func(page_js, "showBlockScores")

    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        page = await browser.new_page()
        await page.goto(url, wait_until="domcontentloaded")
        await page.wait_for_timeout(2500)

        ext = await page.evaluate(f"() => {{ {extract_src} return extractPage(); }}")
        print(f"extract: chars={len(ext['text'])} headings={len(ext['headings'])} blocks={len(ext['blocks'])}")
        for b in ext["blocks"]:
            print(f"  block hid={b['hid']} heading={b['heading'][:50]!r} excerpt={len(b['excerpt'])}ch")

        payload = {
            "page": {"host": "test", "title": ext["title"], "text": ext["text"][:2000]},
            "blocks": [{"id": b["hid"], "hid": b["hid"], "heading": b["heading"],
                        "excerpt": b["excerpt"]} for b in ext["blocks"]],
            "rules": [], "model": "jev-1.13.0",
        }
        data = bridge_post("/page/score", payload)
        print(f"bridge: score={data['usefulness']['value']} topic={data['dims']['topic']} "
              f"blocks_scored={len(data.get('blocks') or {})}")

        items = []
        for hid, b in (data.get("blocks") or {}).items():
            u = b["usefulness"]["value"]
            flags = [f"{k} {v:.2f}" for k, v in b["dims"]["flags"].items() if v >= 0.5]
            items.append({"hid": hid, "score": u,
                          "tags": [f"Topic: {b['dims']['topic']}"] + flags, "ai": []})
        shown = await page.evaluate(
            f"(items) => {{ {badges_src} return showBlockScores(items); }}", items)
        print(f"injected: {shown}")
        count = await page.evaluate("() => document.querySelectorAll('.bbla-badge').length")
        print(f"badges in DOM: {count}")
        # keep-mode: one more badge must ADD without clearing the rest
        keep = await page.evaluate(
            f"""(arg) => {{ {badges_src}
              const h = document.querySelector('article h2, main h2, h2');
              if (!h.id) h.id = 'bbla-keep-probe';
              return showBlockScores([{{hid: h.id, score: 77, tags: ['probe'], ai: []}}], {{keep: true}}); }}""",
            None)
        total = await page.evaluate("() => document.querySelectorAll('.bbla-badge').length")
        print(f"keep-mode: {keep}, badges in DOM now: {total}")
        await page.screenshot(path=str(FIXTURE_DIR / "badges.png"))
        print(f"screenshot: {FIXTURE_DIR / 'badges.png'}")
        try:
            await page.locator(".bbla-badge").first.scroll_into_view_if_needed()
            await page.wait_for_timeout(800)
            await page.screenshot(path=str(FIXTURE_DIR / "badges-visible.png"))
            print(f"at-badge screenshot: {FIXTURE_DIR / 'badges-visible.png'}")
        except Exception as e:
            print(f"scroll-to-badge skipped: {e}")
        await browser.close()
        ok = count and count == shown["shown"] and total == count + (keep.get("shown", 0) if isinstance(keep, dict) else 0)
        return 0 if ok else 1


if __name__ == "__main__":
    if len(sys.argv) < 2:
        srv = subprocess.Popen([sys.executable, "-m", "http.server", "8891", "--bind", "127.0.0.1"],
                               cwd=str(FIXTURE_DIR), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)
        url = "http://127.0.0.1:8891/feed.html"
    else:
        srv, url = None, sys.argv[1]
    try:
        import asyncio
        code = asyncio.run(main(url))
    finally:
        if srv:
            srv.terminate()
    sys.exit(code)
