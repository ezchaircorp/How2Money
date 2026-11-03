#!/usr/bin/env node
// Generates a ready-to-use prototype dashboard workbook.
//
// Usage (from the repo root):
//   node sample_data/generate_sample_workbook.mjs
//   node sample_data/generate_sample_workbook.mjs sample_data/my_test.xlsx
//
// The workbook has the same sheets as database/prototype_store.ts, six months
// of transactions ending today, a full expected-monthly setup, and a Big
// Picture budget. Recurring flags are set on rent, utilities, and subscriptions
// so the stats view has a meaningful split.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

let ExcelJS;
try {
    ExcelJS = require('../How2MoneyLoginInfo/node_modules/exceljs');
} catch {
    ExcelJS = require('exceljs');
}

const { Workbook } = ExcelJS;

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(process.argv[2] || path.join(here, 'prototype_six_months.xlsx'));
const monthsBack = Math.max(1, Number(process.env.SAMPLE_MONTHS) || 6);
const seed = Number(process.env.SAMPLE_SEED) || 20261103;

// Small deterministic PRNG so re-running the generator produces the same file.
let randomState = seed >>> 0;
function random() {
    randomState += 0x6d2b79f5;
    let value = randomState;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function between(min, max) {
    return Math.round((min + random() * (max - min)) * 100) / 100;
}

function isoDay(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
        date.getDate()
    ).padStart(2, '0')}`;
}

function daysInMonth(year, monthIndex) {
    return new Date(year, monthIndex + 1, 0).getDate();
}

const now = new Date();
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const profileId = 'sample-profile-six-months';

const transactions = [];
let nextTransactionId = 1;

function addTransaction(date, bucket, category, amount, note, recurring) {
    transactions.push({
        transaction_id: nextTransactionId++,
        profile_id: profileId,
        category,
        bucket,
        amount: Math.round(amount * 100) / 100,
        spent_on: isoDay(date),
        note,
        created_at: date.toISOString(),
        recurring,
    });
}

for (let offset = monthsBack - 1; offset >= 0; offset -= 1) {
    const month = new Date(today.getFullYear(), today.getMonth() - offset, 1);
    const year = month.getFullYear();
    const monthIndex = month.getMonth();
    const isCurrentMonth =
        year === today.getFullYear() && monthIndex === today.getMonth();
    const lastDay = isCurrentMonth ? today.getDate() : daysInMonth(year, monthIndex);

    const day = dayNumber => new Date(year, monthIndex, Math.min(dayNumber, lastDay));
    const add = (dayNumber, bucket, category, amount, note, recurring = false) => {
        if (dayNumber > lastDay) return;
        addTransaction(day(dayNumber), bucket, category, amount, note, recurring);
    };

    for (let current = 1; current <= lastDay; current += 1) {
        if (current === 1) {
            add(current, 'housing', 'expense_housing_rent', 1400, 'Rent', true);
        }
        if (current === 3) {
            add(
                current,
                'subscriptions_entertainment',
                'expense_subscriptions_entertainment_recurring',
                15.99,
                'Streaming subscription',
                true
            );
        }
        if (current === 5) {
            add(
                current,
                'housing',
                'expense_housing_utilities',
                between(95, 145),
                'Electricity and water',
                true
            );
        }
        if (current === 8) {
            add(
                current,
                'subscriptions_entertainment',
                'expense_subscriptions_entertainment_recurring',
                12.99,
                'Music subscription',
                true
            );
        }
        if (current === 12) {
            add(current, 'work_professional', 'work_professional', between(18, 45), 'Software');
        }
        if (current === 20) {
            add(current, 'family_pets', 'expense_pets_food', between(30, 55), 'Pet food');
        }
        if (current === 24) {
            add(current, 'household', 'household', between(15, 40), 'Household supplies');
        }
        if (current % 7 === 2) {
            add(current, 'transportation', 'expense_transportation_gas', between(36, 58), 'Gas');
        }
        if (current % 6 === 0) {
            add(current, 'food', 'expense_food_groceries', between(45, 90), 'Groceries');
        }
        if (current % 5 === 3) {
            add(current, 'food', 'expense_food_fast_food', between(8, 22), 'Fast food');
        }
        if (current % 11 === 4) {
            add(current, 'food', 'expense_food_restaurants', between(22, 55), 'Dinner out');
        }
        if (current % 13 === 5) {
            add(current, 'shopping', 'shopping', between(15, 85), 'Shopping');
        }
        if (current % 9 === 6) {
            add(
                current,
                'transportation',
                'expense_transportation_transit',
                between(8, 28),
                'Transit / parking'
            );
        }
        if (current % 17 === 7) {
            add(current, 'health_self_care', 'health_self_care', between(20, 60), 'Pharmacy');
        }
        if (current % 19 === 9) {
            add(current, 'travel', 'travel', between(25, 90), 'Trip expense');
        }
        if (current % 23 === 12) {
            add(current, 'education', 'education', between(15, 50), 'Course materials');
        }
    }
}

const expenses = [
    ['housing', 1400, 'monthly'],
    ['transportation', 320, 'monthly'],
    ['food', 540, 'monthly'],
    ['travel', 900, 'yearly'],
    ['subscriptions_entertainment', 85, 'monthly'],
    ['shopping', 180, 'monthly'],
    ['health_self_care', 120, 'monthly'],
    ['education', 60, 'monthly'],
    ['work_professional', 40, 'monthly'],
    ['family_pets', 160, 'monthly'],
    ['household', 90, 'monthly'],
];

// Monthly budget: 5000 - (300 + 200 + 150) - 800 = 3550. The stats view scales
// the category targets above to fit this total.
const bigPicture = [
    ['income', 5000, 'monthly'],
    ['debt_payment', 300, 'monthly'],
    ['schooling', 2400, 'yearly'],
    ['insurance', 1800, 'yearly'],
    ['savings', 800, 'monthly'],
];

const workbook = new Workbook();
workbook.creator = 'How2Money sample generator';

function addSheet(name, headers, rows) {
    const sheet = workbook.addWorksheet(name);
    sheet.addRow(headers);
    for (const row of rows) sheet.addRow(row);
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    return sheet;
}

addSheet(
    'profiles',
    ['profile_id', 'profile_key', 'display_name', 'userid', 'created_at', 'updated_at'],
    [[profileId, 'prototype', 'Sample six-month profile', '', today.toISOString(), now.toISOString()]]
);

addSheet(
    'profile_expenses',
    ['profile_id', 'category', 'amount', 'frequency', 'detail', 'updated_at'],
    expenses.map(([bucket, amount, frequency]) => [
        profileId,
        bucket,
        amount,
        frequency,
        '{}',
        now.toISOString(),
    ])
);

addSheet(
    'profile_transactions',
    [
        'transaction_id',
        'profile_id',
        'category',
        'bucket',
        'amount',
        'spent_on',
        'note',
        'created_at',
        'recurring',
    ],
    transactions.map(transaction => [
        transaction.transaction_id,
        transaction.profile_id,
        transaction.category,
        transaction.bucket,
        transaction.amount,
        transaction.spent_on,
        transaction.note,
        transaction.created_at,
        transaction.recurring,
    ])
);

addSheet(
    'profile_big_picture',
    ['profile_id', 'category', 'amount', 'frequency', 'updated_at'],
    bigPicture.map(([category, amount, frequency]) => [
        profileId,
        category,
        amount,
        frequency,
        now.toISOString(),
    ])
);

fs.mkdirSync(path.dirname(output), { recursive: true });
await workbook.xlsx.writeFile(output);

console.log(
    `Wrote ${path.relative(process.cwd(), output) || output} with ${transactions.length} transactions ` +
        `across ${monthsBack} months and a Big Picture budget.`
);
console.log(`Use it with: PROTOTYPE_STORAGE_FILE=${path.relative(process.cwd(), output)}`);
