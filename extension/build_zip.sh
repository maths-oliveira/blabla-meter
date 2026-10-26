#!/usr/bin/env bash
# Package the Blabla Meter extension for Brave (Chromium MV3, no build step) as a zip
# you can drag onto brave://extensions in Developer mode, or upload to the
# Chrome Web Store (Brave accepts the same .zip).
#
# Usage: ./build_zip.sh [--out DIR]
# Output: blabla-meter-<version>.zip
set -eu
# Resolve the output before cd, so `--out .` means the caller's directory
# (the repo root when run as ./extension/build_zip.sh) rather than extension/.
CALLER="$(pwd)"
cd "$(dirname "$(readlink -f "$0")")" || exit 1
OUT="$CALLER"
if [ "${1:-}" = "--out" ] && [ $# -ge 2 ]; then
  case "$2" in
    /*) OUT="$2" ;;
    *) OUT="$CALLER/$2" ;;
  esac
fi
mkdir -p "$OUT"
python3 - "$OUT" <<'EOF'
import hashlib
import json
import sys
import zipfile
from pathlib import Path

root = Path(".").resolve()
out = Path(sys.argv[1])
ver = json.loads((root / "manifest.json").read_text())["version"]
name = out / f"blabla-meter-{ver}.zip"

# Keep the package to an explicit allowlist: a stray test/debug file must not
# ship to the Chrome Web Store.
ROOT_FILES = {
    "manifest.json", "background.js", "sidepanel.html", "sidepanel.js",
    "options.html", "options.js", "ui.css",
}
files = []
for p in sorted(root.rglob("*")):
    if p.is_dir() or p.name.startswith(".") or p.suffix == ".zip" or p.name == "build_zip.sh":
        continue
    rel = p.relative_to(root).as_posix()
    if rel in ROOT_FILES or (rel.startswith("lib/") and p.suffix == ".js") \
            or (rel.startswith("icons/") and p.suffix == ".png"):
        files.append((rel, p))
    else:
        raise SystemExit(f"unexpected file in extension package: {rel}")

license_file = root.parent / "LICENSE"
if not license_file.is_file():
    raise SystemExit("LICENSE missing from the repository root")
files.append(("LICENSE", license_file))

# Fixed metadata makes the archive reproducible from the same source tree.
FIXED_DATE = (2026, 1, 1, 0, 0, 0)
with zipfile.ZipFile(name, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for rel, p in files:
        info = zipfile.ZipInfo(rel, date_time=FIXED_DATE)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = (0o644 & 0xFFFF) << 16
        z.writestr(info, p.read_bytes())

with zipfile.ZipFile(name) as z:
    names = z.namelist()
    assert "manifest.json" in names and "background.js" in names, names[:5]
    assert "LICENSE" in names, names
    assert z.read("manifest.json") == (root / "manifest.json").read_bytes()
    print(f"wrote {name}")
    print(f"{len(names)} files, manifest + background + LICENSE present")
print(f"sha256 {hashlib.sha256(name.read_bytes()).hexdigest()}")
EOF
