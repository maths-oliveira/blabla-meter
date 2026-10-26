"""Provider defaults for the local bridge.

The installed OpenCode CLI is an agent with local tools, so it must never be
selected implicitly from an empty config or a stale config.
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bridge"))

import ai  # noqa: E402


class BridgeAIConfigTest(unittest.TestCase):
    def test_default_is_zen_not_the_cli_agent(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"BBLA_CONFIG_DIR": tmp}, clear=True):
            cfg = ai.AI("bbla").load_config()
            self.assertEqual(cfg["provider"], "zen")
            self.assertEqual(cfg["model"], ai.PROVIDERS["zen"]["model"])

    def test_cli_config_is_ignored_unless_explicitly_enabled(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"BBLA_CONFIG_DIR": tmp}, clear=True):
            Path(tmp, "ai.json").write_text(
                json.dumps({"provider": "cli", "model": "cli-only-model"}), encoding="utf-8"
            )
            cfg = ai.AI("bbla").load_config()
            self.assertEqual(cfg["provider"], "zen")
            self.assertEqual(cfg["model"], ai.PROVIDERS["zen"]["model"])

    def test_cli_is_available_after_opt_in(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"BBLA_CONFIG_DIR": tmp, "BBLA_ALLOW_CLI": "1"}, clear=True
        ):
            Path(tmp, "ai.json").write_text(json.dumps({"provider": "cli"}), encoding="utf-8")
            cfg = ai.AI("bbla").load_config()
            self.assertEqual(cfg["provider"], "cli")
            self.assertEqual(cfg["model"], ai.PROVIDERS["cli"]["model"])

    def test_bad_provider_falls_back_and_drops_its_model(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"BBLA_CONFIG_DIR": tmp}, clear=True):
            Path(tmp, "ai.json").write_text(
                json.dumps({"provider": "not-a-provider", "model": "not-a-model"}), encoding="utf-8"
            )
            cfg = ai.AI("bbla").load_config()
            self.assertEqual(cfg["provider"], "zen")
            self.assertEqual(cfg["model"], ai.PROVIDERS["zen"]["model"])

    def test_saving_cli_requires_opt_in(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {"BBLA_CONFIG_DIR": tmp}, clear=True):
            with self.assertRaises(ai.AIError):
                ai.AI("bbla").save_config({"provider": "cli"})


if __name__ == "__main__":
    unittest.main()
