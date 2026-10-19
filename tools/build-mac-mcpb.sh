#!/bin/sh
# Build molequle-mac.mcpb: the Claude Desktop extension with macOS (Apple
# Silicon) Python 3.13 dependencies. The bundled molequle.mcpb ships Windows
# wheels (pywin32, *.pyd) and won't start on a Mac.
#
# Requires python3 with pip, and npx. The packaged extension runs on
# Python 3.13 from python.org:
#   /Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13
#
# Usage: sh tools/build-mac-mcpb.sh   (from the project root)
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PY_TARGET=/Library/Frameworks/Python.framework/Versions/3.13/bin/python3.13
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT

python3 -m venv "$BUILD/venv"
"$BUILD/venv/bin/pip" install -q --upgrade pip

mkdir "$BUILD/ext"
cp -R "$ROOT/mcp/manifest.json" "$ROOT/mcp/requirements.txt" "$ROOT/mcp/server" "$BUILD/ext/"
find "$BUILD/ext" -name __pycache__ -prune -exec rm -rf {} +

# Same versions as the Windows bundle; mcp 2.x changed the FastMCP API.
"$BUILD/venv/bin/pip" install -q --no-compile --target "$BUILD/ext/lib" \
  --platform macosx_11_0_arm64 --python-version 3.13 --implementation cp \
  --only-binary=:all: "mcp==1.26.0" "httpx==0.28.1"

"$BUILD/venv/bin/python" - "$BUILD/ext/manifest.json" "$PY_TARGET" <<'EOF'
import json, sys
path, python = sys.argv[1], sys.argv[2]
m = json.load(open(path))
m["display_name"] += " (Mac)"
m["description"] += " Mac build: requires Python 3.13 from python.org."
m["server"]["mcp_config"]["command"] = python
m["compatibility"]["platforms"] = ["darwin"]
with open(path, "w") as f:
    json.dump(m, f, indent=2, ensure_ascii=False)
    f.write("\n")
EOF

npx -y @anthropic-ai/mcpb pack "$BUILD/ext" "$ROOT/molequle-mac.mcpb"
