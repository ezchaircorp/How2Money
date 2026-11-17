// MongoDB store for user data.
//
// Scope (as decided with the owner):
//   - The single demo account (username 'demo', linked to the workbook's
//     'prototype' profile) lives in Mongo. Anything changed on the dashboard
//     is synced back into Mongo so it shows up in the database.
//   - Spend entries are Mongo-only now — the /api/spend routes read and write
//     here instead of Postgres. Auth itself (sessions, users) stays in
//     Postgres; spend rows are still keyed by the signed-in user's userid.
//
// The workbook stays the read source for the prototype dashboard (payloads,
// stats, advice). Mongo failures are logged and swallowed: the dashboard keeps
// working off the workbook, and a failed spend save still answers 200 with a
// warning rather than an error page.

import { getDb } from './db_mongo';
import type { ObjectId } from 'mongodb';
import type { Period, PeriodWindow, SpendEntryInput, StoredSpendEntry } from './db_spend';
import {
    ensurePrototypeProfile,
    listAllProfileTransactions,
    listBigPicture,
    listProfileExpenses,
} from './prototype_store';
import { nextPeriodWindow } from './db_spend';

/* ─────────────────────────────────────────────────
   Document shapes
───────────────────────────────────────────────── */

export interface MongoUserDoc {
    username: string;
    username_lower: string;
    email: string;
    email_lower: string;
    name: string;
    created_at: Date;
}

export interface MongoExpenseEntry {
    category: string;
    amount: number;
    monthly_amount: number;
    frequency: string;
    detail: Record<string, unknown>;
    updated_at: Date;
}

export interface MongoBigPictureEntry {
    category: string;
    amount: number;
    monthly_amount: number;
    frequency: string;
    updated_at: Date;
}

export interface MongoProfileDoc {
    profile_key: string;
    userid: ObjectId | null;
    display_name: string;
    expenses: MongoExpenseEntry[];
    big_picture: MongoBigPictureEntry[];
    created_at: Date;
    updated_at: Date;
}

export interface MongoTransactionDoc {
    transaction_id: number;
    profile_id: ObjectId | null;
    category: string;
    bucket: string;
    amount: number;
    spent_on: string;
    note: string;
    recurring: boolean;
    created_at: Date;
}

export interface MongoSpendEntryDoc {
    userid: number;
    category: string;
    amount: number;
    period: string;
    period_start: string;
    period_end: string;
    created_at: Date;
}

/* ─────────────────────────────────────────────────
   Demo account identity
───────────────────────────────────────────────── */

// One demo account for now. profile_key ties the Mongo profile document to the
// workbook's shared profile, so the dashboard writes land on both.
const DEMO_USERNAME = 'demo';
const DEMO_EMAIL = 'demo@how2money.local';
const DEMO_DISPLAY_NAME = 'Demo';
const DEMO_PROFILE_KEY = 'prototype';

/* ─────────────────────────────────────────────────
   Helpers
───────────────────────────────────────────────── */

// Best-effort wrapper for every Mongo call used from the request path:
// failures are logged and the caller carries on without Mongo.
async function safeMongo<T>(label: string, run: () => Promise<T>): Promise<T | undefined> {
    try {
        return await run();
    } catch (err) {
        console.error(`mongo ${label} failed (continuing without Mongo):`, err);
        return undefined;
    }
}

function toNumber(value: string | number | undefined): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

/* ─────────────────────────────────────────────────
   Startup: indexes + the demo account
───────────────────────────────────────────────── */

// Called once in the background at server start. Creates the collections'
// indexes and makes sure the demo user and its profile document exist.
export async function initMongoUserStore(): Promise<void> {
    const db = await getDb();

    // Indexes are idempotent, so re-running this on every boot is fine.
    await Promise.all([
        db.collection('users').createIndex({ username_lower: 1 }, { unique: true }),
        db.collection('users').createIndex({ email_lower: 1 }, { unique: true, sparse: true }),
        db.collection('profiles').createIndex({ profile_key: 1 }, { unique: true }),
        db.collection('transactions').createIndex({ profile_id: 1, spent_on: -1 }),
        db.collection('transactions').createIndex({ profile_id: 1, transaction_id: 1 }),
        db.collection('spend_entries').createIndex(
            { userid: 1, period: 1, period_start: 1, category: 1 },
            { unique: true },
        ),
    ]);

    const users = db.collection<MongoUserDoc>('users');
    await users.updateOne(
        { username_lower: DEMO_USERNAME },
        {
            $set: {
                username: DEMO_USERNAME,
                email: DEMO_EMAIL,
                email_lower: DEMO_EMAIL,
                name: DEMO_DISPLAY_NAME,
            },
            $setOnInsert: { created_at: new Date() },
        },
        { upsert: true },
    );

    const demoUser = await users.findOne({ username_lower: DEMO_USERNAME });
    if (!demoUser) {
        throw new Error('demo user missing right after upsert');
    }

    await db.collection<MongoProfileDoc>('profiles').updateOne(
        { profile_key: DEMO_PROFILE_KEY },
        {
            $set: {
                userid: demoUser._id,
                display_name: DEMO_DISPLAY_NAME,
                updated_at: new Date(),
            },
            $setOnInsert: {
                profile_key: DEMO_PROFILE_KEY,
                created_at: new Date(),
            },
        },
        { upsert: true },
    );
}

/* ─────────────────────────────────────────────────
   Demo profile sync
───────────────────────────────────────────────── */

// Re-reads the demo profile from the workbook and rewrites the Mongo profile
// document (embedded expenses + Big Picture) and its transactions collection.
// Called after every successful dashboard write, so adds, updates, and deletes
// all land in Mongo with ids that match what the dashboard sends.
export async function syncDemoProfileToMongo(): Promise<void> {
    await safeMongo('demo profile sync', async () => {
        const db = await getDb();
        const workbookProfile = await ensurePrototypeProfile();

        const [expenses, bigPicture, transactions] = await Promise.all([
            listProfileExpenses(workbookProfile.profile_id),
            listBigPicture(workbookProfile.profile_id),
            listAllProfileTransactions(workbookProfile.profile_id),
        ]);

        const now = new Date();
        const expenseEntries: MongoExpenseEntry[] = expenses.map((row) => ({
            category: row.category,
            amount: toNumber(row.amount),
            monthly_amount: toNumber(row.monthly_amount),
            frequency: row.frequency,
            detail: row.detail,
            updated_at: row.updated_at ?? now,
        }));
        const bigPictureEntries: MongoBigPictureEntry[] = bigPicture.map((row) => ({
            category: row.category,
            amount: toNumber(row.amount),
            monthly_amount: toNumber(row.monthly_amount),
            frequency: row.frequency,
            updated_at: row.updated_at ?? now,
        }));

        const profiles = db.collection<MongoProfileDoc>('profiles');
        const profileDoc = await profiles.findOneAndUpdate(
            { profile_key: DEMO_PROFILE_KEY },
            {
                $set: {
                    expenses: expenseEntries,
                    big_picture: bigPictureEntries,
                    updated_at: now,
                },
                $setOnInsert: {
                    profile_key: DEMO_PROFILE_KEY,
                    userid: null,
                    display_name: DEMO_DISPLAY_NAME,
                    created_at: now,
                },
            },
            { returnDocument: 'after', upsert: true },
        );

        // The transactions collection mirrors the workbook rows, keyed by the
        // Mongo profile's id so it can ride along when real users show up.
        const mongoProfileId = profileDoc?._id ?? null;
        const txCollection = db.collection<MongoTransactionDoc>('transactions');
        await txCollection.deleteMany({ profile_id: mongoProfileId });
        if (transactions.length > 0 && mongoProfileId) {
            await txCollection.insertMany(
                transactions.map((row) => ({
                    transaction_id: Number(row.transaction_id) || 0,
                    profile_id: mongoProfileId,
                    category: row.category,
                    bucket: row.bucket,
                    amount: toNumber(row.amount),
                    spent_on: row.spent_on,
                    note: row.note,
                    recurring: row.recurring,
                    created_at: row.created_at ?? now,
                })),
            );
        }
    });
}

/* ─────────────────────────────────────────────────
   Spend entries (Mongo replaces the Postgres table)
───────────────────────────────────────────────── */

function asStoredSpendEntry(doc: MongoSpendEntryDoc): StoredSpendEntry {
    return {
        category: doc.category,
        // Postgres returned NUMERIC as a string, so keep the same shape for the dashboard.
        amount: doc.amount.toFixed(2),
        period: doc.period,
        period_start: doc.period_start,
        period_end: doc.period_end,
        created_at: doc.created_at,
    };
}

// Everything the user has logged, newest window first.
export async function listMongoSpendEntries(userid: number, limit = 200): Promise<StoredSpendEntry[]> {
    const db = await getDb();
    const rows = await db
        .collection<MongoSpendEntryDoc>('spend_entries')
        .find({ userid })
        .sort({ period_start: -1, period: -1, category: 1 })
        .limit(limit)
        .toArray();
    return rows.map(asStoredSpendEntry);
}

// Just the one window the dashboard is showing.
export async function listMongoSpendEntriesForWindow(
    userid: number,
    period: Period,
): Promise<StoredSpendEntry[]> {
    const db = await getDb();
    const window = nextPeriodWindow(period);
    const rows = await db
        .collection<MongoSpendEntryDoc>('spend_entries')
        .find({ userid, period, period_start: window.start })
        .sort({ category: 1 })
        .toArray();
    return rows.map(asStoredSpendEntry);
}

// Saves the whole window: rows in the payload are upserted, rows that are no
// longer in the payload are dropped — the same window-replace rule the
// Postgres version used. bulkWrite is not atomic on a standalone mongod, but
// the unique index makes re-running the save harmless.
export async function saveMongoSpendEntries(
    userid: number,
    period: Period,
    window: PeriodWindow,
    entries: SpendEntryInput[],
): Promise<number> {
    const db = await getDb();
    const collection = db.collection<MongoSpendEntryDoc>('spend_entries');

    const categories = entries.map((entry) => entry.category);
    const now = new Date();

    const operations = [
        {
            deleteMany: {
                filter: {
                    userid,
                    period,
                    period_start: window.start,
                    category: { $nin: categories },
                },
            },
        },
        ...entries.map((entry) => ({
            replaceOne: {
                filter: {
                    userid,
                    category: entry.category,
                    period,
                    period_start: window.start,
                },
                replacement: {
                    userid,
                    category: entry.category,
                    amount: entry.amount,
                    period,
                    period_start: window.start,
                    period_end: window.end,
                    created_at: now,
                } satisfies MongoSpendEntryDoc,
                upsert: true,
            },
        })),
    ];

    await collection.bulkWrite(operations, { ordered: false });
    return entries.length;
}
