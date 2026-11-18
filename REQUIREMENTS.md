# Requirements

What you need installed and configured to run each part of How2Money. There is no
Python in this repo, so there is no `requirements.txt` — the Node side is pinned by
`package-lock.json` and the Rust side by `Cargo.lock`; this file is the human-readable
overview.

## Runtime prerequisites

| Tool | Needed for | Notes |
|---|---|---|
| Node.js ≥ 22 (tested on 22.22.2) | `How2MoneyLoginInfo/` | TypeScript 7 (native port) and `tsx` run under it |
| npm | `How2MoneyLoginInfo/` | first install on a fresh clone; see commands below |
| rustc/cargo ≥ 1.85 (edition 2024) | `budgeting/` | **not satisfied here**: installed toolchain is 1.75.0, so `cargo check` currently fails |
| Any modern browser | `html_files/` | static site, no build step |

## Services

| Service | Required? | Used by |
|---|---|---|
| PostgreSQL | only for signup / login / sessions / assessment / DB spend legacy paths | `pg` + migrations in `How2MoneyLoginInfo/migrations/` |
| MongoDB | only for `/api/spend` entries and the demo-account mirror | `mongodb` driver (`database/db_mongo.ts`, `database/db_mongo_store.ts`) |
| — | the prototype dashboard needs **neither** | backed by `prototype_data_storage.xlsx` via `exceljs` |

Both database connections are optional at boot: the server starts listening and serves
the static site + prototype dashboard first, then connects in the background. A missing
Postgres or Mongo only breaks the DB-backed endpoints, not the site.

## Environment files (gitignored, fill in locally)

- `How2MoneyLoginInfo/database/connection_info.env` — Postgres: `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_PORT`. **Tracked in git with live credentials — do not print or commit changes to it.**
- `How2MoneyLoginInfo/database/mongo_connection_info.env` — `MONGO_URI`, optional `MONGO_DB_NAME`.
- `.env` (repo root) — loaded by `dotenv` at server startup.

## Node dependencies (`How2MoneyLoginInfo/`)

Runtime:

- `express` ^5.3.0 — HTTP server + static file serving
- `pg` ^8.23.0 — Postgres client (auth, sessions, assessments, migrations)
- `mongodb` ^7.9.0 — Mongo client (spend entries, demo-profile mirror)
- `bcrypt` ^6.0.0 — password hashing (10 rounds)
- `exceljs` ^4.4.0 — prototype workbook store (`prototype_data_storage.xlsx`)
- `dotenv` ^17.4.2 — env loading
- `@types/express` ^5.0.6 — listed under dependencies, types only

Dev:

- `typescript` ^7.0.2, `tsx` ^4.23.12, `@types/node`, `@types/bcrypt`, `@types/pg`

## Rust dependencies (`budgeting/`)

- `sqlx` 0.8 (runtime-tokio, tls-rustls, postgres, chrono features)
- `tokio` 1 (full features)
- `chrono` 0.4

The crate is an early stub (empty `main`); the z-score budget design lives as notes in
`budgeting/src/main.rs`.

## Static site (`html_files/`)

No dependencies, no build step — plain HTML/CSS/JS with relative asset paths and Google
Fonts from a CDN. Open `index.html` directly in a browser.

## Install & run (from `How2MoneyLoginInfo/`)

```bash
npm install                                  # required on a fresh clone
node node_modules/tsx/dist/cli.mjs server.ts # serves html_files/ + API on :3000
node node_modules/typescript/bin/tsc --noEmit # typecheck (clean as of 2026-11)
node node_modules/tsx/dist/cli.mjs database/migrate.ts --status
```

Do **not** use `npx tsx` / `npx tsc` / `npm run *` — the `.bin` shims and a decoy `tsc`
package break those paths. See AGENTS.md "Known broken states" for details.

Optional throwaway workbook for the prototype dashboard:

```bash
PROTOTYPE_STORAGE_FILE=/tmp/h2m-test.xlsx PORT=3001 \
  node node_modules/tsx/dist/cli.mjs server.ts
```

Rust (from `budgeting/`, currently broken on this toolchain):

```bash
cargo check
cargo run
```
