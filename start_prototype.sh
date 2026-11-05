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

# Fresh clones ship an incomplete node_modules: the Python-template .gitignore
# excluded typescript/lib, tsx/dist and exceljs/lib, so those packages are
# tracked without the files the server actually loads. Rerun npm install
# whenever any of the required pieces are missing.
if [[ ! -f node_modules/typescript/bin/tsc \
   || ! -f node_modules/tsx/dist/cli.mjs \
   || ! -f node_modules/exceljs/lib/exceljs.nodejs.js \
   || ! -f node_modules/exceljs/package.json ]]; then
  echo "node_modules is incomplete — installing dependencies…"
  npm install
fi

echo "Prototype mode: serving '$STORAGE' at http://localhost:$PORT/dashboard.html"
PORT="$PORT" PROTOTYPE_STORAGE_FILE="$STORAGE" exec node node_modules/tsx/dist/cli.mjs server.ts
