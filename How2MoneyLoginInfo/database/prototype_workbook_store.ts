// xlsx storage for the prototype dashboard — demo mode only.
//
// Normal traffic goes to MongoDB. This store is the fallback the router picks
// when Mongo cannot be reached, so the dashboard keeps working on a local
// workbook. It is also what the import script reads when seeding Mongo.
//
// Saves run one at a time and go through a temporary file, so two quick clicks
// cannot overwrite each other and a crash cannot leave half a workbook.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {
    BIG_PICTURE_CATEGORIES,
    BUCKETS,
    PrototypeRequestError,
    asFrequency,
    dayText,
    isFrequency,
    isRealDay,
    isTrue,
    profilePayload,
    roundCents,
    statsPayload,
    toNumber,
    type BigPictureEntry,
    type BigPictureRow,
    type ExpenseRow,
    type MonthlySetupEntry,
    type NewTransaction,
    type ProfileData,
    type TransactionRow,
} from './prototype_model';

type Row = Record<string, unknown>;
type Store = { workbook: ExcelJS.Workbook; tables: Record<TableName, Row[]> };

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
const PROFILE_KEY = 'prototype';
const PROFILE_NAME = 'Prototype profile';

// Walk up from this file until we find expense_weight.json. The default
// workbook lives at the repo root no matter which folder the server started in.
function findRepoRoot(): string {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(dir, 'expense_weight.json'))) return dir;
        dir = path.dirname(dir);
    }
    return path.resolve(__dirname, '..', '..');
}

export function demoWorkbookPath(): string {
    const configured = process.env.PROTOTYPE_STORAGE_FILE?.trim();
    if (configured) return path.resolve(configured);
    return path.join(findRepoRoot(), 'prototype_data_storage.xlsx');
}

const usingDefaultWorkbook = () => !process.env.PROTOTYPE_STORAGE_FILE?.trim();

function sampleWorkbookPath(): string {
    return path.join(findRepoRoot(), 'sample_data', 'prototype_six_months.xlsx');
}

export function demoSeedWorkbookPath(): string {
    return sampleWorkbookPath();
}

/* ── Workbook access ── */

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

function readTables(workbook: ExcelJS.Workbook): Record<TableName, Row[]> {
    const tables = {} as Record<TableName, Row[]>;
    for (const table of TABLE_NAMES) tables[table] = readTable(workbook, table);

    // Older workbooks grouped every insurance payment under one "insurance"
    // row. The planner now splits it four ways, so the legacy row becomes the
    // "other" bucket. Persisted on the next save.
    for (const row of tables.bigPicture) {
        if (row.category === 'insurance') row.category = 'insurance_other';
    }

    return tables;
}

async function readWorkbook(file: string): Promise<Store> {
    const workbook = new ExcelJS.Workbook();
    const exists = await fs.promises.access(file).then(() => true, () => false);
    if (exists) await workbook.xlsx.readFile(file);
    return { workbook, tables: readTables(workbook) };
}

export async function readProfileFromWorkbook(file: string, profileKey = PROFILE_KEY) {
    const store = await readWorkbook(file);
    const profile = findProfile(store, profileKey, false);
    return {
        data: profileData(store, profile),
        profileId: profile ? String(profile.profile_id ?? '') : '',
        displayName: profile ? String(profile.display_name ?? '') : '',
    };
}

let seeded = false;
// The checked-in sample makes demo mode useful on a fresh clone. Only the
// default workbook is seeded; an explicit PROTOTYPE_STORAGE_FILE is respected
// as-is.
async function seedDefaultWorkbook(): Promise<void> {
    if (seeded) return;
    seeded = true;
    if (!usingDefaultWorkbook()) return;

    const file = demoWorkbookPath();
    const sample = sampleWorkbookPath();
    if (!fs.existsSync(sample)) return;

    if (fs.existsSync(file)) {
        try {
            const existing = await readWorkbook(file);
            const hasData = TABLE_NAMES.some(table =>
                table !== 'profiles' && existing.tables[table].length > 0);
            if (hasData) return;
        } catch (err) {
            console.error('Could not inspect the default prototype workbook before seeding:', err);
            return;
        }
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(sample, file);
    console.log(`Seeded demo workbook from ${sample}`);
}

async function load(): Promise<Store> {
    await seedDefaultWorkbook();
    return readWorkbook(demoWorkbookPath());
}

async function save({ workbook, tables }: Store): Promise<void> {
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

    const file = demoWorkbookPath();
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    try {
        await workbook.xlsx.writeFile(temporary);
        await fs.promises.rename(temporary, file);
    } catch (error) {
        await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
        if (['EBUSY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            throw new PrototypeRequestError(
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

/* ── Row helpers ── */

function findProfile(store: Store, profileKey = PROFILE_KEY, fallback = true) {
    return store.tables.profiles.find(row => String(row.profile_key ?? '') === profileKey)
        ?? (fallback ? store.tables.profiles[0] : undefined);
}

const sameId = (a: unknown, b: unknown) => String(a ?? '') === String(b ?? '');

const rowsFor = (rows: Row[], profile: Row | undefined) =>
    profile ? rows.filter(row => sameId(row.profile_id, profile.profile_id)) : [];

function parseDetail(value: unknown) {
    if (value && typeof value === 'object') return value as Row;
    try {
        return JSON.parse(String(value || '{}')) as Row;
    } catch {
        return {};
    }
}

function profileData(store: Store, profile: Row | undefined): ProfileData {
    if (!profile) return { profile: null, expenses: [], transactions: [], bigPicture: [] };

    const expenses: ExpenseRow[] = rowsFor(store.tables.expenses, profile).map(row => ({
        category: String(row.category ?? ''),
        amount: toNumber(row.amount),
        frequency: asFrequency(row.frequency),
        detail: parseDetail(row.detail),
        updated_at: (row.updated_at as string | Date | null | undefined) ?? null,
    }));

    const bigPicture: BigPictureRow[] = rowsFor(store.tables.bigPicture, profile).map(row => ({
        category: String(row.category ?? ''),
        amount: toNumber(row.amount),
        frequency: asFrequency(row.frequency),
        updated_at: (row.updated_at as string | Date | null | undefined) ?? null,
    }));

    const transactions: TransactionRow[] = rowsFor(store.tables.transactions, profile).map(row => ({
        transaction_id: String(row.transaction_id ?? ''),
        category: String(row.category ?? ''),
        bucket: String(row.bucket ?? ''),
        amount: toNumber(row.amount),
        spent_on: dayText(row.spent_on),
        note: row.note ? String(row.note) : '',
        recurring: isTrue(row.recurring),
        created_at: (row.created_at as string | Date | null | undefined) ?? null,
    }));

    return {
        profile: {
            profile_key: String(profile.profile_key ?? PROFILE_KEY),
            display_name: String(profile.display_name ?? ''),
            updated_at: (profile.updated_at as string | Date | null | undefined) ?? null,
        },
        expenses,
        transactions,
        bigPicture,
    };
}

/* ── Reads ── */

export async function getProfilePayload() {
    return inOrder(async () => {
        const store = await load();
        return profilePayload(profileData(store, findProfile(store)));
    });
}

export async function getStatsPayload(period: string | null) {
    return inOrder(async () => {
        const store = await load();
        return statsPayload(profileData(store, findProfile(store)), period);
    });
}

/* ── Saves ── */

function touch(profile: Row) {
    profile.updated_at = new Date().toISOString();
}

function ensureProfile(store: Store): Row {
    const existing = findProfile(store);
    if (existing) return existing;

    const highest = store.tables.profiles.reduce(
        (max, row) => Math.max(max, toNumber(row.profile_id)),
        0
    );
    const now = new Date().toISOString();
    const profile: Row = {
        profile_id: String(highest + 1),
        profile_key: PROFILE_KEY,
        display_name: PROFILE_NAME,
        userid: '',
        created_at: now,
        updated_at: now,
    };
    store.tables.profiles.push(profile);
    return profile;
}

function validAmount(value: unknown) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new PrototypeRequestError(400, 'Amounts must be greater than zero.');
    }
    return roundCents(amount);
}

function rejectDuplicates(keys: string[]) {
    if (new Set(keys).size !== keys.length) {
        throw new PrototypeRequestError(400, 'Each category can only be listed once.');
    }
}

export async function addTransaction(input: NewTransaction): Promise<void> {
    return inOrder(async () => {
        const store = await load();
        const definition = BUCKETS.find(entry => entry.bucket === input.bucket);
        if (!definition) throw new PrototypeRequestError(400, 'Choose a valid category.');
        const categories = definition.detailFields.length ? definition.detailFields : [definition.bucket];
        if (!categories.includes(input.category)) {
            throw new PrototypeRequestError(400, 'Choose a valid category.');
        }
        const amount = validAmount(input.amount);
        if (!isRealDay(input.spentOn)) throw new PrototypeRequestError(400, 'Enter a valid date.');
        if (input.note.length > 200) {
            throw new PrototypeRequestError(400, 'Keep the note to 200 characters.');
        }

        const profile = ensureProfile(store);
        const highest = store.tables.transactions.reduce(
            (max, row) => Math.max(max, toNumber(row.transaction_id)),
            0
        );
        store.tables.transactions.push({
            transaction_id: highest + 1,
            profile_id: profile.profile_id,
            category: input.category,
            bucket: definition.bucket,
            amount,
            spent_on: input.spentOn,
            note: input.note,
            created_at: new Date().toISOString(),
            recurring: input.recurring,
        });
        touch(profile);
        await save(store);
    });
}

export async function removeTransaction(transactionId: string): Promise<boolean> {
    return inOrder(async () => {
        const store = await load();
        const profile = findProfile(store);
        const id = String(transactionId);
        const index = store.tables.transactions.findIndex(row =>
            sameId(row.profile_id, profile?.profile_id) && sameId(row.transaction_id, id));
        if (!profile || !id || index === -1) return false;

        store.tables.transactions.splice(index, 1);
        touch(profile);
        await save(store);
        return true;
    });
}

// The dashboard sends the whole list and leaves out cleared amounts, so a
// category missing from the list is deleted.
export async function saveMonthlySetup(entries: MonthlySetupEntry[]): Promise<void> {
    return inOrder(async () => {
        const parsed = entries.map(entry => {
            if (!BUCKETS.some(known => known.bucket === entry.bucket)) {
                throw new PrototypeRequestError(400, 'Choose a valid category.');
            }
            if (!isFrequency(entry.frequency)) {
                throw new PrototypeRequestError(400, 'Choose a valid frequency.');
            }
            return { ...entry, amount: validAmount(entry.amount) };
        });
        rejectDuplicates(parsed.map(entry => entry.bucket));

        const store = await load();
        const profile = ensureProfile(store);
        const previous = rowsFor(store.tables.expenses, profile);
        const now = new Date().toISOString();

        store.tables.expenses = [
            ...store.tables.expenses.filter(row => !sameId(row.profile_id, profile.profile_id)),
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
        await save(store);
    });
}

export async function saveBigPicture(entries: BigPictureEntry[]): Promise<void> {
    return inOrder(async () => {
        const parsed = entries.map(entry => {
            if (!(BIG_PICTURE_CATEGORIES as readonly string[]).includes(entry.category)) {
                throw new PrototypeRequestError(400, 'Choose a valid Big Picture category.');
            }
            return { ...entry, amount: validAmount(entry.amount) };
        });
        rejectDuplicates(parsed.map(entry => entry.category));

        const store = await load();
        const profile = ensureProfile(store);
        const now = new Date().toISOString();

        store.tables.bigPicture = [
            ...store.tables.bigPicture.filter(row => !sameId(row.profile_id, profile.profile_id)),
            ...parsed.map(entry => ({
                profile_id: profile.profile_id,
                category: entry.category,
                amount: entry.amount,
                frequency: entry.frequency,
                updated_at: now,
            })),
        ];
        touch(profile);
        await save(store);
    });
}
