// MongoDB storage for the prototype dashboard.
//
// This is the normal mode: one shared `prototype` profile document holds the
// monthly setup and the Big Picture planner, and the `transactions` collection
// holds every purchase. The xlsx workbook is only used by demo mode when Mongo
// is unreachable (see prototype_router.ts).

import type { Db, ObjectId } from 'mongodb';
import { getDb } from './db_mongo';
import {
    BUCKETS,
    MONTHLY_MULTIPLIER,
    PrototypeRequestError,
    asFrequency,
    dayText,
    roundCents,
    toNumber,
    type BigPictureEntry,
    type BigPictureRow,
    type ExpenseRow,
    type MonthlySetupEntry,
    type NewTransaction,
    type ProfileData,
    type TransactionRow,
} from './prototype_model';

export const PROTOTYPE_PROFILE_KEY = 'prototype';
const DEFAULT_DISPLAY_NAME = 'Prototype profile';

type MongoExpenseDoc = {
    category: string;
    amount: number;
    monthly_amount: number;
    frequency: string;
    detail: Record<string, unknown>;
    updated_at: Date;
};

type MongoBigPictureDoc = {
    category: string;
    amount: number;
    monthly_amount: number;
    frequency: string;
    updated_at: Date;
};

export type MongoProfileDoc = {
    _id?: ObjectId;
    profile_key: string;
    userid: ObjectId | null;
    display_name: string;
    expenses: MongoExpenseDoc[];
    big_picture: MongoBigPictureDoc[];
    next_transaction_id?: number;
    created_at: Date;
    updated_at: Date;
};

export type MongoTransactionDoc = {
    _id?: ObjectId;
    transaction_id: number;
    profile_id: ObjectId | null;
    category: string;
    bucket: string;
    amount: number;
    spent_on: string;
    note: string;
    recurring: boolean;
    created_at: Date;
};

const profiles = (db: Db) => db.collection<MongoProfileDoc>('profiles');
const transactions = (db: Db) => db.collection<MongoTransactionDoc>('transactions');

function asExpenseRow(row: MongoExpenseDoc): ExpenseRow {
    const amount = toNumber(row.amount);
    const frequency = asFrequency(row.frequency);
    return {
        category: row.category,
        amount,
        frequency,
        detail: row.detail ?? {},
        updated_at: row.updated_at ?? null,
    };
}

function asBigPictureRow(row: MongoBigPictureDoc): BigPictureRow {
    return {
        category: row.category,
        amount: toNumber(row.amount),
        frequency: asFrequency(row.frequency),
        updated_at: row.updated_at ?? null,
    };
}

function asTransactionRow(row: MongoTransactionDoc): TransactionRow {
    return {
        transaction_id: row.transaction_id,
        category: row.category,
        bucket: row.bucket,
        amount: toNumber(row.amount),
        spent_on: dayText(row.spent_on),
        note: row.note ?? '',
        recurring: Boolean(row.recurring),
        created_at: row.created_at ?? null,
    };
}

export async function hasPrototypeProfile(): Promise<boolean> {
    const db = await getDb();
    return Boolean(await profiles(db).findOne({ profile_key: PROTOTYPE_PROFILE_KEY }, { projection: { _id: 1 } }));
}

type ProfileWithId = MongoProfileDoc & { _id: ObjectId };

async function ensureProfile(db: Db): Promise<ProfileWithId> {
    const now = new Date();
    const doc = await profiles(db).findOneAndUpdate(
        { profile_key: PROTOTYPE_PROFILE_KEY },
        {
            $setOnInsert: {
                profile_key: PROTOTYPE_PROFILE_KEY,
                userid: null,
                display_name: DEFAULT_DISPLAY_NAME,
                expenses: [],
                big_picture: [],
                next_transaction_id: 1,
                created_at: now,
                updated_at: now,
            },
        },
        { upsert: true, returnDocument: 'after' }
    );
    if (!doc?._id) throw new Error('could not create the prototype profile');
    return doc as ProfileWithId;
}

// Reads never create the profile, so opening the dashboard changes nothing.
export async function getProfileData(): Promise<ProfileData> {
    const db = await getDb();
    const profile = await profiles(db).findOne({ profile_key: PROTOTYPE_PROFILE_KEY });
    if (!profile?._id) {
        return { profile: null, expenses: [], transactions: [], bigPicture: [] };
    }

    const rows = await transactions(db)
        .find({ profile_id: profile._id })
        .toArray();

    return {
        profile: {
            profile_key: profile.profile_key,
            display_name: profile.display_name,
            updated_at: profile.updated_at ?? null,
        },
        expenses: (profile.expenses ?? []).map(asExpenseRow),
        transactions: rows.map(asTransactionRow),
        bigPicture: (profile.big_picture ?? []).map(asBigPictureRow),
    };
}

// Replace the whole expected setup. A bucket left out of the list is removed,
// which is how clearing an input and saving actually clears it. The saved
// breakdown detail is kept because the dashboard does not send it back.
export async function replaceMonthlySetup(entries: MonthlySetupEntry[]): Promise<void> {
    const db = await getDb();
    const profile = await ensureProfile(db);
    const now = new Date();
    const previous = profile.expenses ?? [];

    const expenses: MongoExpenseDoc[] = entries.map(entry => ({
        category: entry.bucket,
        amount: roundCents(entry.amount),
        monthly_amount: roundCents(entry.amount * MONTHLY_MULTIPLIER[entry.frequency]),
        frequency: entry.frequency,
        detail: previous.find(row => row.category === entry.bucket)?.detail ?? {},
        updated_at: now,
    }));

    await profiles(db).updateOne(
        { _id: profile._id },
        { $set: { expenses, updated_at: now } }
    );
}

// Replace the five Big Picture rows in one save. Omitting a category removes
// it, so clearing everything falls back to the monthly setup total in stats.
export async function replaceBigPicture(entries: BigPictureEntry[]): Promise<void> {
    const db = await getDb();
    const profile = await ensureProfile(db);
    const now = new Date();

    const bigPicture: MongoBigPictureDoc[] = entries.map(entry => ({
        category: entry.category,
        amount: roundCents(entry.amount),
        monthly_amount: roundCents(entry.amount * MONTHLY_MULTIPLIER[entry.frequency]),
        frequency: entry.frequency,
        updated_at: now,
    }));

    await profiles(db).updateOne(
        { _id: profile._id },
        { $set: { big_picture: bigPicture, updated_at: now } }
    );
}

async function nextTransactionId(db: Db, profile: ProfileWithId): Promise<number> {
    const newest = await transactions(db)
        .find({ profile_id: profile._id })
        .sort({ transaction_id: -1 })
        .limit(1)
        .next();
    const highest = toNumber(newest?.transaction_id);
    const remembered = toNumber(profile.next_transaction_id);
    const next = Math.max(highest, remembered - 1) + 1;

    await profiles(db).updateOne(
        { _id: profile._id },
        { $set: { next_transaction_id: next + 1 } }
    );
    return next;
}

export async function addTransaction(input: NewTransaction): Promise<void> {
    const db = await getDb();
    const profile = await ensureProfile(db);

    // The unique (profile_id, transaction_id) index is the real guard. Two
    // quick adds can race for the same id, so retry with a freshly computed one
    // instead of failing the request.
    for (let attempt = 1; ; attempt += 1) {
        const id = await nextTransactionId(db, profile);
        try {
            await transactions(db).insertOne({
                transaction_id: id,
                profile_id: profile._id,
                category: input.category,
                bucket: input.bucket,
                amount: roundCents(input.amount),
                spent_on: input.spentOn,
                note: input.note,
                recurring: input.recurring,
                created_at: new Date(),
            });
            break;
        } catch (err) {
            const duplicate = (err as { code?: number }).code === 11000;
            if (!duplicate || attempt >= 3) throw err;
        }
    }

    await profiles(db).updateOne(
        { _id: profile._id },
        { $set: { updated_at: new Date() } }
    );
}

export async function removeTransaction(transactionId: string): Promise<boolean> {
    const db = await getDb();
    const profile = await profiles(db).findOne({ profile_key: PROTOTYPE_PROFILE_KEY });
    if (!profile?._id) return false;

    const numeric = Number(transactionId);
    if (!Number.isSafeInteger(numeric) || numeric <= 0) {
        throw new PrototypeRequestError(400, 'Pick a valid transaction.');
    }

    const result = await transactions(db).deleteOne({
        profile_id: profile._id,
        transaction_id: numeric,
    });
    if (result.deletedCount === 0) return false;

    await profiles(db).updateOne(
        { _id: profile._id },
        { $set: { updated_at: new Date() } }
    );
    return true;
}

// One-time import (and fresh-database seeding) from a workbook profile.
// Everything is replaced so re-running the import is idempotent.
export async function importProfileData(data: ProfileData & { displayName?: string }): Promise<void> {
    const db = await getDb();
    const profile = await ensureProfile(db);
    const now = new Date();

    const expenses: MongoExpenseDoc[] = data.expenses.map(row => ({
        category: row.category,
        amount: roundCents(row.amount),
        monthly_amount: roundCents(row.amount * MONTHLY_MULTIPLIER[asFrequency(row.frequency)]),
        frequency: row.frequency,
        detail: row.detail ?? {},
        updated_at: row.updated_at instanceof Date ? row.updated_at : now,
    }));

    const bigPicture: MongoBigPictureDoc[] = data.bigPicture.map(row => ({
        category: row.category,
        amount: roundCents(row.amount),
        monthly_amount: roundCents(row.amount * MONTHLY_MULTIPLIER[asFrequency(row.frequency)]),
        frequency: row.frequency,
        updated_at: row.updated_at instanceof Date ? row.updated_at : now,
    }));

    const transactionDocs: MongoTransactionDoc[] = data.transactions.map(row => ({
        transaction_id: toNumber(row.transaction_id),
        profile_id: profile._id ?? null,
        category: row.category,
        bucket: row.bucket,
        amount: roundCents(row.amount),
        spent_on: dayText(row.spent_on),
        note: row.note ?? '',
        recurring: Boolean(row.recurring),
        created_at: row.created_at instanceof Date ? row.created_at : now,
    }));

    await profiles(db).updateOne(
        { _id: profile._id },
        {
            $set: {
                display_name: data.displayName || data.profile?.display_name || DEFAULT_DISPLAY_NAME,
                expenses,
                big_picture: bigPicture,
                next_transaction_id: transactionDocs.reduce(
                    (max, row) => Math.max(max, row.transaction_id),
                    0
                ) + 1,
                updated_at: now,
            },
        }
    );

    await transactions(db).deleteMany({ profile_id: profile._id });
    if (transactionDocs.length > 0) await transactions(db).insertMany(transactionDocs);
}

// Keeps the bucket list importable by scripts without reaching into the model.
export const PROTOTYPE_BUCKETS = BUCKETS;
