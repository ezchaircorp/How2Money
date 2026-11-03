// Excel-backed storage for the no-login prototype dashboard.
//
// The authenticated parts of the app still use Postgres, but the shared
// prototype profile lives in a local workbook so quick tests do not need a
// database. The workbook has four sheets that mirror the DB tables:
//
//   profiles             one row for the shared `prototype` profile
//   profile_expenses     the expected monthly setup, one row per bucket
//   profile_transactions individual purchases
//   profile_big_picture  income, fixed payments, and savings goals
//
// Every operation is serialized in this process so two saves cannot write the
// same workbook at once. Writes go to a temp file first, then replace the real
// file so a crash mid-save does not leave a corrupt workbook behind.

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { Workbook } from 'exceljs';
import type { Cell, Row, Worksheet } from 'exceljs';

export const PROTOTYPE_PROFILE_KEY = 'prototype';
export const PROTOTYPE_PROFILE_NAME = 'Prototype profile';

const SHEETS = {
    profiles: ['profile_id', 'profile_key', 'display_name', 'userid', 'created_at', 'updated_at'],
    profile_expenses: [
        'profile_id',
        'category',
        'amount',
        'frequency',
        'detail',
        'updated_at',
    ],
    profile_transactions: [
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
    profile_big_picture: [
        'profile_id',
        'category',
        'amount',
        'frequency',
        'updated_at',
    ],
} as const;

export const BIG_PICTURE_CATEGORIES = [
    'income',
    'debt_payment',
    'schooling',
    'insurance',
    'savings',
] as const;

export type BigPictureCategory = (typeof BIG_PICTURE_CATEGORIES)[number];

type SheetName = keyof typeof SHEETS;

export type StoredProfile = {
    profile_id: string;
    profile_key: string;
    display_name: string;
    userid: number | null;
    created_at: Date;
    updated_at: Date;
};

export type StoredProfileExpense = {
    category: string;
    amount: string;
    monthly_amount: string;
    frequency: string;
    detail: Record<string, unknown>;
    updated_at: Date;
};

export type ProfileExpenseInput = {
    bucket: string;
    amount: number;
    frequency: string;
    detail: Record<string, unknown>;
};

export type MonthlySetupInput = {
    bucket: string;
    amount: number;
    frequency: string;
};

export type StoredBigPictureEntry = {
    category: string;
    amount: string;
    monthly_amount: string;
    frequency: string;
    updated_at: Date;
};

export type BigPictureInput = {
    category: string;
    amount: number;
    frequency: string;
};

export type ProfileMonthlyActual = {
    bucket: string;
    actual: string;
    transaction_count: number;
};

export type StoredProfileTransaction = {
    transaction_id: string;
    category: string;
    bucket: string;
    amount: string;
    spent_on: string;
    note: string;
    recurring: boolean;
    created_at: Date;
};

export type ProfileTransactionInput = {
    category: string;
    bucket: string;
    amount: number;
    spentOn: string;
    note: string;
    recurring: boolean;
};

// Walk up from this file until we find expense_weight.json, the same way
// expense_categories.ts does. That keeps the workbook at the repo root whether
// the app is run from the repo or from a copied image.
function findRepoRoot(): string {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(dir, 'expense_weight.json'))) return dir;
        dir = path.dirname(dir);
    }
    return path.resolve(__dirname, '..', '..');
}

function resolveStorageFile(): string {
    const configured = process.env.PROTOTYPE_STORAGE_FILE;
    if (configured && configured.trim()) return path.resolve(configured.trim());
    return path.join(findRepoRoot(), 'prototype_data_storage.xlsx');
}

export const PROTOTYPE_STORAGE_FILE = resolveStorageFile();

// Only the default workbook gets the sample-data seed. An explicit
// PROTOTYPE_STORAGE_FILE is usually a test file or a sample fixture, and
// silently filling it would make "empty workbook" tests impossible.
const USING_DEFAULT_STORAGE = !process.env.PROTOTYPE_STORAGE_FILE?.trim();

export function prototypeStorePath(): string {
    return PROTOTYPE_STORAGE_FILE;
}

// A tiny promise queue. Reads and writes both go through it, so a list call
// never sees a workbook that is halfway through being saved.
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.then(
        () => undefined,
        () => undefined
    );
    return run;
}

function isBlank(value: unknown): boolean {
    return value === null || value === undefined || value === '';
}

function cellText(cell: Cell): string {
    const value = cell.value;
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();

    if (typeof value === 'object') {
        if ('text' in value && typeof value.text === 'string') return value.text;
        if ('result' in value && value.result !== undefined) return String(value.result);
        if ('richText' in value && Array.isArray(value.richText)) {
            return value.richText
                .map(part => (typeof part.text === 'string' ? part.text : ''))
                .join('');
        }
        return JSON.stringify(value);
    }

    return String(value);
}

function cellNumber(cell: Cell): number {
    const value = cell.value;
    const number = typeof value === 'number' ? value : Number(cellText(cell));
    return Number.isFinite(number) ? number : 0;
}

function cellDate(cell: Cell, fallback: Date): Date {
    const value = cell.value;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    const parsed = new Date(cellText(cell));
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

// Spreadsheet editors like to turn "2026-11-03" into a real date cell. The
// monthly totals compare spent_on as plain YYYY-MM-DD strings, so normalise a
// real date back to that shape instead of leaving the full ISO timestamp.
function cellDay(cell: Cell): string {
    const value = cell.value;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return isoDate(value);

    const text = cellText(cell);
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
    return match?.[1] ?? text;
}

function cellBoolean(cell: Cell): boolean {
    const value = cell.value;
    if (typeof value === 'boolean') return value;
    const text = cellText(cell).trim().toLowerCase();
    return text === 'true' || text === 'yes' || text === '1';
}

function cellDetail(cell: Cell): Record<string, unknown> {
    const text = cellText(cell);
    if (!text) return {};

    try {
        const parsed = JSON.parse(text) as unknown;
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function now(): Date {
    return new Date();
}

function isoDate(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
        date.getDate()
    ).padStart(2, '0')}`;
}

function monthStart(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`;
}

function nextMonthStart(date: Date): string {
    return isoDate(new Date(date.getFullYear(), date.getMonth() + 1, 1));
}

function monthlyAmount(amount: number, frequency: string): number {
    const multiplier = frequency === 'yearly' ? 1 / 12 : frequency === 'weekly' ? 52 / 12 : 1;
    return amount * multiplier;
}

function money(value: number): string {
    return value.toFixed(2);
}

function sheetFor(workbook: Workbook, name: SheetName): { sheet: Worksheet; changed: boolean } {
    let sheet = workbook.getWorksheet(name);
    let changed = false;

    if (!sheet) {
        sheet = workbook.addWorksheet(name);
        changed = true;
    }

    for (let index = 0; index < SHEETS[name].length; index++) {
        const header = SHEETS[name][index];
        if (!header) continue;
        const cell = sheet.getCell(1, index + 1);
        if (cellText(cell) !== header) {
            cell.value = header;
            changed = true;
        }
    }

    if (changed) {
        sheet.getRow(1).font = { bold: true };
        sheet.views = [{ state: 'frozen', ySplit: 1 }];
    }

    return { sheet, changed };
}

async function loadWorkbook(): Promise<{ workbook: Workbook; changed: boolean }> {
    const workbook = new Workbook();
    let changed = false;

    if (fs.existsSync(PROTOTYPE_STORAGE_FILE)) {
        await workbook.xlsx.readFile(PROTOTYPE_STORAGE_FILE);
    } else {
        changed = true;
    }

    for (const name of Object.keys(SHEETS) as SheetName[]) {
        const result = sheetFor(workbook, name);
        changed = changed || result.changed;
    }

    return { workbook, changed };
}

async function saveWorkbook(workbook: Workbook): Promise<void> {
    fs.mkdirSync(path.dirname(PROTOTYPE_STORAGE_FILE), { recursive: true });
    const temp = `${PROTOTYPE_STORAGE_FILE}.${process.pid}.${Date.now()}.tmp`;
    try {
        await workbook.xlsx.writeFile(temp);
        fs.renameSync(temp, PROTOTYPE_STORAGE_FILE);
    } finally {
        if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
    }
}

function dataRows(sheet: Worksheet): Array<{ row: Row; rowNumber: number }> {
    const rows: Array<{ row: Row; rowNumber: number }> = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber > 1) rows.push({ row, rowNumber });
    });
    return rows;
}

function readProfiles(workbook: Workbook): StoredProfile[] {
    const sheet = workbook.getWorksheet('profiles');
    if (!sheet) return [];

    return dataRows(sheet).map(({ row }) => ({
        profile_id: cellText(row.getCell(1)),
        profile_key: cellText(row.getCell(2)),
        display_name: cellText(row.getCell(3)),
        userid: isBlank(row.getCell(4).value) ? null : cellNumber(row.getCell(4)),
        created_at: cellDate(row.getCell(5), new Date(0)),
        updated_at: cellDate(row.getCell(6), new Date(0)),
    }));
}

function readExpenses(workbook: Workbook, profileId: string): StoredProfileExpense[] {
    const sheet = workbook.getWorksheet('profile_expenses');
    if (!sheet) return [];

    return dataRows(sheet)
        .filter(({ row }) => cellText(row.getCell(1)) === profileId)
        .map(({ row }) => {
            const amount = cellNumber(row.getCell(3));
            const frequency = cellText(row.getCell(4)) || 'monthly';
            return {
                category: cellText(row.getCell(2)),
                amount: money(amount),
                monthly_amount: money(monthlyAmount(amount, frequency)),
                frequency,
                detail: cellDetail(row.getCell(5)),
                updated_at: cellDate(row.getCell(6), new Date(0)),
            };
        })
        .sort((a, b) => a.category.localeCompare(b.category));
}

function readBigPicture(workbook: Workbook, profileId: string): StoredBigPictureEntry[] {
    const sheet = workbook.getWorksheet('profile_big_picture');
    if (!sheet) return [];

    return dataRows(sheet)
        .filter(({ row }) => cellText(row.getCell(1)) === profileId)
        .map(({ row }) => {
            const amount = cellNumber(row.getCell(3));
            const frequency = cellText(row.getCell(4)) || 'monthly';
            return {
                category: cellText(row.getCell(2)),
                amount: money(amount),
                monthly_amount: money(monthlyAmount(amount, frequency)),
                frequency,
                updated_at: cellDate(row.getCell(5), new Date(0)),
            };
        })
        .sort((a, b) => a.category.localeCompare(b.category));
}

function readTransactions(workbook: Workbook, profileId: string, limit = Number.POSITIVE_INFINITY): StoredProfileTransaction[] {
    const sheet = workbook.getWorksheet('profile_transactions');
    if (!sheet) return [];

    return dataRows(sheet)
        .filter(({ row }) => cellText(row.getCell(2)) === profileId)
        .map(({ row }) => ({
            transaction_id: cellText(row.getCell(1)),
            category: cellText(row.getCell(3)),
            bucket: cellText(row.getCell(4)),
            amount: money(cellNumber(row.getCell(5))),
            spent_on: cellDay(row.getCell(6)),
            note: cellText(row.getCell(7)),
            recurring: cellBoolean(row.getCell(9)),
            created_at: cellDate(row.getCell(8), new Date(0)),
        }))
        .sort((a, b) => {
            const dateCompare = b.spent_on.localeCompare(a.spent_on);
            if (dateCompare !== 0) return dateCompare;
            return Number(b.transaction_id) - Number(a.transaction_id);
        })
        .slice(0, limit);
}

function newProfile(): StoredProfile {
    const timestamp = now();
    return {
        profile_id: randomUUID(),
        profile_key: PROTOTYPE_PROFILE_KEY,
        display_name: PROTOTYPE_PROFILE_NAME,
        userid: null,
        created_at: timestamp,
        updated_at: timestamp,
    };
}

function findProfile(workbook: Workbook): StoredProfile | null {
    return readProfiles(workbook).find(p => p.profile_key === PROTOTYPE_PROFILE_KEY) ?? null;
}

function addProfileRow(workbook: Workbook, profile: StoredProfile): void {
    const sheet = workbook.getWorksheet('profiles');
    if (!sheet) throw new Error('The profiles sheet is missing.');
    sheet.addRow([
        profile.profile_id,
        profile.profile_key,
        profile.display_name,
        profile.userid ?? '',
        profile.created_at.toISOString(),
        profile.updated_at.toISOString(),
    ]);
}

function touchProfile(workbook: Workbook, profileId: string): void {
    const sheet = workbook.getWorksheet('profiles');
    if (!sheet) return;

    for (const { row } of dataRows(sheet)) {
        if (cellText(row.getCell(1)) !== profileId) continue;
        row.getCell(6).value = now().toISOString();
        return;
    }
}

function ensureProfile(workbook: Workbook): { profile: StoredProfile; created: boolean } {
    const existing = findProfile(workbook);
    if (existing) return { profile: existing, created: false };

    const profile = newProfile();
    addProfileRow(workbook, profile);
    return { profile, created: true };
}

function nextTransactionId(workbook: Workbook): number {
    const sheet = workbook.getWorksheet('profile_transactions');
    if (!sheet) return 1;

    let highest = 0;
    for (const { row } of dataRows(sheet)) {
        const id = cellNumber(row.getCell(1));
        if (id > highest) highest = id;
    }
    return highest + 1;
}

function sampleWorkbookPath(): string {
    return path.join(findRepoRoot(), 'sample_data', 'prototype_six_months.xlsx');
}

function workbookHasData(workbook: Workbook): boolean {
    for (const name of ['profile_expenses', 'profile_transactions', 'profile_big_picture'] as const) {
        const sheet = workbook.getWorksheet(name);
        if (sheet && dataRows(sheet).length > 0) return true;
    }
    return false;
}

// The checked-in sample workbook makes the dashboard useful on a fresh clone.
// Only copy it when the default workbook is missing or has no budget rows, so
// an existing local profile is never overwritten.
async function seedDefaultWorkbookFromSample(): Promise<boolean> {
    if (!USING_DEFAULT_STORAGE) return false;
    const sample = sampleWorkbookPath();
    if (!fs.existsSync(sample)) return false;

    if (fs.existsSync(PROTOTYPE_STORAGE_FILE)) {
        const existing = new Workbook();
        try {
            await existing.xlsx.readFile(PROTOTYPE_STORAGE_FILE);
        } catch (err) {
            console.error('Could not inspect the default prototype workbook before seeding:', err);
            return false;
        }
        if (workbookHasData(existing)) return false;
    }

    fs.mkdirSync(path.dirname(PROTOTYPE_STORAGE_FILE), { recursive: true });
    fs.copyFileSync(sample, PROTOTYPE_STORAGE_FILE);
    return true;
}

// Create the workbook and its header rows if they do not exist yet. Called on
// server start so the file is ready for a quick test without waiting for the
// first API request.
export async function initPrototypeStore(): Promise<string> {
    return serial(async () => {
        const seeded = await seedDefaultWorkbookFromSample();
        if (seeded) {
            console.log(`Seeded default prototype workbook from ${sampleWorkbookPath()}`);
        }

        const { workbook, changed } = await loadWorkbook();
        if (changed) await saveWorkbook(workbook);
        return PROTOTYPE_STORAGE_FILE;
    });
}

export async function ensurePrototypeProfile(): Promise<StoredProfile> {
    return serial(async () => {
        const { workbook } = await loadWorkbook();
        const { profile, created } = ensureProfile(workbook);
        if (created) await saveWorkbook(workbook);
        return profile;
    });
}

export async function listProfileExpenses(profileId: string): Promise<StoredProfileExpense[]> {
    return serial(async () => {
        const { workbook } = await loadWorkbook();
        return readExpenses(workbook, profileId);
    });
}

export async function listBigPicture(profileId: string): Promise<StoredBigPictureEntry[]> {
    return serial(async () => {
        const { workbook } = await loadWorkbook();
        return readBigPicture(workbook, profileId);
    });
}

export async function upsertProfileExpense(
    profileId: string,
    expense: ProfileExpenseInput
): Promise<void> {
    return serial(async () => {
        const { workbook } = await loadWorkbook();
        const profile = findProfile(workbook);
        if (!profile) {
            const created = ensureProfile(workbook);
            profileId = created.profile.profile_id;
        }

        const sheet = workbook.getWorksheet('profile_expenses');
        if (!sheet) throw new Error('The profile_expenses sheet is missing.');

        const existing = dataRows(sheet).find(
            ({ row }) => cellText(row.getCell(1)) === profileId && cellText(row.getCell(2)) === expense.bucket
        );

        const timestamp = now().toISOString();
        if (existing) {
            existing.row.getCell(3).value = expense.amount;
            existing.row.getCell(4).value = expense.frequency;
            existing.row.getCell(5).value = JSON.stringify(expense.detail);
            existing.row.getCell(6).value = timestamp;
        } else {
            sheet.addRow([
                profileId,
                expense.bucket,
                expense.amount,
                expense.frequency,
                JSON.stringify(expense.detail),
                timestamp,
            ]);
        }

        touchProfile(workbook, profileId);
        await saveWorkbook(workbook);
    });
}

export async function removeProfileExpense(profileId: string, bucket: string): Promise<boolean> {
    return serial(async () => {
        const { workbook } = await loadWorkbook();
        const sheet = workbook.getWorksheet('profile_expenses');
        if (!sheet) return false;

        const existing = dataRows(sheet).find(
            ({ row }) => cellText(row.getCell(1)) === profileId && cellText(row.getCell(2)) === bucket
        );
        if (!existing) return false;

        sheet.spliceRows(existing.rowNumber, 1);
        touchProfile(workbook, profileId);
        await saveWorkbook(workbook);
        return true;
    });
}

// Replaces the whole expected setup. Buckets missing from the payload are
// removed; existing breakdown detail is kept for buckets that stay.
export async function replaceMonthlySetup(
    profileId: string,
    entries: MonthlySetupInput[]
): Promise<void> {
    return serial(async () => {
        const { workbook } = await loadWorkbook();
        const profile = findProfile(workbook);
        if (!profile) {
            const created = ensureProfile(workbook);
            profileId = created.profile.profile_id;
        }

        const sheet = workbook.getWorksheet('profile_expenses');
        if (!sheet) throw new Error('The profile_expenses sheet is missing.');

        const existingDetail = new Map(
            readExpenses(workbook, profileId).map(expense => [
                expense.category,
                JSON.stringify(expense.detail),
            ])
        );

        const keep = new Set(entries.map(entry => entry.bucket));
        const rowsToRemove = dataRows(sheet)
            .filter(
                ({ row }) =>
                    cellText(row.getCell(1)) === profileId && !keep.has(cellText(row.getCell(2)))
            )
            .map(({ rowNumber }) => rowNumber)
            .sort((a, b) => b - a);

        for (const rowNumber of rowsToRemove) sheet.spliceRows(rowNumber, 1);

        const timestamp = now().toISOString();
        for (const entry of entries) {
            const row = dataRows(sheet).find(
                ({ row: candidate }) =>
                    cellText(candidate.getCell(1)) === profileId &&
                    cellText(candidate.getCell(2)) === entry.bucket
            );

            if (row) {
                row.row.getCell(3).value = entry.amount;
                row.row.getCell(4).value = entry.frequency;
                row.row.getCell(6).value = timestamp;
            } else {
                sheet.addRow([
                    profileId,
                    entry.bucket,
                    entry.amount,
                    entry.frequency,
                    existingDetail.get(entry.bucket) ?? '{}',
                    timestamp,
                ]);
            }
        }

        touchProfile(workbook, profileId);
        await saveWorkbook(workbook);
    });
}

// The Big Picture planner replaces all five rows in one save. Clearing an
// input removes that row, which is what makes the budget fall back to the
// monthly setup when nothing is configured.
export async function replaceBigPicture(
    profileId: string,
    entries: BigPictureInput[]
): Promise<void> {
    return serial(async () => {
        const { workbook } = await loadWorkbook();
        const profile = findProfile(workbook);
        if (!profile) {
            const created = ensureProfile(workbook);
            profileId = created.profile.profile_id;
        }

        const sheet = workbook.getWorksheet('profile_big_picture');
        if (!sheet) throw new Error('The profile_big_picture sheet is missing.');

        const keep = new Set(entries.map(entry => entry.category));
        const rowsToRemove = dataRows(sheet)
            .filter(
                ({ row }) =>
                    cellText(row.getCell(1)) === profileId && !keep.has(cellText(row.getCell(2)))
            )
            .map(({ rowNumber }) => rowNumber)
            .sort((a, b) => b - a);

        for (const rowNumber of rowsToRemove) sheet.spliceRows(rowNumber, 1);

        const timestamp = now().toISOString();
        for (const entry of entries) {
            const row = dataRows(sheet).find(
                ({ row: candidate }) =>
                    cellText(candidate.getCell(1)) === profileId &&
                    cellText(candidate.getCell(2)) === entry.category
            );

            if (row) {
                row.row.getCell(3).value = entry.amount;
                row.row.getCell(4).value = entry.frequency;
                row.row.getCell(5).value = timestamp;
            } else {
                sheet.addRow([
                    profileId,
                    entry.category,
                    entry.amount,
                    entry.frequency,
                    timestamp,
                ]);
            }
        }

        touchProfile(workbook, profileId);
        await saveWorkbook(workbook);
    });
}

export async function listMonthlyActuals(profileId: string): Promise<ProfileMonthlyActual[]> {
    return serial(async () => {
        const { workbook } = await loadWorkbook();
        const today = now();
        const start = monthStart(today);
        const end = nextMonthStart(today);
        const totals = new Map<string, { actual: number; count: number }>();

        for (const transaction of readTransactions(workbook, profileId)) {
            if (transaction.spent_on < start || transaction.spent_on >= end) continue;
            const current = totals.get(transaction.bucket) ?? { actual: 0, count: 0 };
            current.actual += Number(transaction.amount);
            current.count += 1;
            totals.set(transaction.bucket, current);
        }

        return Array.from(totals.entries()).map(([bucket, total]) => ({
            bucket,
            actual: money(total.actual),
            transaction_count: total.count,
        }));
    });
}

export async function listProfileTransactions(
    profileId: string,
    limit = 100
): Promise<StoredProfileTransaction[]> {
    return serial(async () => {
        const { workbook } = await loadWorkbook();
        return readTransactions(workbook, profileId, limit);
    });
}

// Stats need the whole history, not just the recent list the dashboard shows.
export async function listAllProfileTransactions(
    profileId: string
): Promise<StoredProfileTransaction[]> {
    return serial(async () => {
        const { workbook } = await loadWorkbook();
        return readTransactions(workbook, profileId);
    });
}

export async function addProfileTransaction(
    profileId: string,
    transaction: ProfileTransactionInput
): Promise<void> {
    return serial(async () => {
        const { workbook } = await loadWorkbook();
        const profile = findProfile(workbook);
        if (!profile) {
            const created = ensureProfile(workbook);
            profileId = created.profile.profile_id;
        }

        const sheet = workbook.getWorksheet('profile_transactions');
        if (!sheet) throw new Error('The profile_transactions sheet is missing.');

        sheet.addRow([
            nextTransactionId(workbook),
            profileId,
            transaction.category,
            transaction.bucket,
            transaction.amount,
            transaction.spentOn,
            transaction.note,
            now().toISOString(),
            transaction.recurring,
        ]);

        touchProfile(workbook, profileId);
        await saveWorkbook(workbook);
    });
}

export async function removeProfileTransaction(
    profileId: string,
    transactionId: string
): Promise<boolean> {
    return serial(async () => {
        const { workbook } = await loadWorkbook();
        const sheet = workbook.getWorksheet('profile_transactions');
        if (!sheet) return false;

        const existing = dataRows(sheet).find(
            ({ row }) =>
                cellText(row.getCell(2)) === profileId &&
                cellText(row.getCell(1)) === transactionId
        );
        if (!existing) return false;

        sheet.spliceRows(existing.rowNumber, 1);
        touchProfile(workbook, profileId);
        await saveWorkbook(workbook);
        return true;
    });
}
