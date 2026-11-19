#!/usr/bin/env bash
# One-command launcher for the How2Money prototype dashboard.
#
# Usage:
#   ./start_prototype.sh                                  # MongoDB-backed dashboard
#   DEMO=1 ./start_prototype.sh                           # demo mode from the workbook
#   PROTOTYPE_STORAGE_FILE=/path/to/workbook.xlsx ./start_prototype.sh
#                                                        # demo mode with your own copy
#   PORT=3001 ./start_prototype.sh                        # pick a different port
#
# MongoDB is the normal store (accounts, sessions, dashboard profile,
# transactions). If it is unreachable the server falls back to the local
# workbook on its own, and stays there until it restarts. DEMO=1 (or passing
# PROTOTYPE_STORAGE_FILE) skips Mongo for the dashboard entirely.
#
# Note: demo-mode edits (transactions, Big Picture, monthly setup) are saved
# into the workbook it serves. If that is the tracked sample file, restore it
# afterwards with:
#   git checkout -- sample_data/prototype_six_months.xlsx

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$ROOT/How2MoneyLoginInfo"
PORT="${PORT:-3000}"

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

# An explicit workbook only makes sense in demo mode, so treat it as one.
if [[ -n "${PROTOTYPE_STORAGE_FILE:-}" ]]; then
  H2M_DEMO=1
  STORAGE="$PROTOTYPE_STORAGE_FILE"
else
  H2M_DEMO="${DEMO:-${H2M_DEMO:-0}}"
  # Empty means "use the store's default", which keeps the sample-seed on a
  # fresh checkout. Passing the path explicitly would disable that seed.
  STORAGE=""
fi

if [[ "$H2M_DEMO" == "1" ]]; then
  if [[ -n "$STORAGE" && ! -f "$STORAGE" ]]; then
    echo "Workbook not found: $STORAGE" >&2
    exit 1
  fi
  echo "Demo mode: serving '${STORAGE:-$ROOT/prototype_data_storage.xlsx}' at http://localhost:$PORT/dashboard.html"
else
  echo "MongoDB mode: serving the dashboard at http://localhost:$PORT/dashboard.html"
  echo "(falls back to the workbook automatically if MongoDB is unreachable)"
fi

PORT="$PORT" H2M_DEMO="$H2M_DEMO" PROTOTYPE_STORAGE_FILE="$STORAGE" \
  exec node node_modules/tsx/dist/cli.mjs server.ts
