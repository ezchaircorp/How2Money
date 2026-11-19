# Requirements

What you need installed and configured to run each part of How2Money. There is no
Python and no Rust in this repo; the Node side is pinned by
`How2MoneyLoginInfo/package-lock.json`. This file is the human-readable overview.

## Runtime prerequisites

| Tool | Needed for | Notes |
|---|---|---|
| Node.js ≥ 22 (tested on 22.22.2) | `How2MoneyLoginInfo/` | TypeScript 7 (native port) and `tsx` run under it |
| npm | `How2MoneyLoginInfo/` | first install on a fresh clone; see commands below |
| Any modern browser | `html_files/` | static site, no build step |

## Services

| Service | Required? | Used by |
|---|---|---|
| MongoDB | normal operation | accounts, sessions, the shared dashboard profile, transactions, spend entries (`mongodb` driver in `How2MoneyLoginInfo/database/`) |
| — (none) | demo mode | the dashboard can fall back to `prototype_data_storage.xlsx` via `exceljs` when Mongo is unreachable, or run from it directly with `H2M_DEMO=1` |

Mongo is connected in the background after the server starts listening. A missing
or unreachable Mongo never blocks the static site: the dashboard switches to
workbook demo mode for the rest of the process lifetime, and the auth/spend
endpoints answer with an error until Mongo is back.

**Known network limitation:** MongoDB will not connect on client-isolated wifi
(common on school, campus, hotel, and public networks). Those networks let DNS
resolve the Atlas hostname but reset outbound connections to port 27017 during the
TLS handshake, so the log shows `MongoServerSelectionError: read ECONNRESET` or
`MongoNetworkError: read ECONNRESET`. This is not a credentials or connection-string
problem. Use a non-isolated network, a phone hotspot, a local `mongod`, or run the
dashboard with `H2M_DEMO=1`.

## Environment files (gitignored, fill in locally)

- `How2MoneyLoginInfo/database/mongo_connection_info.env` — `MONGO_URI`, optional
  `MONGO_DB_NAME`, optional `MONGO_USER` / `MONGO_PASS`. Loaded first, so it wins
  over the repo-root `.env` when both define a key; the real process environment
  wins over both.
- `.env` (repo root) — loaded by `dotenv` at server startup; `database_link`,
  `database_user_name`, `database_password` are accepted as fallbacks.
- Credentials may live in the link or in the separate keys. The keys win per
  field, so overriding only the password (or only the username) works. A blank
  userinfo in the link (`mongodb+srv://:@cluster/`) and Atlas placeholders like
  `<db_username>` / `<db_password>` are treated as "not set", and the link's
  userinfo is dropped entirely when no username is available.
- Copy `.env.example` at the repo root for the three keys the root `.env` uses
  (`database_link`, `database_user_name`, `database_password`). Server settings
  (`PORT`, `H2M_DEMO`, `PROTOTYPE_STORAGE_FILE`) come from the process
  environment.

## Node dependencies (`How2MoneyLoginInfo/`)

Runtime:

- `express` ^5.3.0 — HTTP server + static file serving
- `mongodb` ^7.9.0 — accounts, sessions, dashboard store, spend entries
- `bcrypt` ^6.0.0 — password hashing (10 rounds)
- `exceljs` ^4.4.0 — demo-mode workbook store and the workbook → Mongo import
- `dotenv` ^17.4.2 — env loading
- `@types/express` ^5.0.6 — listed under dependencies, types only

Dev:

- `typescript` ^7.0.2, `tsx` ^4.23.12, `@types/node`, `@types/bcrypt`

There is no Postgres driver (`pg`) and no Rust crate any more.

## Static site (`html_files/`)

No dependencies, no build step — plain HTML/CSS/JS with relative asset paths and Google
Fonts from a CDN. Open `index.html` directly in a browser.

## Install & run (from `How2MoneyLoginInfo/`)

```bash
npm install                                  # required on a fresh clone
node node_modules/tsx/dist/cli.mjs server.ts # serves html_files/ + API on :3000
node node_modules/typescript/bin/tsc --noEmit # typecheck (clean as of 2026-11)
```

Do **not** use `npx tsx` / `npx tsc` / `npm run *` — the `.bin` shims and a decoy `tsc`
package break those paths. See AGENTS.md "Known broken states" for details.

MongoDB is the normal store. To force the workbook-only demo mode (no database
needed), or to point at a throwaway workbook:

```bash
H2M_DEMO=1 PORT=3001 node node_modules/tsx/dist/cli.mjs server.ts
PROTOTYPE_STORAGE_FILE=/tmp/h2m-test.xlsx PORT=3001 \
  node node_modules/tsx/dist/cli.mjs server.ts
```

The one-command launchers do the same from the repo root:

```bash
./start_prototype.sh                 # MongoDB mode
DEMO=1 ./start_prototype.sh          # workbook demo mode
```

## Importing the workbook into MongoDB

On an empty database the server seeds the `prototype` profile from
`sample_data/prototype_six_months.xlsx`. To make a workbook the canonical Mongo
data (for example the current `prototype_data_storage.xlsx`), run:

```bash
node node_modules/tsx/dist/cli.mjs database/import_workbook.ts
node node_modules/tsx/dist/cli.mjs database/import_workbook.ts --file ../sample_data/prototype_six_months.xlsx
```

Re-running the import is safe: the profile document and its transactions are
replaced. `MONGO_DB_NAME` can point the import at a throwaway database.
