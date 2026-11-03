// What the user actually spent.
//
// One row per category per budget period. The dashboard writes into the
// window it shows (next week / next month) and saving again for the same
// window replaces the numbers instead of stacking up rows.
//
// The category column holds the assessment form's bucket key (housing, food,
// ...), so a spend entry lines up with the plan the user filled in.

import { pool } from './db_con';

export type Period = 'week' | 'month';

export type SpendEntryInput = {
    category: string;
    amount: number;
};

export type StoredSpendEntry = {
    category: string;
    amount: string;
    period: string;
    period_start: string;
    period_end: string;
    created_at: Date;
};

export type PeriodWindow = {
    start: string;
    end: string;
};

function toDateString(d: Date): string {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// The window a period covers. "week" is the seven days starting on the next
// Monday (today, if today is a Monday). "month" is next calendar month.
export function nextPeriodWindow(period: Period): PeriodWindow {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (period === 'month') {
        const start = new Date(today.getFullYear(), today.getMonth() + 1, 1);
        const end = new Date(today.getFullYear(), today.getMonth() + 2, 0);
        return { start: toDateString(start), end: toDateString(end) };
    }

    // getDay() is 0 for Sunday, so shift it round to make Monday 0.
    const daysSinceMonday = (today.getDay() + 6) % 7;
    const start = new Date(today);
    start.setDate(start.getDate() + (7 - daysSinceMonday) % 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { start: toDateString(start), end: toDateString(end) };
}

// Everything the user has logged, newest window first.
export async function listSpendEntries(userid: number, limit = 200): Promise<StoredSpendEntry[]> {
    const result = await pool.query(
        `SELECT category, amount, period,
                to_char(period_start, 'YYYY-MM-DD') AS period_start,
                to_char(period_end, 'YYYY-MM-DD')   AS period_end,
                created_at
           FROM spend_entries
          WHERE userid = $1
          ORDER BY period_start DESC, period DESC, category
          LIMIT $2`,
        [userid, limit]
    );
    return result.rows as StoredSpendEntry[];
}

// Just the one window the dashboard is showing.
export async function listSpendEntriesForWindow(
    userid: number,
    period: Period
): Promise<StoredSpendEntry[]> {
    const { start } = nextPeriodWindow(period);
    const result = await pool.query(
        `SELECT category, amount, period,
                to_char(period_start, 'YYYY-MM-DD') AS period_start,
                to_char(period_end, 'YYYY-MM-DD')   AS period_end,
                created_at
           FROM spend_entries
          WHERE userid = $1 AND period = $2 AND period_start = $3
          ORDER BY category`,
        [userid, period, start]
    );
    return result.rows as StoredSpendEntry[];
}

// Saves the whole window: rows in the payload are upserted, rows that are no
// longer in the payload are dropped. That way clearing a box and saving
// again actually clears it.
export async function saveSpendEntries(
    userid: number,
    period: Period,
    window: PeriodWindow,
    entries: SpendEntryInput[]
): Promise<number> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const categories = entries.map(e => e.category);
        await client.query(
            `DELETE FROM spend_entries
              WHERE userid = $1 AND period = $2 AND period_start = $3
                AND NOT (category = ANY($4::text[]))`,
            [userid, period, window.start, categories]
        );

        for (const e of entries) {
            await client.query(
                `INSERT INTO spend_entries
                    (userid, category, amount, period, period_start, period_end)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (userid, category, period, period_start)
                 DO UPDATE SET amount      = EXCLUDED.amount,
                               period_end  = EXCLUDED.period_end,
                               created_at  = now()`,
                [userid, e.category, e.amount.toFixed(2), period, window.start, window.end]
            );
        }

        await client.query('COMMIT');
        return entries.length;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}
