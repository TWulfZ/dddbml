#!/usr/bin/env bash
# Usage: fixture.sh <name> <file.dbml>  → .work/<name>.json, served at ?fixture=<name>
set -euo pipefail
K="$(cd "$(dirname "$0")" && pwd)"; R="$(cd "$K/../../.." && pwd)"
mkdir -p "$K/.work"
[ -f "$K/.work/prep.cjs" ] || "$R/node_modules/.bin/esbuild" "$K/prep.ts" --bundle --platform=node --format=cjs \
  --alias:vscode="$K/vscode-stub.cjs" --outfile="$K/.work/prep.cjs" --log-level=warning
node "$K/.work/prep.cjs" "$2" "$K/.work/$1.json"
