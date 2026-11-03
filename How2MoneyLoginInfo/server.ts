// HTTP API + static file server for the How2Money site.
//
// Run with:  node node_modules/tsx/dist/cli.mjs server.ts
// Serves:    html_files/ at http://localhost:3000
// Prototype: the dashboard's shared profile lives in prototype_data_storage.xlsx,
//            so those routes work without Postgres.
// API:       POST /api/signup            { name, email, password, confirm? }
//            POST /api/login             { email, password }
//            POST /api/logout
//            GET  /api/me                 -> the signed-in user
//            GET  /api/profile            -> the assessment that belongs to them
//            POST /api/assessment-submit  (JSON)
//            GET  /api/spend?period=week|month
//            POST /api/spend
//            GET  /api/prototype/profile        (no login, shared profile)
//            GET  /api/prototype/stats          (no login, week/month/year charts)
//            POST /api/prototype/transactions   (no login, add one purchase)
//            POST /api/prototype/transactions/remove
//            POST /api/prototype/monthly-setup  (no login, replace expected amounts)
//            POST /api/prototype/big-picture    (no login, income, fixed costs, savings)
//            POST /api/prototype/expenses       (no login, add/update one bucket)
//            POST /api/prototype/expenses/remove
//
// All login/signup logic lives in database/db_login.ts (bcrypt-hashed passwords).
// Sessions live in database/db_sessions.ts and ride along in an httpOnly cookie.

import express from 'express';
import path from 'path';

import { login, signup } from './database/db_login';
import {
    SESSION_COOKIE,
    SESSION_TTL_DAYS,
    createSession,
    deleteSession,
    getSessionUser,
    purgeExpiredSessions,
} from './database/db_sessions';
import type { SessionUser } from './database/db_sessions';
import {
    claimAssessments,
    getAssessmentExpenses,
    getLatestAssessmentForUser,
    saveAssessment,
} from './database/db_assessments';
import type { AssessmentExpense } from './database/db_assessments';
import {
    BUCKET_DETAIL_FIELDS,
    BUCKET_LABELS,
    FORM_BUCKETS,
    bucketAverage,
    bucketWeight,
    monthlyMultiplier,
    syncExpenseCategories,
} from './database/expense_categories';
import { listSpendEntries, listSpendEntriesForWindow, nextPeriodWindow, saveSpendEntries } from './database/db_spend';
import type { Period, SpendEntryInput } from './database/db_spend';
import {
    BIG_PICTURE_CATEGORIES,
    addProfileTransaction,
    ensurePrototypeProfile,
    initPrototypeStore,
    listAllProfileTransactions,
    listBigPicture,
    listMonthlyActuals,
    listProfileExpenses,
    listProfileTransactions,
    removeProfileExpense,
    removeProfileTransaction,
    replaceBigPicture,
    replaceMonthlySetup,
    upsertProfileExpense,
} from './database/prototype_store';
import type {
    BigPictureInput,
    MonthlySetupInput,
    ProfileMonthlyActual,
    StoredBigPictureEntry,
    StoredProfile,
    StoredProfileExpense,
    StoredProfileTransaction,
} from './database/prototype_store';
import { buildPrototypeStats } from './database/prototype_stats';
import type { StatsPeriod } from './database/prototype_stats';
import { runMigrations } from './database/migrate';
import { rateLimit } from './rate_limit';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// The static site lives one level up from this app.
const SITE_DIR = path.resolve(__dirname, '..', 'html_files');

app.use(express.json());

/* ─────────────────────────────────────────────────
   SMALL HELPERS
───────────────────────────────────────────────── */
function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

// Express doesn't parse cookies without cookie-parser, and this app only
// needs one cookie, so read it straight off the header.
function readCookie(req: express.Request, name: string): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() === name) {
            return decodeURIComponent(part.slice(eq + 1).trim());
        }
    }
    return undefined;
}

function sessionToken(req: express.Request): string | undefined {
    return readCookie(req, SESSION_COOKIE);
}

// The signed-in user for this request, or null when there isn't one.
async function currentUser(req: express.Request): Promise<SessionUser | null> {
    return getSessionUser(sessionToken(req));
}

function startSession(res: express.Response, token: string): void {
    res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    });
}

function toPeriod(value: unknown): Period {
    return str(value) === 'month' ? 'month' : 'week';
}

function toStatsPeriod(value: unknown): StatsPeriod {
    const text = str(value);
    return text === 'week' || text === 'year' ? text : 'month';
}

const VALID_FREQUENCIES = new Set(['monthly', 'yearly', 'weekly']);
const BIG_PICTURE_CATEGORY_SET = new Set<string>(BIG_PICTURE_CATEGORIES);
const BIG_PICTURE_FREQUENCIES = new Set(['monthly', 'yearly']);

function round2(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

// Keep only the optional breakdown fields that belong to the bucket, and only
// when they hold a real number. Same rules the assessment form uses.
function pickDetail(bucket: string, value: unknown): Record<string, unknown> {
    const allowed = BUCKET_DETAIL_FIELDS[bucket] ?? [];
    const breakdown = asRecord(value) ?? {};
    const detail: Record<string, unknown> = {};

    for (const key of allowed) {
        const amount = Number(breakdown[key]);
        if (Number.isFinite(amount) && amount !== 0) {
            detail[key] = amount;
        }
    }

    return detail;
}

// A quick date-input check. The dashboard sends YYYY-MM-DD, so anything else
// is a bad request rather than something to guess at.
function dateString(value: unknown): string {
    const text = str(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
    const parsed = new Date(`${text}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? '' : text;
}

function todayString(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate()
    ).padStart(2, '0')}`;
}

// A transaction category is either the bucket itself (shopping, travel) or one
// of that bucket's optional breakdown fields (fast food, groceries, ...).
function transactionBucket(category: string, bucket: string): string | null {
    if (!(bucket in FORM_BUCKETS)) return null;
    if (category === bucket) return bucket;
    return (BUCKET_DETAIL_FIELDS[bucket] ?? []).includes(category) ? bucket : null;
}

function bigPictureResponse(entries: StoredBigPictureEntry[]) {
    const monthlyByCategory = new Map(
        entries.map(entry => [entry.category, Number(entry.monthly_amount) || 0])
    );
    const monthly = (category: string): number => monthlyByCategory.get(category) ?? 0;

    const income = monthly('income');
    const debtPayment = monthly('debt_payment');
    const schooling = monthly('schooling');
    const insurance = monthly('insurance');
    const savings = monthly('savings');
    const recurring = debtPayment + schooling + insurance;
    const budget = income - recurring - savings;

    return {
        entries: entries.map(entry => ({
            category: entry.category,
            amount: Number(entry.amount),
            monthly_amount: Number(entry.monthly_amount),
            frequency: entry.frequency,
            updated_at: entry.updated_at,
        })),
        totals: {
            income: round2(income),
            debt_payment: round2(debtPayment),
            schooling: round2(schooling),
            insurance: round2(insurance),
            recurring: round2(recurring),
            savings: round2(savings),
            budget: round2(budget),
            configured: entries.some(entry => Number(entry.amount) > 0),
        },
    };
}

// The full dashboard payload: the expected monthly setup, the actual spending
// for the current month, the recent individual transactions, and the Big
// Picture planner. Every mutate route returns this so the page can re-render
// from one response.
function prototypeProfileResponse(
    profile: StoredProfile,
    expenses: StoredProfileExpense[],
    actuals: ProfileMonthlyActual[],
    transactions: StoredProfileTransaction[],
    bigPicture: StoredBigPictureEntry[]
) {
    const expectedByBucket = new Map(expenses.map(e => [e.category, e]));
    const actualByBucket = new Map(actuals.map(a => [a.bucket, a]));

    const buckets = Object.entries(BUCKET_LABELS).map(([bucket, label]) => ({
        bucket,
        label,
        categories: FORM_BUCKETS[bucket] ?? [],
        weight: bucketWeight(bucket),
        average: bucketAverage(bucket),
        detailFields: BUCKET_DETAIL_FIELDS[bucket] ?? [],
    }));

    const monthly = buckets.map(b => {
        const expected = expectedByBucket.get(b.bucket);
        const actual = actualByBucket.get(b.bucket);

        return {
            bucket: b.bucket,
            label: b.label,
            categories: b.categories,
            weight: b.weight,
            expected: expected ? Number(expected.amount) : 0,
            frequency: expected?.frequency ?? 'monthly',
            expectedMonthly: expected ? Number(expected.monthly_amount) : 0,
            actual: actual ? Number(actual.actual) : 0,
            transactionCount: actual ? Number(actual.transaction_count) : 0,
            detail: expected?.detail ?? {},
            updated_at: expected?.updated_at ?? null,
        };
    });

    const expectedTotal = monthly.reduce((sum, m) => sum + m.expectedMonthly, 0);
    const actualTotal = monthly.reduce((sum, m) => sum + m.actual, 0);
    const transactionCount = monthly.reduce((sum, m) => sum + m.transactionCount, 0);
    const categoryCount = monthly.filter(m => m.expected > 0).length;

    return {
        ok: true,
        mode: 'prototype' as const,
        profile: {
            key: profile.profile_key,
            display_name: profile.display_name,
            category_count: categoryCount,
            total_monthly: expectedTotal.toFixed(2),
            actual_month: actualTotal.toFixed(2),
            transaction_count: transactionCount,
            updated_at: profile.updated_at,
        },
        buckets,
        monthly,
        big_picture: bigPictureResponse(bigPicture),
        transactions: transactions.map(t => ({
            id: t.transaction_id,
            category: t.category,
            bucket: t.bucket,
            amount: Number(t.amount),
            spent_on: t.spent_on,
            note: t.note,
            recurring: t.recurring,
            created_at: t.created_at,
        })),
    };
}

async function prototypePayload() {
    const profile = await ensurePrototypeProfile();
    const [expenses, actuals, transactions, bigPicture] = await Promise.all([
        listProfileExpenses(profile.profile_id),
        listMonthlyActuals(profile.profile_id),
        listProfileTransactions(profile.profile_id),
        listBigPicture(profile.profile_id),
    ]);
    return prototypeProfileResponse(profile, expenses, actuals, transactions, bigPicture);
}

/* ─────────────────────────────────────────────────
   SIGN UP / LOG IN
───────────────────────────────────────────────── */
app.post(
    '/api/signup',
    rateLimit({ windowMs: 60_000, max: 10, message: 'Too many accounts created from here. Try again in a minute.' }),
    async (req, res) => {
        const body = req.body ?? {};
        try {
            const result = await signup(
                str(body.name),
                str(body.email),
                str(body.password),
                typeof body.confirm === 'string' ? body.confirm : undefined
            );
            if (!result.ok) {
                return res.status(result.status).json({ ok: false, error: result.error });
            }
            return res.status(201).json({
                ok: true,
                message: `Welcome, ${result.user.name}! Your account has been created.`,
                user: result.user,
            });
        } catch (err) {
            console.error('signup failed:', err);
            return res.status(500).json({ ok: false, error: 'Something went wrong creating your account.' });
        }
    }
);

app.post(
    '/api/login',
    rateLimit({ windowMs: 60_000, max: 20, message: 'Too many sign-in attempts. Wait a minute and try again.' }),
    async (req, res) => {
        const body = req.body ?? {};
        try {
            const result = await login(str(body.email), str(body.password));
            if (!result.ok) {
                return res.status(result.status).json({ ok: false, error: result.error });
            }

            // Hand out a session cookie so the dashboard knows who this is.
            const { token } = await createSession(result.user.id);
            startSession(res, token);
            await purgeExpiredSessions();

            // An assessment filled in before signing up belongs to them now.
            await claimAssessments(result.user.id, result.user.email);

            return res.json({
                ok: true,
                message: `Welcome back, ${result.user.name}!`,
                user: result.user,
            });
        } catch (err) {
            console.error('login failed:', err);
            return res.status(500).json({ ok: false, error: 'Something went wrong signing you in.' });
        }
    }
);

app.post('/api/logout', async (req, res) => {
    try {
        await deleteSession(sessionToken(req));
        res.clearCookie(SESSION_COOKIE, { path: '/' });
        return res.json({ ok: true, message: 'Signed out.' });
    } catch (err) {
        console.error('logout failed:', err);
        return res.status(500).json({ ok: false, error: 'Something went wrong signing you out.' });
    }
});

// Who am I? The dashboard asks for this before it shows anything.
app.get('/api/me', async (req, res) => {
    try {
        const user = await currentUser(req);
        if (!user) {
            return res.status(401).json({ ok: false, error: 'Not signed in.' });
        }
        return res.json({ ok: true, user: { id: user.id, name: user.name, email: user.email } });
    } catch (err) {
        console.error('me failed:', err);
        return res.status(500).json({ ok: false, error: 'Could not check your session.' });
    }
});

/* ─────────────────────────────────────────────────
   THE DASHBOARD PROFILE
   Everything the person picked in the assessment.
───────────────────────────────────────────────── */
app.get('/api/profile', async (req, res) => {
    try {
        const user = await currentUser(req);
        if (!user) {
            return res.status(401).json({ ok: false, error: 'Not signed in.' });
        }

        const assessment = await getLatestAssessmentForUser(user.id);
        if (!assessment) {
            return res.status(404).json({ ok: false, error: 'No assessment yet.' });
        }

        const expenses = await getAssessmentExpenses(assessment.assessment_id);

        // Most important categories first — that is the order you want to
        // look at a budget in.
        const categories = expenses
            .map(e => ({
                bucket: e.category,
                label: BUCKET_LABELS[e.category] ?? e.category,
                categories: FORM_BUCKETS[e.category] ?? [],
                amount: Number(e.amount),
                monthlyAmount: Number(e.monthly_amount),
                frequency: e.frequency,
                weight: bucketWeight(e.category),
                average: bucketAverage(e.category),
                detail: e.detail ?? {},
            }))
            .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label));

        return res.json({
            ok: true,
            user: { name: user.name, email: user.email },
            assessment: {
                assessment_id: assessment.assessment_id,
                household_income: assessment.household_income,
                total_monthly: assessment.total_monthly,
                submitted_at: assessment.submitted_at,
            },
            categories,
        });
    } catch (err) {
        console.error('profile failed:', err);
        return res.status(500).json({ ok: false, error: 'Could not load your profile.' });
    }
});

/* ─────────────────────────────────────────────────
   PROTOTYPE PROFILE
   No login required. For now every visitor reads and
   writes the same shared profile, stored in the local
   prototype_data_storage.xlsx workbook.

   The Postgres-backed versions in database/db_profiles.ts
   are kept for the future login path. When login is wired
   up, these routes can resolve a real profile from the
   session user instead of always using the prototype
   profile; the response shape can stay the same.
 ───────────────────────────────────────────────── */
app.get('/api/prototype/profile', async (_req, res) => {
    try {
        return res.json(await prototypePayload());
    } catch (err) {
        console.error('prototype profile failed:', err);
        return res.status(500).json({ ok: false, error: 'Could not load the prototype profile.' });
    }
});

// Charts for the default stats view. Everything is computed from the workbook,
// so this still works when Postgres is down.
app.get('/api/prototype/stats', async (req, res) => {
    const period = toStatsPeriod(req.query.period);

    try {
        const profile = await ensurePrototypeProfile();
        const [expenses, transactions, bigPicture] = await Promise.all([
            listProfileExpenses(profile.profile_id),
            listAllProfileTransactions(profile.profile_id),
            listBigPicture(profile.profile_id),
        ]);

        const expectedByBucket: Record<string, number> = {};
        for (const expense of expenses) {
            expectedByBucket[expense.category] = Number(expense.monthly_amount) || 0;
        }

        const bigPictureTotals = bigPictureResponse(bigPicture).totals;
        const stats = buildPrototypeStats({
            period,
            transactions: transactions.map(transaction => ({
                bucket: transaction.bucket,
                amount: Number(transaction.amount),
                spent_on: transaction.spent_on,
                recurring: transaction.recurring,
            })),
            expectedByBucket,
            bigPictureBudget: bigPictureTotals.configured ? bigPictureTotals.budget : null,
            labels: BUCKET_LABELS,
        });

        return res.json({ ok: true, mode: 'prototype', ...stats });
    } catch (err) {
        console.error('prototype stats failed:', err);
        return res.status(500).json({ ok: false, error: 'Could not load spending stats.' });
    }
});

// Save one individual purchase. `category` is either a bucket (shopping,
// travel) or one of its breakdown fields (fast food, groceries, ...).
app.post('/api/prototype/transactions', async (req, res) => {
    const body = asRecord(req.body) ?? {};
    const category = str(body.category);
    const bucket = str(body.bucket);
    const validBucket = transactionBucket(category, bucket);

    if (!validBucket) {
        return res.status(400).json({ ok: false, error: 'Pick a valid transaction category.' });
    }

    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ ok: false, error: 'Enter an amount greater than zero.' });
    }

    const rawDate = str(body.spent_on);
    if (rawDate && !dateString(rawDate)) {
        return res.status(400).json({ ok: false, error: 'Enter a valid date (YYYY-MM-DD).' });
    }
    const spentOn = dateString(rawDate) || todayString();
    const note = str(body.note).trim().slice(0, 200);
    const recurring =
        body.recurring === true ||
        body.recurring === 'true' ||
        body.recurring === 1 ||
        body.recurring === '1' ||
        body.recurring === 'on';

    try {
        const profile = await ensurePrototypeProfile();
        await addProfileTransaction(profile.profile_id, {
            category,
            bucket: validBucket,
            amount,
            spentOn,
            note,
            recurring,
        });
        return res.json(await prototypePayload());
    } catch (err) {
        console.error('prototype transaction save failed:', err);
        return res.status(500).json({ ok: false, error: 'Could not save that transaction.' });
    }
});

app.post('/api/prototype/transactions/remove', async (req, res) => {
    const body = asRecord(req.body) ?? {};
    const transactionId = Number(body.transaction_id ?? body.id);

    if (!Number.isSafeInteger(transactionId) || transactionId <= 0) {
        return res.status(400).json({ ok: false, error: 'Pick a valid transaction.' });
    }

    try {
        const profile = await ensurePrototypeProfile();
        const removed = await removeProfileTransaction(profile.profile_id, String(transactionId));
        if (!removed) {
            return res.status(404).json({ ok: false, error: 'That transaction is not in the profile.' });
        }
        return res.json(await prototypePayload());
    } catch (err) {
        console.error('prototype transaction remove failed:', err);
        return res.status(500).json({ ok: false, error: 'Could not remove that transaction.' });
    }
});

// Replace the expected monthly setup in one save. Buckets that are omitted are
// removed, which is how clearing an input and saving actually clears it.
app.post('/api/prototype/monthly-setup', async (req, res) => {
    const body = asRecord(req.body) ?? {};
    if (!Array.isArray(body.entries)) {
        return res.status(400).json({ ok: false, error: 'Send an entries array.' });
    }

    const entries: MonthlySetupInput[] = [];
    for (const item of body.entries as unknown[]) {
        const entry = asRecord(item);
        if (!entry) continue;

        const bucket = str(entry.bucket);
        if (!(bucket in FORM_BUCKETS)) continue;

        const amount = Number(entry.amount);
        if (!Number.isFinite(amount) || amount <= 0) continue;

        const frequency = VALID_FREQUENCIES.has(str(entry.frequency))
            ? str(entry.frequency)
            : 'monthly';

        // A payload that repeats a bucket keeps the last value rather than
        // hitting the same conflict twice.
        const existing = entries.findIndex(e => e.bucket === bucket);
        if (existing >= 0) entries[existing] = { bucket, amount, frequency };
        else entries.push({ bucket, amount, frequency });
    }

    try {
        const profile = await ensurePrototypeProfile();
        await replaceMonthlySetup(profile.profile_id, entries);
        return res.json(await prototypePayload());
    } catch (err) {
        console.error('prototype monthly setup save failed:', err);
        return res.status(500).json({ ok: false, error: 'Could not save the monthly setup.' });
    }
});

// Replace the five Big Picture rows in one save. Amounts are entered monthly
// or yearly; the response carries the monthly-normalised totals and the
// resulting budget, which the Stats tab uses as its target.
app.post('/api/prototype/big-picture', async (req, res) => {
    const body = asRecord(req.body) ?? {};
    if (!Array.isArray(body.entries)) {
        return res.status(400).json({ ok: false, error: 'Send an entries array.' });
    }

    const entries: BigPictureInput[] = [];
    for (const item of body.entries as unknown[]) {
        const entry = asRecord(item);
        if (!entry) continue;

        const category = str(entry.category);
        if (!BIG_PICTURE_CATEGORY_SET.has(category)) continue;

        const amount = Number(entry.amount);
        if (!Number.isFinite(amount) || amount <= 0) continue;

        const frequency = str(entry.frequency);
        if (!BIG_PICTURE_FREQUENCIES.has(frequency)) {
            return res.status(400).json({ ok: false, error: 'Use a monthly or yearly frequency.' });
        }

        const existing = entries.findIndex(e => e.category === category);
        if (existing >= 0) entries[existing] = { category, amount, frequency };
        else entries.push({ category, amount, frequency });
    }

    try {
        const profile = await ensurePrototypeProfile();
        await replaceBigPicture(profile.profile_id, entries);
        return res.json(await prototypePayload());
    } catch (err) {
        console.error('prototype big picture save failed:', err);
        return res.status(500).json({ ok: false, error: 'Could not save the Big Picture.' });
    }
});

// Kept for the old single-bucket form; the dashboard now uses the bulk
// monthly-setup route above.
app.post('/api/prototype/expenses', async (req, res) => {
    const body = asRecord(req.body) ?? {};
    const bucket = str(body.bucket);

    if (!(bucket in FORM_BUCKETS)) {
        return res.status(400).json({ ok: false, error: 'Pick a valid expense category.' });
    }

    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ ok: false, error: 'Enter an amount greater than zero.' });
    }

    const frequency = VALID_FREQUENCIES.has(str(body.frequency)) ? str(body.frequency) : 'monthly';

    try {
        const profile = await ensurePrototypeProfile();
        await upsertProfileExpense(profile.profile_id, {
            bucket,
            amount,
            frequency,
            detail: pickDetail(bucket, body.detail),
        });
        return res.json(await prototypePayload());
    } catch (err) {
        console.error('prototype expense save failed:', err);
        return res.status(500).json({ ok: false, error: 'Could not save that expense.' });
    }
});

app.post('/api/prototype/expenses/remove', async (req, res) => {
    const body = asRecord(req.body) ?? {};
    const bucket = str(body.bucket);

    if (!(bucket in FORM_BUCKETS)) {
        return res.status(400).json({ ok: false, error: 'Pick a valid expense category.' });
    }

    try {
        const profile = await ensurePrototypeProfile();
        const removed = await removeProfileExpense(profile.profile_id, bucket);
        if (!removed) {
            return res.status(404).json({ ok: false, error: 'That expense is not in the profile.' });
        }
        return res.json(await prototypePayload());
    } catch (err) {
        console.error('prototype expense remove failed:', err);
        return res.status(500).json({ ok: false, error: 'Could not remove that expense.' });
    }
});

// Assessment submissions: the contact fields plus one entry per expense bucket.
app.post('/api/assessment-submit', async (req, res) => {
    const body = asRecord(req.body) ?? {};

    const firstName = str(body.firstName);
    const lastName = str(body.lastName);
    const email = str(body.email);
    const householdIncome = str(body.householdIncome);

    if (!firstName || !lastName || !email || !householdIncome) {
        return res.status(400).json({ ok: false, error: 'Name, email, and income are all required.' });
    }

    const raw = Array.isArray(body.expenses) ? (body.expenses as unknown[]) : [];
    const expenses: AssessmentExpense[] = [];

    for (const item of raw) {
        const entry = asRecord(item);
        if (!entry) continue;

        const bucket = str(entry.bucket);
        // Anything that isn't one of the form's buckets is ignored.
        if (!bucket || !(bucket in FORM_BUCKETS)) continue;

        const amount = Number(entry.amount);
        if (!Number.isFinite(amount) || amount <= 0) continue;

        const frequency = str(entry.frequency) || 'monthly';

        // Only keep the breakdown fields that belong to this bucket.
        const detail: Record<string, unknown> = {};
        const allowed = BUCKET_DETAIL_FIELDS[bucket] ?? [];
        const breakdown = asRecord(entry.detail) ?? {};
        for (const key of allowed) {
            const value = Number(breakdown[key]);
            if (Number.isFinite(value) && value !== 0) {
                detail[key] = value;
            }
        }

        expenses.push({
            bucket,
            amount,
            monthlyAmount: amount * monthlyMultiplier(frequency),
            frequency,
            detail,
        });
    }

    if (expenses.length === 0) {
        return res.status(400).json({ ok: false, error: 'Add at least one expense amount before submitting.' });
    }

    try {
        const user = await currentUser(req);
        const assessmentId = await saveAssessment({
            userid: user?.id ?? null,
            firstName,
            lastName,
            email,
            householdIncome,
            expenses,
        });

        return res.json({
            ok: true,
            message: 'Your assessment has been submitted. A How2Money advisor will contact you within one business day.',
            assessment_id: assessmentId,
            signedIn: Boolean(user),
        });
    } catch (err) {
        console.error('assessment submit failed:', err);
        return res.status(500).json({ ok: false, error: 'Something went wrong saving your assessment.' });
    }
});

/* ─────────────────────────────────────────────────
   SPENDING
   What the person actually spent, for the window the
   dashboard shows (next week / next month).
───────────────────────────────────────────────── */
app.get('/api/spend', async (req, res) => {
    try {
        const user = await currentUser(req);
        if (!user) {
            return res.status(401).json({ ok: false, error: 'Not signed in.' });
        }

        const period = toPeriod(req.query.period);
        const window = nextPeriodWindow(period);
        const entries = await listSpendEntriesForWindow(user.id, period);
        const history = await listSpendEntries(user.id);

        return res.json({
            ok: true,
            period,
            period_start: window.start,
            period_end: window.end,
            entries,
            history,
        });
    } catch (err) {
        console.error('spend list failed:', err);
        return res.status(500).json({ ok: false, error: 'Could not load your spending.' });
    }
});

app.post('/api/spend', async (req, res) => {
    try {
        const user = await currentUser(req);
        if (!user) {
            return res.status(401).json({ ok: false, error: 'Not signed in.' });
        }

        // Only the categories they actually picked in their assessment.
        const assessment = await getLatestAssessmentForUser(user.id);
        if (!assessment) {
            return res.status(400).json({ ok: false, error: 'Finish your assessment before logging spending.' });
        }
        const planned = await getAssessmentExpenses(assessment.assessment_id);
        const allowed = new Set(planned.map(p => p.category));

        const body = asRecord(req.body) ?? {};
        const period = toPeriod(body.period);
        const raw = Array.isArray(body.entries) ? (body.entries as unknown[]) : [];

        const entries: SpendEntryInput[] = [];
        for (const item of raw) {
            const entry = asRecord(item);
            if (!entry) continue;

            const category = str(entry.category);
            if (!allowed.has(category)) continue;

            const amount = Number(entry.amount);
            if (!Number.isFinite(amount) || amount < 0) continue;

            entries.push({ category, amount });
        }

        const window = nextPeriodWindow(period);
        const saved = await saveSpendEntries(user.id, period, window, entries);

        return res.json({
            ok: true,
            saved,
            period,
            period_start: window.start,
            period_end: window.end,
        });
    } catch (err) {
        console.error('spend save failed:', err);
        return res.status(500).json({ ok: false, error: 'Could not save your spending.' });
    }
});

/* ─────────────────────────────────────────────────
   STATIC SITE
───────────────────────────────────────────────── */
app.use(express.static(SITE_DIR));

app.get('/', (_req, res) => {
    res.sendFile(path.join(SITE_DIR, 'index.html'));
});

async function start(): Promise<void> {
    try {
        const storage = await initPrototypeStore();
        console.log(`Prototype dashboard storage: ${storage}`);
    } catch (err) {
        console.error('Prototype dashboard storage setup failed:', err);
    }

    // Start serving before the database work. A missing or slow Postgres must
    // never block the static site or the prototype dashboard, which only need
    // the workbook above.
    app.listen(PORT, () => {
        console.log(`How2Money server running at http://localhost:${PORT}`);
        console.log(`Serving site from ${SITE_DIR}`);
    });

    try {
        await runMigrations({ quiet: true });
        await syncExpenseCategories();
    } catch (err) {
        // Keep serving the site even when the database is unreachable — the
        // pages still load, and the prototype dashboard keeps working from
        // its Excel file. Login/assessment routes need Postgres.
        console.error(
            'Database setup failed — login/assessment APIs will error until Postgres is reachable. ' +
                'The prototype dashboard still uses prototype_data_storage.xlsx.',
            err
        );
    }
}

start().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
});
