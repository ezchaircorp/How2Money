// One-time import: copy a profile from an xlsx workbook into MongoDB.
//
// Used to make the current `prototype_data_storage.xlsx` profile the canonical
// Mongo data, and to seed a fresh database from sample_data/. Re-running it is
// safe: the profile document and its transactions are replaced.
//
//   node node_modules/tsx/dist/cli.mjs database/import_workbook.ts
//   node node_modules/tsx/dist/cli.mjs database/import_workbook.ts --file ../sample_data/prototype_six_months.xlsx
//   node node_modules/tsx/dist/cli.mjs database/import_workbook.ts --profile prototype

import fs from 'node:fs';
import path from 'node:path';
import { closeMongo, getDb } from './db_mongo';
import { readProfileFromWorkbook } from './prototype_workbook_store';
import { importProfileData } from './prototype_mongo_store';

function repoRoot(): string {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(dir, 'expense_weight.json'))) return dir;
        dir = path.dirname(dir);
    }
    return path.resolve(__dirname, '..');
}

function argument(name: string, fallback: string): string {
    const index = process.argv.indexOf(name);
    const value = index === -1 ? '' : process.argv[index + 1];
    return value && !value.startsWith('--') ? value : fallback;
}

async function main(): Promise<void> {
    const root = repoRoot();
    const defaultFile = path.join(root, 'prototype_data_storage.xlsx');
    const sample = path.join(root, 'sample_data', 'prototype_six_months.xlsx');
    const file = path.resolve(argument('--file', fs.existsSync(defaultFile) ? defaultFile : sample));
    const profileKey = argument('--profile', 'prototype');

    if (!fs.existsSync(file)) {
        throw new Error(`Workbook not found: ${file}`);
    }

    const { data, displayName } = await readProfileFromWorkbook(file, profileKey);
    if (!data.profile) {
        throw new Error(`No profile with key "${profileKey}" in ${file}`);
    }

    await getDb();
    await importProfileData({ ...data, displayName });

    console.log(`Imported ${file}`);
    console.log(`  profile:      ${displayName || '(unnamed)'}`);
    console.log(`  expenses:     ${data.expenses.length}`);
    console.log(`  transactions: ${data.transactions.length}`);
    console.log(`  big picture:  ${data.bigPicture.length}`);
}

main()
    .then(() => closeMongo())
    .catch(async (err) => {
        console.error('Import failed:', err);
        await closeMongo().catch(() => undefined);
        process.exitCode = 1;
    });
