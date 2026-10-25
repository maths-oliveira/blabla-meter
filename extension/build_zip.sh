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
import json, sys, zipfile
from pathlib import Path
root = Path(".")
out = Path(sys.argv[1])
ver = json.loads((root / "manifest.json").read_text())["version"]
name = out / f"blabla-meter-{ver}.zip"
skip = {"build_zip.sh"}
with zipfile.ZipFile(name, "w", zipfile.ZIP_DEFLATED) as z:
    for p in sorted(root.rglob("*")):
        if p.is_dir() or p.suffix == ".zip" or p.name in skip or p.name.startswith("."):
            continue
        z.write(p, p.relative_to(root))
print(f"wrote {name}")
with zipfile.ZipFile(name) as z:
    names = z.namelist()
    assert "manifest.json" in names and "background.js" in names, names[:5]
    print(f"{len(names)} files, manifest + background present")
EOF
