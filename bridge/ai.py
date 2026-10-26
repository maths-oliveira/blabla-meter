"""AI provider layer: one prompt in, text (or JSON) out.

Providers
  - ``cli``        the installed ``opencode`` binary (``opencode run``). Serves OpenCode's free
                   models, which the HTTP API only allows from inside OpenCode. No key needed.
                   This is an agent with local tools and the page text is untrusted input, so it
                   is opt-in only: set ``BBLA_ALLOW_CLI=1`` and restart the bridge.
  - ``zen``        OpenCode Zen HTTP API (pay per use), OpenAI-compatible. This is the default.
  - ``go``         OpenCode Go subscription HTTP API.
  - ``openrouter`` OpenRouter (``openrouter/free`` routes to a free model).
  - ``custom``     any OpenAI-compatible ``/chat/completions`` endpoint.

Config lives in ``~/.config/<app>/`` (override with ``<APP>_CONFIG_DIR``): ``ai.json`` holds the
provider/model/base_url and ``<provider>.key`` files (0600) hold keys. Keys only ever go *in*:
``public_config()`` reports where a key came from, never the key. Without a saved key the
``OPENCODE_API_KEY`` / ``OPENROUTER_API_KEY`` env vars or the installed OpenCode's
``~/.local/share/opencode/auth.json`` are used.

This file is shared verbatim between several projects in ~/src; keep it dependency-free.
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
import uuid
from pathlib import Path

OPENCODE_AUTH = Path.home() / ".local" / "share" / "opencode" / "auth.json"
TIMEOUT = 180

DEFAULT_PROVIDER = "zen"

PROVIDERS = {
    "cli": {"label": "OpenCode CLI agent (opt-in; local tools)", "model": "mimo-v2.6-flash-free"},
    "zen": {"label": "OpenCode Zen API (pay per use)", "model": "deepseek-v4.1-flash",
            "url": "https://opencode.ai/zen/v1/chat/completions", "auth": "opencode",
            "env": "OPENCODE_API_KEY"},
    "go": {"label": "OpenCode Go API (subscription)", "model": "glm-5.3-flash",
           "url": "https://opencode.ai/zen/go/v1/chat/completions", "auth": "opencode-go",
           "env": "OPENCODE_API_KEY"},
    "openrouter": {"label": "OpenRouter", "model": "openrouter/free",
                   "url": "https://openrouter.ai/api/v1/chat/completions", "auth": "openrouter",
                   "env": "OPENROUTER_API_KEY"},
    "custom": {"label": "Custom OpenAI-compatible endpoint", "model": "",
               "url": "", "env": "AI_API_KEY"},
}


class AIError(Exception):
    """A failure that can be shown to the user as-is."""


def cli_allowed() -> bool:
    """The installed OpenCode agent has local tools; never enable it implicitly."""
    return os.environ.get("BBLA_ALLOW_CLI") == "1"


def extract_json(text: str):
    """First JSON object/array in a model reply (tolerates ``` fences and chatter)."""
    text = (text or "").strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    for opener, closer in (("{", "}"), ("[", "]")):
        start = text.find(opener)
        end = text.rfind(closer)
        if start != -1 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except ValueError:
                continue
    raise AIError("the AI did not return valid JSON")


def _write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.chmod(path, 0o600)


class AI:
    def __init__(self, app: str):
        self.app = app
        env_dir = os.environ.get(f"{app.upper()}_CONFIG_DIR")
        self.config_dir = Path(env_dir) if env_dir else Path.home() / ".config" / app

    # ------------------------------------------------------------ configuration
    def _config_file(self) -> Path:
        return self.config_dir / "ai.json"

    def key_file(self, provider: str) -> Path:
        return self.config_dir / f"{provider}.key"

    def load_config(self) -> dict:
        try:
            cfg = json.loads(self._config_file().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            cfg = {}
        configured = cfg.get("provider")
        provider = configured if configured in PROVIDERS else DEFAULT_PROVIDER
        if provider == "cli" and not cli_allowed():
            provider = DEFAULT_PROVIDER
        # If we ignored a bad/unsafe provider, don't carry its model into the
        # fallback provider (a CLI model name is not valid for Zen).
        model = (str(cfg.get("model") or "").strip() if provider == configured else "") \
            or PROVIDERS[provider]["model"]
        return {"provider": provider, "model": model, "base_url": str(cfg.get("base_url") or "")}

    def api_key(self, provider: str) -> tuple:
        """(key, source) — source is "saved", "env" or "opencode"; ("", "") when missing."""
        path = self.key_file(provider)
        if path.is_file():
            key = path.read_text(encoding="utf-8").strip()
            if key:
                return key, "saved"
        spec = PROVIDERS.get(provider, {})
        env = os.environ.get(spec.get("env", ""), "").strip() if spec.get("env") else ""
        if env:
            return env, "env"
        if spec.get("auth"):
            try:
                auth = json.loads(OPENCODE_AUTH.read_text(encoding="utf-8"))
                key = str((auth.get(spec["auth"]) or {}).get("key") or "").strip()
                if key:
                    return key, "opencode"
            except (OSError, ValueError):
                pass
        return "", ""

    def public_config(self) -> dict:
        cfg = self.load_config()
        return {
            **cfg,
            "providers": {k: {"label": v["label"], "default_model": v["model"],
                              "key": self.api_key(k)[1] if k != "cli" else "",
                              "needs_key": k != "cli"} for k, v in PROVIDERS.items()},
            "cli_installed": bool(shutil.which("opencode")),
            "cli_enabled": cli_allowed(),
        }

    def save_config(self, data: dict) -> dict:
        cfg = self.load_config()
        provider = data.get("provider", cfg["provider"])
        if provider not in PROVIDERS:
            raise AIError(f"unknown provider: {provider}")
        if provider == "cli" and not cli_allowed():
            raise AIError("the OpenCode CLI agent is opt-in because it has local tools; "
                          "set BBLA_ALLOW_CLI=1 and restart the bridge to enable it")
        if provider != cfg["provider"] and "model" not in data:
            cfg["model"] = PROVIDERS[provider]["model"]
        cfg["provider"] = provider
        if "model" in data:
            cfg["model"] = str(data["model"] or "").strip()[:120] or PROVIDERS[provider]["model"]
        if "base_url" in data:
            url = str(data["base_url"] or "").strip()
            if url and not re.match(r"^https?://", url):
                raise AIError("base_url must start with http(s)://")
            cfg["base_url"] = url
        key = str(data.get("key") or "").strip()
        if key:
            _write_private(self.key_file(provider), key)
        elif data.get("clear_key"):
            self.key_file(provider).unlink(missing_ok=True)
        _write_private(self._config_file(), json.dumps(cfg, indent=2))
        return self.public_config()

    # ------------------------------------------------------------ calls
    def ask(self, prompt: str, system: str = "", cfg: dict = None) -> str:
        cfg = cfg or self.load_config()
        if cfg["provider"] == "cli":
            full = f"{system}\n\n{prompt}" if system else prompt
            return self._call_cli(cfg["model"], full)
        return self._call_api(cfg, prompt, system)

    def ask_json(self, prompt: str, system: str = "", cfg: dict = None):
        return extract_json(self.ask(prompt, system, cfg))

    def _call_cli(self, model: str, prompt: str) -> str:
        exe = shutil.which("opencode")
        if not exe:
            raise AIError("opencode is not installed on this computer — pick an API provider and set a key")
        full = model if "/" in model else f"opencode/{model}"
        # Isolated empty cwd: the opencode agent reads nothing of ours.
        # --standalone uses a private server instead of the background service.
        with tempfile.TemporaryDirectory(prefix=f"{self.app}-ai-") as tmp:
            try:
                proc = subprocess.run(
                    [exe, "run", "--standalone", "--format", "json", "--model", full, prompt],
                    cwd=tmp, capture_output=True, text=True, timeout=TIMEOUT, stdin=subprocess.DEVNULL,
                )
            except subprocess.TimeoutExpired as exc:
                raise AIError("the AI took too long to answer") from exc
        parts, errors = [], []
        for line in proc.stdout.splitlines():
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("type") == "text":
                parts.append((ev.get("part") or {}).get("text") or "")
            elif ev.get("type") == "error":
                err = ev.get("error") or {}
                errors.append(str((err.get("data") or {}).get("message") or err.get("name") or err))
        if not parts:
            detail = "; ".join(errors) or (proc.stderr or "").strip()[-300:] or f"exit {proc.returncode}"
            raise AIError(f"opencode did not answer ({detail})")
        return "".join(parts)

    def _call_api(self, cfg: dict, prompt: str, system: str = "") -> str:
        provider = cfg["provider"]
        spec = PROVIDERS[provider]
        url = cfg.get("base_url") if provider == "custom" else spec["url"]
        if not url:
            raise AIError("set the endpoint URL for the custom provider")
        if provider == "custom" and not url.rstrip("/").endswith("/chat/completions"):
            url = url.rstrip("/") + "/chat/completions"
        key, _ = self.api_key(provider)
        if not key and provider != "custom":
            raise AIError(f"no API key for {spec['label']} — set one in AI settings")
        headers = {"Content-Type": "application/json", "User-Agent": f"{self.app}/1.0"}
        if key:
            headers["Authorization"] = f"Bearer {key}"
        if provider == "go":
            headers["x-opencode-session"] = f"{self.app}-" + uuid.uuid4().hex[:12]
        messages = ([{"role": "system", "content": system}] if system else []) + [
            {"role": "user", "content": prompt}]
        body = {"model": cfg["model"], "messages": messages, "max_tokens": 4000, "temperature": 0.3}
        req = urllib.request.Request(url, json.dumps(body).encode(), headers)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                data = json.load(resp)
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            try:
                err = json.loads(raw)
                msg = (err.get("error") or {}).get("message") if isinstance(err.get("error"), dict) else None
                msg = msg or err.get("message") or raw[:300]
            except ValueError:
                msg = raw[:300] or str(exc)
            raise AIError(f"{spec['label']} refused ({exc.code}): {msg}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise AIError(f"no answer from {spec['label']}: {exc}") from exc
        try:
            return data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError) as exc:
            raise AIError("unexpected response from the AI provider") from exc
