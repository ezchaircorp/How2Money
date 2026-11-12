#!/usr/bin/env bash
# One-command launcher for the How2Money prototype dashboard: no login,
# no Postgres — just the static site + the local Excel workbook.
#
# Usage:
#   ./start_prototype.sh                                       # serve the tracked six-month sample
#   PORT=3001 ./start_prototype.sh                             # pick a different port
#   PROTOTYPE_STORAGE_FILE=/path/to/workbook.xlsx ./start_prototype.sh   # use your own copy
#
# Note: edits made on the dashboard (transactions, Big Picture, monthly setup)
# are saved into the workbook it serves. If that is the tracked sample file,
# restore it afterwards with:
#   git checkout -- sample_data/prototype_six_months.xlsx

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/How2MoneyLoginInfo"
SAMPLE="${SAMPLE_WORKBOOK:-$ROOT/sample_data/prototype_six_months.xlsx}"
STORAGE="${PROTOTYPE_STORAGE_FILE:-$SAMPLE}"
PORT="${PORT:-3000}"

if [[ ! -f "$SAMPLE" ]]; then
  echo "Sample workbook not found: $SAMPLE" >&2
  echo "Regenerate it with: node $ROOT/sample_data/generate_sample_workbook.mjs" >&2
  exit 1
fi

cd "$APP"

# node_modules is not tracked: a fresh clone has none, and a copy from
# another OS can carry native binaries for the wrong platform (e.g. a
# committed Windows esbuild on Linux). npm install repairs both, so probe
# for the required files and for esbuild's native binary directly —
# transformSync actually touches the binary, unlike a file-exists check.
if [[ ! -f node_modules/typescript/bin/tsc \
   || ! -f node_modules/tsx/dist/cli.mjs \
   || ! -f node_modules/exceljs/lib/exceljs.nodejs.js \
   || ! -f node_modules/exceljs/package.json ]] \
   || ! node -e "require('esbuild').transformSync('1')" >/dev/null 2>&1; then
  echo "node_modules is missing, incomplete, or built for another platform — installing dependencies…"
  npm install
fi

echo "Prototype mode: serving '$STORAGE' at http://localhost:$PORT/dashboard.html"
PORT="$PORT" PROTOTYPE_STORAGE_FILE="$STORAGE" exec node node_modules/tsx/dist/cli.mjs server.ts
