"""Origin allowlist for the local bridge.

The bridge is reachable from every extension in the browser, so it must not
accept an arbitrary chrome-extension:// origin. These tests pin the allowlist
and the development override.
"""

import os
import sys
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import bridge  # noqa: E402

STORE_ID = "emjbfdcigbfojhdipapdjaanlkhcjoai"


class BridgeOriginTest(unittest.TestCase):
    def test_local_tools_without_origin_are_allowed(self):
        self.assertTrue(bridge.allowed(""))

    def test_store_extension_is_allowed(self):
        self.assertTrue(bridge.allowed(f"chrome-extension://{STORE_ID}"))
        self.assertTrue(bridge.allowed(f"chrome-extension://{STORE_ID}/"))

    def test_other_extension_is_rejected(self):
        self.assertFalse(bridge.allowed("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))

    def test_web_pages_are_rejected(self):
        for origin in ("https://evil.example", "http://127.0.0.1:8804", "null"):
            with self.subTest(origin=origin):
                self.assertFalse(bridge.allowed(origin))

    def test_lookalike_origins_are_rejected(self):
        for origin in (
            f"chrome-extension://{STORE_ID}.evil.example",
            f"chrome-extension://{STORE_ID}@evil.example",
            f"chrome-extension://{STORE_ID}/path",
            f"chrome-extension://{STORE_ID}:1234",
            f"chrome-extension://{STORE_ID}?x=1",
            f"chrome-extension://{STORE_ID}#x",
        ):
            with self.subTest(origin=origin):
                self.assertFalse(bridge.allowed(origin))

    def test_development_ids_can_be_added(self):
        with patch.dict(os.environ, {"BBLA_EXTENSION_IDS": "dev-id, second-dev-id"}, clear=False):
            self.assertTrue(bridge.allowed("chrome-extension://dev-id"))
            self.assertTrue(bridge.allowed("chrome-extension://second-dev-id"))
            self.assertFalse(bridge.allowed("chrome-extension://other-dev-id"))

    def test_moz_extension_requires_allowlist(self):
        with patch.dict(os.environ, {"BBLA_EXTENSION_IDS": "firefox-dev-id"}, clear=False):
            self.assertTrue(bridge.allowed("moz-extension://firefox-dev-id"))
            self.assertFalse(bridge.allowed("moz-extension://other-firefox-id"))

    def test_http_handler_enforces_the_allowlist(self):
        srv = bridge.ThreadingHTTPServer(("127.0.0.1", 0), bridge.Handler)
        port = srv.server_address[1]
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        try:
            def request(method="GET", origin=None):
                req = urllib.request.Request(f"http://127.0.0.1:{port}/health", method=method)
                if origin:
                    req.add_header("Origin", origin)
                try:
                    with urllib.request.urlopen(req, timeout=5) as res:
                        return res.status, res.headers.get("Access-Control-Allow-Origin")
                except urllib.error.HTTPError as exc:
                    return exc.code, exc.headers.get("Access-Control-Allow-Origin")

            self.assertEqual(request()[0], 200)
            allowed = f"chrome-extension://{STORE_ID}"
            self.assertEqual(request("GET", allowed), (200, allowed))
            self.assertEqual(request("OPTIONS", allowed), (204, allowed))
            self.assertEqual(request("GET", "chrome-extension://other")[0], 403)
            self.assertEqual(request("OPTIONS", "chrome-extension://other")[0], 403)
            self.assertEqual(request("GET", "https://evil.example")[0], 403)
        finally:
            srv.shutdown()
            srv.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
