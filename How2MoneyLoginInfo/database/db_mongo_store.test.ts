// Tests for the MongoDB data-access layer (db_mongo_store.ts).
//
// User story: "As a signed-in user, I want to record what I actually spent in
// each category for the coming week or month, so I can compare it with my plan."
//
// These tests talk to the data-access functions directly, with no server or
// browser involved. They never touch the team's real database:
//   - MongoDB is a throwaway in-memory server (mongodb-memory-server) that is
//     started for this file and deleted afterwards.
//   - getDb() is replaced so the store can only ever reach that test server,
//     whatever MONGO_URI or .env says.
//   - The demo-profile sync reads a temporary copy of the sample workbook.
//
// Run from How2MoneyLoginInfo:  npm test

import fs from 'node:fs';
import path from 'node:path';
import { MongoClient, type Db } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs before any import below, so prototype_store reads the temporary
// workbook rather than the real prototype_data_storage.xlsx.
const testState = vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const folder = mkdtempSync(join(tmpdir(), 'how2money-mongo-test-'));
    process.env.PROTOTYPE_STORAGE_FILE = join(folder, 'workbook.xlsx');
    return { folder, db: null as Db | null, failConnection: false };
});

vi.mock('./db_mongo', async () => {
    const state = await testState;
    return {
        getDb: async () => {
            if (state.failConnection) throw new Error('simulated: MongoDB is unreachable');
            if (!state.db) throw new Error('test database is not ready');
            return state.db;
        },
        closeMongo: async () => undefined,
    };
});

import {
    SpendValidationError,
    initMongoUserStore,
    listMongoSpendEntries,
    listMongoSpendEntriesForWindow,
    saveMongoSpendEntries,
    syncDemoProfileToMongo,
} from './db_mongo_store';
import { nextPeriodWindow } from './db_spend';

const SAMPLE_WORKBOOK = path.resolve(__dirname, '..', '..', 'sample_data', 'prototype_six_months.xlsx');

let mongo: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
    const state = await testState;
    mongo = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongo.getUri());
    db = client.db('how2money_test');
    state.db = db;
    fs.copyFileSync(SAMPLE_WORKBOOK, process.env.PROTOTYPE_STORAGE_FILE as string);
});

afterAll(async () => {
    const state = await testState;
    await client?.close();
    await mongo?.stop();
    fs.rmSync(state.folder, { recursive: true, force: true });
});

beforeEach(async () => {
    // Every test starts from an empty database with the real indexes.
    await db.dropDatabase();
    await initMongoUserStore();
});

afterEach(async () => {
    (await testState).failConnection = false;
    vi.restoreAllMocks();
});

const USER = 101;
const OTHER_USER = 202;
const week = () => nextPeriodWindow('week');
const month = () => nextPeriodWindow('month');

describe('saving and reading spend entries', () => {
    it('saves a week of spending and reads it back for that window', async () => {
        const saved = await saveMongoSpendEntries(USER, 'week', week(), [
            { category: 'food', amount: 82.5 },
            { category: 'housing', amount: 350 },
        ]);
        expect(saved).toBe(2);

        const rows = await listMongoSpendEntriesForWindow(USER, 'week');
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({
            category: 'food',
            amount: '82.50',
            period: 'week',
            period_start: week().start,
            period_end: week().end,
        });
        expect(rows[1]).toMatchObject({ category: 'housing', amount: '350.00' });
    });

    it('saving the same window again replaces amounts instead of adding rows', async () => {
        await saveMongoSpendEntries(USER, 'week', week(), [{ category: 'food', amount: 50 }]);
        await saveMongoSpendEntries(USER, 'week', week(), [{ category: 'food', amount: 75.25 }]);

        const rows = await listMongoSpendEntriesForWindow(USER, 'week');
        expect(rows).toHaveLength(1);
        expect(rows[0]?.amount).toBe('75.25');
        expect(await db.collection('spend_entries').countDocuments({ userid: USER })).toBe(1);
    });

    it('drops a category that is left out of the next save', async () => {
        await saveMongoSpendEntries(USER, 'week', week(), [
            { category: 'food', amount: 40 },
            { category: 'travel', amount: 120 },
        ]);
        await saveMongoSpendEntries(USER, 'week', week(), [{ category: 'food', amount: 40 }]);

        const rows = await listMongoSpendEntriesForWindow(USER, 'week');
        expect(rows.map((row) => row.category)).toEqual(['food']);
    });

    it('rounds amounts to cents', async () => {
        await saveMongoSpendEntries(USER, 'month', month(), [{ category: 'shopping', amount: 19.999 }]);
        const doc = await db.collection('spend_entries').findOne({ userid: USER });
        expect(doc?.amount).toBe(20);
    });

    it('keeps weekly and monthly entries separate', async () => {
        await saveMongoSpendEntries(USER, 'week', week(), [{ category: 'food', amount: 60 }]);
        await saveMongoSpendEntries(USER, 'month', month(), [{ category: 'food', amount: 240 }]);

        expect((await listMongoSpendEntriesForWindow(USER, 'week'))[0]?.amount).toBe('60.00');
        expect((await listMongoSpendEntriesForWindow(USER, 'month'))[0]?.amount).toBe('240.00');
        expect(await listMongoSpendEntries(USER)).toHaveLength(2);
    });

    it('never changes or shows another user’s entries', async () => {
        await saveMongoSpendEntries(OTHER_USER, 'week', week(), [{ category: 'food', amount: 999 }]);
        await saveMongoSpendEntries(USER, 'week', week(), [{ category: 'housing', amount: 10 }]);
        // An empty save clears this user's window only.
        await saveMongoSpendEntries(USER, 'week', week(), []);

        expect(await listMongoSpendEntries(USER)).toEqual([]);
        const other = await listMongoSpendEntries(OTHER_USER);
        expect(other).toHaveLength(1);
        expect(other[0]).toMatchObject({ category: 'food', amount: '999.00' });
    });

    it('lists history newest window first and honours the limit', async () => {
        await saveMongoSpendEntries(USER, 'month', { start: '2026-01-01', end: '2026-01-31' }, [
            { category: 'food', amount: 1 },
        ]);
        await saveMongoSpendEntries(USER, 'month', { start: '2026-03-01', end: '2026-03-31' }, [
            { category: 'food', amount: 3 },
        ]);
        await saveMongoSpendEntries(USER, 'month', { start: '2026-02-01', end: '2026-02-28' }, [
            { category: 'food', amount: 2 },
        ]);

        const history = await listMongoSpendEntries(USER);
        expect(history.map((row) => row.period_start)).toEqual(['2026-03-01', '2026-02-01', '2026-01-01']);
        expect(await listMongoSpendEntries(USER, 2)).toHaveLength(2);
    });
});

describe('invalid input is rejected and nothing is written', () => {
    const cases: [string, () => Promise<unknown>][] = [
        ['a negative amount', () => saveMongoSpendEntries(USER, 'week', week(), [{ category: 'food', amount: -5 }])],
        ['an amount that is not a number', () =>
            saveMongoSpendEntries(USER, 'week', week(), [{ category: 'food', amount: Number.NaN }])],
        ['a blank category', () => saveMongoSpendEntries(USER, 'week', week(), [{ category: '  ', amount: 5 }])],
        ['the same category twice', () =>
            saveMongoSpendEntries(USER, 'week', week(), [
                { category: 'food', amount: 5 },
                { category: 'food', amount: 6 },
            ])],
        ['an unknown period', () =>
            saveMongoSpendEntries(USER, 'year' as never, week(), [{ category: 'food', amount: 5 }])],
        ['an impossible date', () =>
            saveMongoSpendEntries(USER, 'month', { start: '2026-02-30', end: '2026-03-01' }, [
                { category: 'food', amount: 5 },
            ])],
        ['a window that ends before it starts', () =>
            saveMongoSpendEntries(USER, 'week', { start: '2026-12-07', end: '2026-12-01' }, [
                { category: 'food', amount: 5 },
            ])],
        ['a user id that is not a positive whole number', () =>
            saveMongoSpendEntries(0, 'week', week(), [{ category: 'food', amount: 5 }])],
    ];

    it.each(cases)('%s', async (_name, save) => {
        await expect(save()).rejects.toBeInstanceOf(SpendValidationError);
        expect(await db.collection('spend_entries').countDocuments()).toBe(0);
    });

    it('a bad entry stops the whole save, so earlier data is left as it was', async () => {
        await saveMongoSpendEntries(USER, 'week', week(), [{ category: 'food', amount: 30 }]);
        await expect(
            saveMongoSpendEntries(USER, 'week', week(), [
                { category: 'housing', amount: 100 },
                { category: 'travel', amount: -1 },
            ]),
        ).rejects.toThrow(SpendValidationError);

        const rows = await listMongoSpendEntriesForWindow(USER, 'week');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ category: 'food', amount: '30.00' });
    });
});

describe('database rules and error handling', () => {
    it('the unique index refuses a duplicate row for the same window', async () => {
        await saveMongoSpendEntries(USER, 'week', week(), [{ category: 'food', amount: 10 }]);
        const duplicate = {
            userid: USER,
            category: 'food',
            amount: 99,
            period: 'week',
            period_start: week().start,
            period_end: week().end,
            created_at: new Date(),
        };
        await expect(db.collection('spend_entries').insertOne(duplicate)).rejects.toMatchObject({ code: 11000 });
    });

    it('setting up the store twice does not duplicate the demo account', async () => {
        await initMongoUserStore();
        expect(await db.collection('users').countDocuments({ username_lower: 'demo' })).toBe(1);
        expect(await db.collection('profiles').countDocuments({ profile_key: 'prototype' })).toBe(1);
    });

    it('reports a clear error when the database cannot be reached', async () => {
        (await testState).failConnection = true;
        await expect(listMongoSpendEntries(USER)).rejects.toThrow('MongoDB is unreachable');
    });
});

describe('dashboard changes are mirrored into MongoDB', () => {
    it('copies the demo profile and its transactions from the workbook', async () => {
        await syncDemoProfileToMongo();

        const profile = await db.collection('profiles').findOne({ profile_key: 'prototype' });
        expect(profile?.expenses).toHaveLength(11);
        expect(profile?.big_picture).toHaveLength(5);
        const transactions = await db.collection('transactions').countDocuments({ profile_id: profile?._id });
        expect(transactions).toBeGreaterThan(100);
    });

    it('syncing twice replaces the mirror rather than doubling it', async () => {
        await syncDemoProfileToMongo();
        const first = await db.collection('transactions').countDocuments();
        await syncDemoProfileToMongo();
        expect(await db.collection('transactions').countDocuments()).toBe(first);
    });

    it('a failed sync is logged and does not crash the dashboard', async () => {
        (await testState).failConnection = true;
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await expect(syncDemoProfileToMongo()).resolves.toBeUndefined();
        expect(logged).toHaveBeenCalledWith(
            expect.stringContaining('demo profile sync failed'),
            expect.any(Error),
        );
    });
});
