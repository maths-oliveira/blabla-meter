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

# Keep the tests off the developer's real allowlist (env and ~/.config/bbla/extension-ids).
os.environ.pop("BBLA_EXTENSION_IDS", None)
os.environ["BBLA_EXTENSION_IDS_FILE"] = str(Path(__import__("tempfile").mkdtemp()) / "extension-ids")

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

    def test_development_ids_can_come_from_a_file(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "extension-ids"
            path.write_text("# unpacked builds, laptop\nfile-dev-id\nsecond-file-id  # brave, old\n")
            with patch.dict(os.environ, {"BBLA_EXTENSION_IDS_FILE": str(path)}, clear=False):
                self.assertTrue(bridge.allowed("chrome-extension://file-dev-id"))
                self.assertTrue(bridge.allowed("chrome-extension://second-file-id"))
                self.assertFalse(bridge.allowed("chrome-extension://other-dev-id"))
                self.assertFalse(bridge.allowed("chrome-extension://"))
                # Commas inside comments must not create IDs.
                self.assertFalse(bridge.allowed("chrome-extension://laptop"))
                self.assertFalse(bridge.allowed("chrome-extension://old"))
                # Edits are picked up (cache keyed on mtime).
                path.write_text("third-file-id\n")
                os.utime(path, ns=(1, 1))
                self.assertTrue(bridge.allowed("chrome-extension://third-file-id"))
                self.assertFalse(bridge.allowed("chrome-extension://file-dev-id"))

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
            def request(method="GET", origin=None, path="/health", body=None, headers=None):
                req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method, data=body)
                if origin:
                    req.add_header("Origin", origin)
                for key, value in (headers or {}).items():
                    req.add_header(key, value)
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

            # A no-Origin local tool is still allowed (the documented local
            # path), but a browser-shaped no-Origin POST is rejected. Extension
            # POSTs carry an allowed Origin.
            read_body = b'{"op":"read"}'
            self.assertEqual(request("POST", None, "/memory/rules", read_body)[0], 200)
            self.assertEqual(request("POST", None, "/memory/rules", read_body,
                                     headers={"Sec-Fetch-Site": "none"})[0], 403)
            self.assertEqual(request("POST", allowed, "/memory/rules", read_body)[0], 200)
            self.assertEqual(request("POST", "chrome-extension://other", "/memory/rules", read_body)[0], 403)
            self.assertEqual(request("POST", allowed, "/usage/site", b'{"url":"https://example.com"}')[0], 200)

            # Old no-Origin data GETs are closed.
            self.assertEqual(request("GET", None, "/memory/rules")[0], 403)
            self.assertEqual(request("GET", None, "/usage/site")[0], 403)
            self.assertEqual(request("GET", None, "/usage")[0], 200)  # local tool
            self.assertEqual(request("GET", None, "/usage", headers={"Sec-Fetch-Mode": "cors"})[0], 403)
            self.assertEqual(request("GET", None, "/usage", headers={"Sec-Fetch-Mode": "navigate"})[0], 200)
        finally:
            srv.shutdown()
            srv.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
