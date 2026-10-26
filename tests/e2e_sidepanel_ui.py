#!/usr/bin/env python3
"""Browser regression test for the AI-only side-panel path.

The store install usually has no local bridge. In that case the primary button
is "AI summary & highlights", and the deep-dive result/error must be visible
even though there is no instant score. This runs the real sidepanel.js in
Chromium with stubbed extension APIs and a stubbed bridge.

  python3 tests/e2e_sidepanel_ui.py
"""
import http.server
import sys
import threading
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "extension"


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("SKIP: pip install playwright && playwright install chromium")
        return 0

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(ROOT)))
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    stub = r"""
    (() => {
      let failAnalyze = false;
      const settings = {provider: "bridge", bridgeUrl: "http://127.0.0.1:8804",
                        typesafeKey: "", enabled: true, adsEnabled: false};
      const memory = {rules: [], categories: [], feedback: []};
      window.__failAnalyze = () => { failAnalyze = true; };
      const port = {onDisconnect: {addListener() {}}, postMessage() {}, disconnect() {}};
      window.chrome = {
        runtime: {
          lastError: null,
          getURL: (p) => p,
          connect: () => port,
          sendMessage(msg, cb) {
            const ok = (result) => setTimeout(() => cb({ok: true, result}), 0);
            if (msg.type === "extGet") return ok({enabled: true});
            if (msg.type === "adsGet") return ok({enabled: false, jev: false});
            if (msg.type === "pageStats") return ok({chars: 0});
            if (msg.type === "pageScore") return setTimeout(() => cb({ok: false, error: "NO_JEV_KEY"}), 0);
            if (msg.type === "analyze") {
              if (failAnalyze) return setTimeout(() => cb({ok: false, error: "boom"}), 50);
              return setTimeout(() => cb({ok: true, result: {
                url: "https://example.com", verdict: "A useful test page.",
                pareto: ["One useful point."], highlights: [], found: [], score: 72,
              }}), 200);
            }
            if (msg.type === "showBlocks") return ok(0);
            if (msg.type === "adsRun") return ok({hidden: 0});
            return ok({});
          },
        },
        tabs: {
          query: async () => [{id: 1, url: "https://example.com", title: "Example"}],
          create: async () => ({}),
          onActivated: {addListener() {}},
          onUpdated: {addListener() {}},
        },
        storage: {
          local: {
            get: async (keys) => {
              const all = {settings, memory};
              if (keys == null) return all;
              if (typeof keys === "string") return {[keys]: all[keys]};
              const out = {};
              for (const k of keys) out[k] = all[k];
              return out;
            },
            set: async () => {},
          },
          session: {get: async () => ({}), set: async () => {}, remove: async () => {}},
          onChanged: {addListener() {}},
        },
        scripting: {executeScript: async () => []},
      };
      window.fetch = async (url) => {
        const u = String(url);
        if (u.endsWith("/health")) return {ok: true, json: async () => ({ok: true, provider: "zen", model: "test"})};
        if (u.endsWith("/ads/status")) return {ok: true, json: async () => ({ok: true, jev_available: false})};
        if (u.includes("/usage/site")) return {ok: true, json: async () => ({ok: false, error: "test"})};
        if (u.includes("/usage/rebuild")) return {ok: true, json: async () => ({ok: true})};
        if (u.includes("127.0.0.1:8805")) throw new Error("news down");
        return {ok: false, json: async () => ({})};
      };
    })();
    """

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 430, "height": 900})
            page.add_init_script(stub)
            page.goto(f"http://127.0.0.1:{port}/sidepanel.html", wait_until="networkidle")
            page.wait_for_timeout(300)
            assert page.locator("#btn-analyze").inner_text().startswith("AI summary")
            assert page.locator("#result").is_hidden()

            page.locator("#btn-analyze").click()
            page.wait_for_timeout(50)
            assert not page.locator("#result").is_hidden()
            assert page.locator("#deep-status").inner_text().startswith("Asking")
            page.wait_for_timeout(300)
            assert page.locator("#deep").is_visible()
            assert page.locator(".scorebox").is_hidden()
            assert page.locator("#verdict").inner_text() == "A useful test page."
            assert page.locator("#deep-status").inner_text() == ""

            page.evaluate("window.__failAnalyze()")
            page.locator("#btn-analyze").click()
            page.wait_for_timeout(150)
            assert not page.locator("#result").is_hidden()
            assert page.locator("#deep-status").inner_text().startswith("boom")
            assert page.locator(".scorebox").is_hidden()
            browser.close()
        print("OK: AI-only success and error are visible without a scorebox")
        return 0
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    sys.exit(main())
