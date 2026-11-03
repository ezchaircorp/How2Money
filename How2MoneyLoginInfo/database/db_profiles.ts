// Postgres-backed profiles for the future authenticated dashboard.
//
// The current no-login prototype dashboard uses database/prototype_store.ts
// (prototype_data_storage.xlsx) instead. This module keeps the DB shape for a
// later version where each profile points at a real user. The profile row has
// a nullable userid, so personal profiles can be added without changing the
// expense rows or the API shape.

import { pool } from './db_con';

export const PROTOTYPE_PROFILE_KEY = 'prototype';
export const PROTOTYPE_PROFILE_NAME = 'Prototype profile';

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
    created_at: Date;
};

export type ProfileTransactionInput = {
    category: string;
    bucket: string;
    amount: number;
    spentOn: string;
    note: string;
};

// Create the shared profile on first use, then return it. The no-op UPDATE is
// only there so RETURNING gives us the row when the INSERT hits the conflict.
export async function ensurePrototypeProfile(): Promise<StoredProfile> {
    const result = await pool.query<StoredProfile>(
        `INSERT INTO profiles (profile_key, display_name)
         VALUES ($1, $2)
         ON CONFLICT (profile_key) DO UPDATE
         SET display_name = profiles.display_name
         RETURNING profile_id, profile_key, display_name, userid, created_at, updated_at`,
        [PROTOTYPE_PROFILE_KEY, PROTOTYPE_PROFILE_NAME]
    );

    const row = result.rows[0];
    if (!row) throw new Error('Could not create the prototype profile.');
    return row;
}

// Every expense bucket in a profile, with the amount normalised to a month.
export async function listProfileExpenses(profileId: string): Promise<StoredProfileExpense[]> {
    const result = await pool.query(
        `SELECT category,
                amount,
                ROUND(amount * CASE frequency
                        WHEN 'yearly'  THEN 1.0 / 12
                        WHEN 'weekly'  THEN 52.0 / 12
                        ELSE 1.0
                    END, 2) AS monthly_amount,
                frequency,
                detail,
                updated_at
           FROM profile_expenses
          WHERE profile_id = $1
          ORDER BY category`,
        [profileId]
    );
    return result.rows as StoredProfileExpense[];
}

// Add a bucket, or replace the numbers for a bucket that is already there.
// Saving again is how the prototype profile stays "running" rather than
// stacking duplicate rows.
export async function upsertProfileExpense(
    profileId: string,
    expense: ProfileExpenseInput
): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(
            `INSERT INTO profile_expenses
                (profile_id, category, amount, frequency, detail)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (profile_id, category) DO UPDATE
             SET amount     = EXCLUDED.amount,
                 frequency  = EXCLUDED.frequency,
                 detail     = EXCLUDED.detail,
                 updated_at = now()`,
            [
                profileId,
                expense.bucket,
                expense.amount.toFixed(2),
                expense.frequency,
                JSON.stringify(expense.detail),
            ]
        );

        await client.query('UPDATE profiles SET updated_at = now() WHERE profile_id = $1', [profileId]);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// Remove one bucket from the profile. Returns false when there was nothing to
// remove, so the route can answer 404 without a second query.
export async function removeProfileExpense(profileId: string, bucket: string): Promise<boolean> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const deleted = await client.query(
            'DELETE FROM profile_expenses WHERE profile_id = $1 AND category = $2',
            [profileId, bucket]
        );

        if ((deleted.rowCount ?? 0) > 0) {
            await client.query('UPDATE profiles SET updated_at = now() WHERE profile_id = $1', [profileId]);
        }

        await client.query('COMMIT');
        return (deleted.rowCount ?? 0) > 0;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// Replaces the whole expected-monthly setup for a profile. Buckets that are
// missing from the payload are removed, so clearing an input and saving really
// clears it. The optional breakdown detail on existing rows is left alone.
export async function replaceMonthlySetup(
    profileId: string,
    entries: MonthlySetupInput[]
): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const buckets = entries.map(e => e.bucket);
        await client.query(
            `DELETE FROM profile_expenses
              WHERE profile_id = $1
                AND NOT (category = ANY($2::text[]))`,
            [profileId, buckets]
        );

        for (const entry of entries) {
            await client.query(
                `INSERT INTO profile_expenses
                    (profile_id, category, amount, frequency)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (profile_id, category) DO UPDATE
                 SET amount     = EXCLUDED.amount,
                     frequency  = EXCLUDED.frequency,
                     updated_at = now()`,
                [profileId, entry.bucket, entry.amount.toFixed(2), entry.frequency]
            );
        }

        await client.query('UPDATE profiles SET updated_at = now() WHERE profile_id = $1', [profileId]);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// Actual spending per bucket for the current calendar month.
export async function listMonthlyActuals(profileId: string): Promise<ProfileMonthlyActual[]> {
    const result = await pool.query(
        `SELECT bucket,
                COALESCE(SUM(amount), 0) AS actual,
                COUNT(*)::int           AS transaction_count
           FROM profile_transactions
          WHERE profile_id = $1
            AND spent_on >= date_trunc('month', CURRENT_DATE)::date
            AND spent_on <  (date_trunc('month', CURRENT_DATE) + interval '1 month')::date
          GROUP BY bucket`,
        [profileId]
    );
    return result.rows as ProfileMonthlyActual[];
}

// Newest transactions first. The dashboard shows these in the right column.
export async function listProfileTransactions(
    profileId: string,
    limit = 100
): Promise<StoredProfileTransaction[]> {
    const result = await pool.query(
        `SELECT transaction_id,
                category,
                bucket,
                amount,
                to_char(spent_on, 'YYYY-MM-DD') AS spent_on,
                note,
                created_at
           FROM profile_transactions
          WHERE profile_id = $1
          ORDER BY spent_on DESC, transaction_id DESC
          LIMIT $2`,
        [profileId, limit]
    );
    return result.rows as StoredProfileTransaction[];
}

// One purchase. The transaction is grouped by bucket so it can roll into the
// matching monthly setup row.
export async function addProfileTransaction(
    profileId: string,
    transaction: ProfileTransactionInput
): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        await client.query(
            `INSERT INTO profile_transactions
                (profile_id, category, bucket, amount, spent_on, note)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                profileId,
                transaction.category,
                transaction.bucket,
                transaction.amount.toFixed(2),
                transaction.spentOn,
                transaction.note,
            ]
        );

        await client.query('UPDATE profiles SET updated_at = now() WHERE profile_id = $1', [profileId]);
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

export async function removeProfileTransaction(
    profileId: string,
    transactionId: string
): Promise<boolean> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const deleted = await client.query(
            'DELETE FROM profile_transactions WHERE profile_id = $1 AND transaction_id = $2',
            [profileId, transactionId]
        );

        if ((deleted.rowCount ?? 0) > 0) {
            await client.query('UPDATE profiles SET updated_at = now() WHERE profile_id = $1', [profileId]);
        }

        await client.query('COMMIT');
        return (deleted.rowCount ?? 0) > 0;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}
