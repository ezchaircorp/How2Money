// Reads and writes the no-login dashboard's data in an .xlsx workbook.
//
// Handles every /api/prototype/* route that dashboard.js calls. The workbook is
// PROTOTYPE_STORAGE_FILE when that is set, otherwise prototype_data_storage.xlsx
// in the folder the server was started from. A missing file is created.
//
// Saves run one at a time and go through a temporary file, so two quick clicks
// cannot overwrite each other and a crash cannot leave half a workbook.
//
// Plain Node server:
//   const server = http.createServer(async (req, res) => {
//     if (await handlePrototypeRequest(req, res)) return;
//     // ...your other routes
//   });
//
// Express (must come before any older /api/prototype routes):
//   app.use((req, res, next) => {
//     handlePrototypeRequest(req, res).then(done => { if (!done) next(); }).catch(next);
//   });

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import ExcelJS from 'exceljs';

type Row = Record<string, unknown>;
type Frequency = 'monthly' | 'yearly' | 'weekly';

const SHEETS = {
    profiles: ['profile_id', 'profile_key', 'display_name', 'userid', 'created_at', 'updated_at'],
    expenses: ['profile_id', 'category', 'amount', 'frequency', 'detail', 'updated_at'],
    transactions: [
        'transaction_id', 'profile_id', 'category', 'bucket', 'amount',
        'spent_on', 'note', 'created_at', 'recurring',
    ],
    bigPicture: ['profile_id', 'category', 'amount', 'frequency', 'updated_at'],
} as const;

type TableName = keyof typeof SHEETS;

const SHEET_NAMES: Record<TableName, string> = {
    profiles: 'profiles',
    expenses: 'profile_expenses',
    transactions: 'profile_transactions',
    bigPicture: 'profile_big_picture',
};

const TABLE_NAMES = Object.keys(SHEETS) as TableName[];

// Mirrors the buckets in database/expense_categories.ts and dashboard.js.
const BUCKETS = [
    {
        bucket: 'housing', label: 'Housing',
        detailFields: [
            'expense_housing_rent', 'expense_housing_taxes',
            'expense_housing_repairs', 'expense_housing_utilities',
        ],
    },
    {
        bucket: 'transportation', label: 'Transportation',
        detailFields: [
            'expense_transportation_gas', 'expense_transportation_transit',
            'expense_transportation_auto',
        ],
    },
    {
        bucket: 'food', label: 'Food',
        detailFields: [
            'expense_food_groceries', 'expense_food_restaurants', 'expense_food_fast_food',
        ],
    },
    { bucket: 'travel', label: 'Travel', detailFields: [] },
    {
        bucket: 'subscriptions_entertainment', label: 'Subscriptions & Entertainment',
        detailFields: [
            'expense_subscriptions_entertainment_recurring',
            'expense_subscriptions_entertainment_onetime',
        ],
    },
    { bucket: 'shopping', label: 'Shopping', detailFields: [] },
    { bucket: 'health_self_care', label: 'Health & Self-Care', detailFields: [] },
    { bucket: 'education', label: 'Education', detailFields: [] },
    { bucket: 'work_professional', label: 'Work & Professional', detailFields: [] },
    {
        bucket: 'family_pets', label: 'Family & Pets',
        detailFields: [
            'expense_family_childcare', 'expense_family_kids', 'expense_family_support',
            'expense_pets_food', 'expense_pets_vet', 'expense_pets_grooming',
        ],
    },
    { bucket: 'household', label: 'Household', detailFields: [] },
];

const BIG_PICTURE_CATEGORIES = ['income', 'debt_payment', 'schooling', 'insurance', 'savings'];
const MONTHLY_MULTIPLIER: Record<Frequency, number> = { monthly: 1, yearly: 1 / 12, weekly: 52 / 12 };
const RECENT_TRANSACTIONS = 100;
const MAX_BODY_BYTES = 1_000_000;

class RequestError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

/* ── Small helpers ── */

const toNumber = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};
const roundCents = (value: number) => Math.round(value * 100) / 100;
const moneyText = (value: number) => value.toFixed(2);
const isFrequency = (value: unknown): value is Frequency =>
    value === 'monthly' || value === 'yearly' || value === 'weekly';
const asFrequency = (value: unknown): Frequency => (isFrequency(value) ? value : 'monthly');
const perMonth = (row: Row) => toNumber(row.amount) * MONTHLY_MULTIPLIER[asFrequency(row.frequency)];
const isTrue = (value: unknown) =>
    value === true || value === 1 || String(value).toLowerCase() === 'true';

function isoDay(date: Date) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

// Text dates stay as they are. Date cells appear if someone edits in Excel,
// and Excel stores those as midnight UTC.
function dayText(value: unknown) {
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10);
}

function isRealDay(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseDetail(value: unknown) {
    if (value && typeof value === 'object') return value as Row;
    try {
        return JSON.parse(String(value || '{}')) as Row;
    } catch {
        return {};
    }
}

function latest(rows: Row[]) {
    return rows.reduce<string | null>((newest, row) => {
        const value = String(row.updated_at ?? row.created_at ?? '');
        return value && (!newest || value > newest) ? value : newest;
    }, null);
}

/* ── Workbook access ── */

const storageFile = () =>
    path.resolve(process.env.PROTOTYPE_STORAGE_FILE || 'prototype_data_storage.xlsx');

interface Store {
    workbook: ExcelJS.Workbook;
    tables: Record<TableName, Row[]>;
}

function headersFor(sheet: ExcelJS.Worksheet, table: TableName) {
    const headers: string[] = [];
    sheet.getRow(1).eachCell((cell, column) => {
        headers[column - 1] = String(cell.value);
    });
    // Older workbooks have no recurring column, so add whatever is missing.
    for (const header of SHEETS[table]) {
        if (!headers.includes(header)) headers.push(header);
    }
    return headers;
}

function readTable(workbook: ExcelJS.Workbook, table: TableName) {
    const name = SHEET_NAMES[table];
    const sheet = workbook.getWorksheet(name) ?? workbook.addWorksheet(name);
    const headers = headersFor(sheet, table);
    const rows: Row[] = [];
    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const record: Row = {};
        headers.forEach((header, index) => {
            record[header] = row.getCell(index + 1).value;
        });
        rows.push(record);
    });
    return rows;
}

async function load(): Promise<Store> {
    const workbook = new ExcelJS.Workbook();
    const exists = await fs.access(storageFile()).then(() => true, () => false);
    if (exists) await workbook.xlsx.readFile(storageFile());
    const tables = {} as Record<TableName, Row[]>;
    for (const table of TABLE_NAMES) tables[table] = readTable(workbook, table);
    return { workbook, tables };
}

async function save({ workbook, tables }: Store) {
    for (const table of TABLE_NAMES) {
        const sheet = workbook.getWorksheet(SHEET_NAMES[table]);
        if (!sheet) continue;
        const headers = headersFor(sheet, table);
        // One at a time from the bottom: spliceRows(2, n) leaves the last rows behind.
        for (let rowNumber = sheet.rowCount; rowNumber > 1; rowNumber -= 1) {
            sheet.spliceRows(rowNumber, 1);
        }
        const header = sheet.getRow(1);
        header.values = headers;
        header.font = { bold: true };
        header.commit();
        sheet.views = [{ state: 'frozen', ySplit: 1 }];
        for (const row of tables[table]) sheet.addRow(headers.map(name => row[name] ?? ''));
    }

    const file = storageFile();
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
        await workbook.xlsx.writeFile(temporary);
        await fs.rename(temporary, file);
    } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        if (['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            throw new RequestError(
                503,
                'The workbook could not be saved. If it is open in Excel, close it and try again.'
            );
        }
        throw error;
    }
}

// Everything goes through this queue, so a read never sees a half-finished save.
let queue: Promise<unknown> = Promise.resolve();
function inOrder<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work, work);
    queue = result.catch(() => undefined);
    return result;
}

function findProfile({ tables }: Store) {
    return tables.profiles.find(row => row.profile_key === 'prototype') ?? tables.profiles[0];
}

// Used by saves. Reads never create a profile, so opening the page changes nothing.
function ensureProfile(store: Store) {
    const existing = findProfile(store);
    if (existing) return existing;
    const now = new Date().toISOString();
    const profile: Row = {
        profile_id: store.tables.profiles.reduce((max, row) => Math.max(max, toNumber(row.profile_id)), 0) + 1,
        profile_key: 'prototype',
        display_name: 'Prototype profile',
        userid: '',
        created_at: now,
        updated_at: now,
    };
    store.tables.profiles.push(profile);
    return profile;
}

function touch(profile: Row) {
    profile.updated_at = new Date().toISOString();
}

const rowsFor = (rows: Row[], profile: Row | undefined) =>
    profile ? rows.filter(row => row.profile_id === profile.profile_id) : [];

/* ── Building the responses dashboard.js expects ── */

function bigPictureTotals(entries: Row[]) {
    const monthly = (category: string) => {
        const entry = entries.find(row => row.category === category);
        return entry ? perMonth(entry) : 0;
    };
    const income = monthly('income');
    const debtPayment = monthly('debt_payment');
    const schooling = monthly('schooling');
    const insurance = monthly('insurance');
    const savings = monthly('savings');
    const recurring = debtPayment + schooling + insurance;
    return {
        income: roundCents(income),
        debt_payment: roundCents(debtPayment),
        schooling: roundCents(schooling),
        insurance: roundCents(insurance),
        recurring: roundCents(recurring),
        savings: roundCents(savings),
        budget: roundCents(income - recurring - savings),
        configured: entries.some(row => toNumber(row.amount) > 0),
    };
}

function profilePayload(store: Store) {
    const profile = findProfile(store);
    const expenses = rowsFor(store.tables.expenses, profile);
    const transactions = rowsFor(store.tables.transactions, profile);
    const bigPicture = rowsFor(store.tables.bigPicture, profile);
    const thisMonth = isoDay(new Date()).slice(0, 7);
    const monthRows = transactions.filter(row => dayText(row.spent_on).startsWith(thisMonth));

    const monthly = BUCKETS.map(({ bucket, label }) => {
        const expense = expenses.find(row => row.category === bucket);
        const spent = monthRows.filter(row => row.bucket === bucket);
        return {
            bucket,
            label,
            expected: toNumber(expense?.amount),
            frequency: asFrequency(expense?.frequency),
            expectedMonthly: expense ? roundCents(perMonth(expense)) : 0,
            actual: roundCents(spent.reduce((sum, row) => sum + toNumber(row.amount), 0)),
            transactionCount: spent.length,
            detail: expense ? parseDetail(expense.detail) : {},
            updated_at: expense?.updated_at ?? null,
        };
    });

    const recent = [...transactions]
        .sort((a, b) =>
            dayText(b.spent_on).localeCompare(dayText(a.spent_on)) ||
            toNumber(b.transaction_id) - toNumber(a.transaction_id))
        .slice(0, RECENT_TRANSACTIONS);

    return {
        profile: {
            key: 'prototype',
            display_name: profile?.display_name || 'Prototype profile',
            category_count: expenses.filter(row => toNumber(row.amount) > 0).length,
            total_monthly: moneyText(monthly.reduce((sum, row) => sum + row.expectedMonthly, 0)),
            actual_month: moneyText(monthRows.reduce((sum, row) => sum + toNumber(row.amount), 0)),
            transaction_count: monthRows.length,
            updated_at: profile?.updated_at || latest([...expenses, ...bigPicture]),
        },
        buckets: BUCKETS,
        monthly,
        big_picture: {
            entries: bigPicture.map(row => ({
                category: row.category,
                amount: toNumber(row.amount),
                frequency: asFrequency(row.frequency),
            })),
            totals: bigPictureTotals(bigPicture),
        },
        transactions: recent.map(row => ({
            id: row.transaction_id,
            category: row.category,
            bucket: row.bucket,
            amount: toNumber(row.amount),
            spent_on: dayText(row.spent_on),
            note: row.note ? String(row.note) : '',
            recurring: isTrue(row.recurring),
            created_at: row.created_at,
        })),
    };
}

function statsPayload(store: Store, requested: string | null) {
    const period = requested === 'week' || requested === 'month' || requested === 'year' ? requested : 'six';
    const profile = findProfile(store);
    const expenses = rowsFor(store.tables.expenses, profile);
    const bigPicture = rowsFor(store.tables.bigPicture, profile);
    const totals = bigPictureTotals(bigPicture);
    const setupMonthly = expenses.reduce((sum, row) => sum + perMonth(row), 0);
    const monthlyBudget = totals.configured ? Math.max(0, totals.budget) : setupMonthly;

    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth();
    const shortMonth = (date: Date) => date.toLocaleDateString('en-US', { month: 'short' });
    const points: { label: string; from: string; to: string; expected: number }[] = [];
    let from: Date;
    let to: Date;
    let label: string;
    let periodBudget: number;

    if (period === 'week') {
        // Monday through Sunday.
        from = new Date(year, month, today.getDate() - ((today.getDay() + 6) % 7));
        to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 6);
        label = `${shortMonth(from)} ${from.getDate()} – ${shortMonth(to)} ${to.getDate()}, ${to.getFullYear()}`;
        periodBudget = (monthlyBudget * 12) / 52;
        for (let index = 0; index < 7; index += 1) {
            const date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + index);
            points.push({
                label: date.toLocaleDateString('en-US', { weekday: 'short' }),
                from: isoDay(date),
                to: isoDay(date),
                expected: periodBudget / 7,
            });
        }
    } else if (period === 'month') {
        from = new Date(year, month, 1);
        to = new Date(year, month + 1, 0);
        label = today.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        periodBudget = monthlyBudget;
        for (let day = 1; day <= to.getDate(); day += 1) {
            const date = isoDay(new Date(year, month, day));
            points.push({ label: String(day), from: date, to: date, expected: periodBudget / to.getDate() });
        }
    } else if (period === 'six') {
        from = new Date(year, month - 5, 1);
        to = new Date(year, month + 1, 0);
        label = `${shortMonth(from)} ${from.getFullYear()} – ${shortMonth(to)} ${to.getFullYear()}`;
        periodBudget = monthlyBudget * 6;
        for (let index = 0; index < 6; index += 1) {
            const first = new Date(year, month - 5 + index, 1);
            points.push({
                label: shortMonth(first),
                from: isoDay(first),
                to: isoDay(new Date(first.getFullYear(), first.getMonth() + 1, 0)),
                expected: monthlyBudget,
            });
        }
    } else {
        from = new Date(year, 0, 1);
        to = new Date(year, 11, 31);
        label = String(year);
        periodBudget = monthlyBudget * 12;
        for (let index = 0; index < 12; index += 1) {
            const start = new Date(year, index, 1);
            points.push({
                label: shortMonth(start),
                from: isoDay(start),
                to: isoDay(new Date(year, index + 1, 0)),
                expected: monthlyBudget,
            });
        }
    }

    const start = isoDay(from);
    const end = isoDay(to);
    const inPeriod = rowsFor(store.tables.transactions, profile).filter(row => {
        const day = dayText(row.spent_on);
        return day >= start && day <= end;
    });
    const sum = (rows: Row[]) => rows.reduce((total, row) => total + toNumber(row.amount), 0);

    const actual = sum(inPeriod);
    const recurring = sum(inPeriod.filter(row => isTrue(row.recurring)));
    const scale = setupMonthly > 0 ? periodBudget / setupMonthly : 0;

    return {
        period,
        range: { label, from: start, to: end },
        series: points.map(point => ({
            label: point.label,
            total: roundCents(sum(inPeriod.filter(row => {
                const day = dayText(row.spent_on);
                return day >= point.from && day <= point.to;
            }))),
            expected: roundCents(point.expected),
        })),
        categories: BUCKETS.map(({ bucket, label: bucketLabel }) => {
            const expense = expenses.find(row => row.category === bucket);
            const spent = sum(inPeriod.filter(row => row.bucket === bucket));
            const expected = expense ? perMonth(expense) * scale : 0;
            return {
                bucket,
                label: bucketLabel,
                actual: roundCents(spent),
                expected: roundCents(expected),
                difference: roundCents(spent - expected),
            };
        }),
        totals: {
            actual: roundCents(actual),
            expected: roundCents(periodBudget),
            difference: roundCents(actual - periodBudget),
            transactionCount: inPeriod.length,
            budgetSource: totals.configured ? 'big_picture' : 'monthly_setup',
            recurring: roundCents(recurring),
            oneTime: roundCents(actual - recurring),
            recurringShare: actual > 0 ? recurring / actual : 0,
        },
    };
}

/* ── Saving ── */

function readEntries(body: Row) {
    if (!Array.isArray(body.entries)) throw new RequestError(400, 'entries must be a list.');
    return body.entries as Row[];
}

function validAmount(value: unknown) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new RequestError(400, 'Amounts must be greater than zero.');
    }
    return roundCents(amount);
}

function rejectDuplicates(keys: string[]) {
    if (new Set(keys).size !== keys.length) {
        throw new RequestError(400, 'Each category can only be listed once.');
    }
}

function addTransaction(store: Store, body: Row) {
    const definition = BUCKETS.find(entry => entry.bucket === body.bucket);
    const category = String(body.category ?? '');
    const categories = definition?.detailFields.length ? definition.detailFields : [definition?.bucket];
    if (!definition || !categories.includes(category)) {
        throw new RequestError(400, 'Choose a valid category.');
    }
    const amount = validAmount(body.amount);
    if (!isRealDay(body.spent_on)) throw new RequestError(400, 'Enter a valid date.');
    if (body.note !== undefined && typeof body.note !== 'string') {
        throw new RequestError(400, 'The note must be text.');
    }
    const note = (body.note ?? '').trim();
    if (note.length > 200) throw new RequestError(400, 'Keep the note to 200 characters.');

    const profile = ensureProfile(store);
    const highest = store.tables.transactions.reduce(
        (max, row) => Math.max(max, toNumber(row.transaction_id)),
        0
    );
    store.tables.transactions.push({
        transaction_id: highest + 1,
        profile_id: profile.profile_id,
        category,
        bucket: definition.bucket,
        amount,
        spent_on: body.spent_on,
        note,
        created_at: new Date().toISOString(),
        recurring: body.recurring === true,
    });
    touch(profile);
}

function removeTransaction(store: Store, body: Row) {
    const profile = findProfile(store);
    const id = String(body.transaction_id ?? '');
    const index = store.tables.transactions.findIndex(row =>
        row.profile_id === profile?.profile_id && String(row.transaction_id) === id);
    if (!profile || !id || index === -1) throw new RequestError(404, 'That transaction no longer exists.');
    store.tables.transactions.splice(index, 1);
    touch(profile);
}

// The dashboard sends the whole list and leaves out cleared amounts, so a
// category missing from the list is deleted.
function saveMonthlySetup(store: Store, body: Row) {
    const entries = readEntries(body);
    const parsed = entries.map(entry => {
        if (!BUCKETS.some(known => known.bucket === entry.bucket)) {
            throw new RequestError(400, 'Choose a valid category.');
        }
        if (!isFrequency(entry.frequency)) throw new RequestError(400, 'Choose a valid frequency.');
        return { bucket: String(entry.bucket), amount: validAmount(entry.amount), frequency: entry.frequency };
    });
    rejectDuplicates(parsed.map(entry => entry.bucket));

    const profile = ensureProfile(store);
    const previous = rowsFor(store.tables.expenses, profile);
    const now = new Date().toISOString();
    store.tables.expenses = [
        ...store.tables.expenses.filter(row => row.profile_id !== profile.profile_id),
        ...parsed.map(entry => ({
            profile_id: profile.profile_id,
            category: entry.bucket,
            amount: entry.amount,
            frequency: entry.frequency,
            // The dashboard does not send breakdowns, so keep the saved one.
            detail: previous.find(row => row.category === entry.bucket)?.detail ?? '{}',
            updated_at: now,
        })),
    ];
    touch(profile);
}

function saveBigPicture(store: Store, body: Row) {
    const entries = readEntries(body);
    const parsed = entries.map(entry => {
        if (!BIG_PICTURE_CATEGORIES.includes(String(entry.category))) {
            throw new RequestError(400, 'Choose a valid Big Picture category.');
        }
        if (entry.frequency !== 'monthly' && entry.frequency !== 'yearly') {
            throw new RequestError(400, 'Choose a valid frequency.');
        }
        return { category: String(entry.category), amount: validAmount(entry.amount), frequency: entry.frequency };
    });
    rejectDuplicates(parsed.map(entry => entry.category));

    const profile = ensureProfile(store);
    const now = new Date().toISOString();
    store.tables.bigPicture = [
        ...store.tables.bigPicture.filter(row => row.profile_id !== profile.profile_id),
        ...parsed.map(entry => ({ profile_id: profile.profile_id, ...entry, updated_at: now })),
    ];
    touch(profile);
}

const SAVES: Record<string, (store: Store, body: Row) => void> = {
    '/api/prototype/transactions': addTransaction,
    '/api/prototype/transactions/remove': removeTransaction,
    '/api/prototype/monthly-setup': saveMonthlySetup,
    '/api/prototype/big-picture': saveBigPicture,
};

/* ── HTTP ── */

async function readBody(req: IncomingMessage & { body?: unknown }): Promise<Row> {
    // Express has already read the body if express.json() ran first.
    if (req.body && typeof req.body === 'object') return req.body as Row;

    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) throw new RequestError(413, 'That request is too large.');
        chunks.push(chunk as Buffer);
    }
    try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Row;
    } catch {
        // Falls through to the error below.
    }
    throw new RequestError(400, 'The request must be a JSON object.');
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
}

/** Handles /api/prototype/* and returns false for any other URL. */
export async function handlePrototypeRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/prototype/')) return false;

    try {
        if (req.method === 'GET' && url.pathname === '/api/prototype/profile') {
            sendJson(res, 200, await inOrder(async () => profilePayload(await load())));
        } else if (req.method === 'GET' && url.pathname === '/api/prototype/stats') {
            const period = url.searchParams.get('period');
            sendJson(res, 200, await inOrder(async () => statsPayload(await load(), period)));
        } else if (req.method === 'POST' && SAVES[url.pathname]) {
            const body = await readBody(req);
            const change = SAVES[url.pathname];
            const payload = await inOrder(async () => {
                const store = await load();
                change(store, body);
                await save(store);
                return profilePayload(store);
            });
            sendJson(res, 200, payload);
        } else {
            sendJson(res, 404, { error: 'Not found.' });
        }
    } catch (error) {
        if (error instanceof RequestError) {
            sendJson(res, error.status, { error: error.message });
        } else {
            console.error('Prototype workbook error:', error);
            sendJson(res, 500, { error: 'The prototype data could not be read or saved.' });
        }
    }
    return true;
}