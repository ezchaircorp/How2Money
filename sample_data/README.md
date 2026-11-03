# Sample prototype workbooks

This directory holds ready-made `prototype_data_storage.xlsx` files for the
no-login dashboard. Point the server at one with `PROTOTYPE_STORAGE_FILE` and
your normal local workbook is left alone.

## Included files

| File | What it is |
|---|---|
| `prototype_six_months.xlsx` | Six months of transactions ending today, a full expected-monthly setup, a Big Picture budget, and recurring flags on rent, utilities, and subscriptions. |
| `generate_sample_workbook.mjs` | Regenerates the workbook above, or writes a different one. |

## Run the dashboard against the sample data

From `How2MoneyLoginInfo/`:

```bash
PROTOTYPE_STORAGE_FILE=../sample_data/prototype_six_months.xlsx PORT=3001 \
  node node_modules/tsx/dist/cli.mjs server.ts
```

Then open <http://localhost:3001/dashboard.html>. The default stats tab reads
`GET /api/prototype/stats?period=week|month|year` and draws the charts from the
sample workbook. Changes made in the dashboard are written back to the sample
file, so copy it first if you want to keep the original untouched.

## Generate another sample

From the repo root:

```bash
node sample_data/generate_sample_workbook.mjs
node sample_data/generate_sample_workbook.mjs sample_data/my_test.xlsx
```

The generator uses deterministic amounts and dates (seeded), so re-running it
reproduces the same six-month shape. Set `SAMPLE_MONTHS` to change the span or
`SAMPLE_SEED` to get different amounts:

```bash
SAMPLE_MONTHS=3 SAMPLE_SEED=42 \
  node sample_data/generate_sample_workbook.mjs sample_data/three_months.xlsx
```

The workbook has the same four sheets as `database/prototype_store.ts`
(`profiles`, `profile_expenses`, `profile_transactions`, `profile_big_picture`)
and writes the `recurring` column the stats view uses. Existing workbooks
without that column still load; blank cells are treated as one-time spending.
The sample Big Picture is income 5000/month, debt 300/month, schooling
2400/year, insurance 1800/year, and savings 800/month, which gives a monthly
budget of 3550. The stats view scales the category targets to fit that total.

The server also uses this workbook to seed the default
`prototype_data_storage.xlsx` when that file has no budget rows, so a fresh
clone shows charts without setting `PROTOTYPE_STORAGE_FILE`. An explicit
`PROTOTYPE_STORAGE_FILE` is never auto-seeded.
