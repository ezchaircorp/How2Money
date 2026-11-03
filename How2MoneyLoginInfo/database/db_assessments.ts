// Assessment submissions.
//
// One row per submitted form in assessments, plus one row per expense bucket
// the visitor filled in. userid is NULL when the visitor wasn't logged in.

import { pool } from './db_con';

export type AssessmentExpense = {
    bucket: string;
    amount: number;
    monthlyAmount: number;
    frequency: string;
    detail: Record<string, unknown>;
};

export type AssessmentInput = {
    userid: number | null;
    firstName: string;
    lastName: string;
    email: string;
    householdIncome: string;
    expenses: AssessmentExpense[];
};

export type StoredAssessment = {
    assessment_id: string;
    userid: number | null;
    first_name: string;
    last_name: string;
    email: string;
    household_income: string;
    total_monthly: string;
    submitted_at: Date;
};

export async function saveAssessment(input: AssessmentInput): Promise<string> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const inserted = await client.query<{ assessment_id: string }>(
            `INSERT INTO assessments
                (userid, first_name, last_name, email, household_income, total_monthly)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING assessment_id`,
            [
                input.userid,
                input.firstName,
                input.lastName,
                input.email,
                input.householdIncome,
                input.expenses.reduce((sum, e) => sum + e.monthlyAmount, 0).toFixed(2),
            ]
        );

        const assessmentId = inserted.rows[0]!.assessment_id;

        for (const e of input.expenses) {
            await client.query(
                `INSERT INTO assessment_expenses
                    (assessment_id, category, amount, frequency, detail)
                 VALUES ($1, $2, $3, $4, $5)`,
                [assessmentId, e.bucket, e.amount.toFixed(2), e.frequency, JSON.stringify(e.detail)]
            );
        }

        await client.query('COMMIT');
        return assessmentId;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// The most recent assessment this user filled in. The dashboard shows this
// as their profile.
export async function getLatestAssessmentForUser(userid: number): Promise<StoredAssessment | null> {
    const result = await pool.query(
        `SELECT assessment_id, userid, first_name, last_name, email,
                household_income, total_monthly, submitted_at
           FROM assessments
          WHERE userid = $1
          ORDER BY submitted_at DESC
          LIMIT 1`,
        [userid]
    );
    const row = result.rows[0] as StoredAssessment | undefined;
    return row ?? null;
}

// An assessment filled in before signing up (userid NULL) belongs to whoever
// logs in with the same email address.
export async function claimAssessments(userid: number, email: string): Promise<number> {
    const result = await pool.query(
        `UPDATE assessments
            SET userid = $1
          WHERE userid IS NULL AND lower(email) = lower($2)`,
        [userid, email]
    );
    return result.rowCount ?? 0;
}

// Newest first. Used by the /api/assessments endpoint and the Rust CLI.
export async function listAssessments(limit = 50): Promise<StoredAssessment[]> {
    const result = await pool.query(
        `SELECT assessment_id, userid, first_name, last_name, email,
                household_income, total_monthly, submitted_at
           FROM assessments
          ORDER BY submitted_at DESC
          LIMIT $1`,
        [limit]
    );
    return result.rows as StoredAssessment[];
}

// The expense buckets that belong to one assessment.
export async function getAssessmentExpenses(assessmentId: string): Promise<
    { category: string; amount: string; monthly_amount: string; frequency: string; detail: Record<string, unknown> }[]
> {
    const result = await pool.query(
        `SELECT category,
                amount,
                ROUND(amount * CASE frequency
                        WHEN 'yearly' THEN 1.0 / 12
                        WHEN 'weekly' THEN 52.0 / 12
                        ELSE 1.0
                    END, 2) AS monthly_amount,
                frequency,
                detail
           FROM assessment_expenses
          WHERE assessment_id = $1
          ORDER BY category`,
        [assessmentId]
    );
    return result.rows as {
        category: string;
        amount: string;
        monthly_amount: string;
        frequency: string;
        detail: Record<string, unknown>;
    }[];
}
