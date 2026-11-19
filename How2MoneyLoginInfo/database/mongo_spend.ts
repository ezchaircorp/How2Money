// Spend entries in MongoDB.
//
// Kept for the future authenticated dashboard: the current pages do not call
// /api/spend, but the routes and store stay while that decision is open.

import { getDb } from './db_mongo';
import { COLLECTIONS, type SpendEntryDoc } from './schema';
import type { Period, PeriodWindow, SpendEntryInput, StoredSpendEntry } from './db_spend';

export type MongoSpendEntryDoc = SpendEntryDoc;

function asStoredSpendEntry(doc: MongoSpendEntryDoc): StoredSpendEntry {
    return {
        category: doc.category,
        // Postgres used to return NUMERIC as a string, so keep the same shape.
        amount: doc.amount.toFixed(2),
        period: doc.period,
        period_start: doc.period_start,
        period_end: doc.period_end,
        created_at: doc.created_at,
    };
}

// Everything the user has logged, newest window first.
export async function listMongoSpendEntries(userid: string, limit = 200): Promise<StoredSpendEntry[]> {
    const db = await getDb();
    const rows = await db
        .collection<MongoSpendEntryDoc>(COLLECTIONS.spendEntries)
        .find({ userid })
        .sort({ period_start: -1, period: -1, category: 1 })
        .limit(limit)
        .toArray();
    return rows.map(asStoredSpendEntry);
}

// Just the one window the dashboard is showing.
export async function listMongoSpendEntriesForWindow(
    userid: string,
    period: Period,
    window: PeriodWindow,
): Promise<StoredSpendEntry[]> {
    const db = await getDb();
    const rows = await db
        .collection<MongoSpendEntryDoc>(COLLECTIONS.spendEntries)
        .find({ userid, period, period_start: window.start })
        .sort({ category: 1 })
        .toArray();
    return rows.map(asStoredSpendEntry);
}

// Saves the whole window: rows in the payload are upserted, rows that are no
// longer in the payload are dropped. bulkWrite is not atomic on a standalone
// mongod, but the unique index makes re-running the save harmless.
export async function saveMongoSpendEntries(
    userid: string,
    period: Period,
    window: PeriodWindow,
    entries: SpendEntryInput[],
): Promise<number> {
    const db = await getDb();
    const collection = db.collection<MongoSpendEntryDoc>(COLLECTIONS.spendEntries);

    const categories = entries.map(entry => entry.category);
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
        ...entries.map(entry => ({
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
