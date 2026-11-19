// HTTP API + static file server for the How2Money site.
//
// Run with:  node node_modules/tsx/dist/cli.mjs server.ts
// Serves:    html_files/ at http://localhost:3000
// Dashboard: reads and writes MongoDB. When Mongo is unreachable the prototype
//            router falls back to a local workbook (demo mode).
// API:       POST /api/signup            { name, email, password, confirm? }
//            POST /api/login             { email, password }
//            POST /api/logout
//            GET  /api/me                 -> the signed-in user
//            GET  /api/expense-weights    -> expense_weight.json + bucket mappings
//            GET  /api/spend?period=week|month      (Mongo-backed)
//            POST /api/spend                        (Mongo-backed)
//            /api/prototype/*            (Mongo, or xlsx demo fallback)
//
// Login/signup logic lives in database/mongo_auth.ts (bcrypt-hashed passwords).
// Sessions live in database/mongo_sessions.ts and ride along in an httpOnly cookie.

import express from 'express';
import path from 'path';

import { login, signup } from './database/mongo_auth';
import {
    SESSION_COOKIE,
    SESSION_TTL_DAYS,
    createSession,
    deleteSession,
    getSessionUser,
    purgeExpiredSessions,
} from './database/mongo_sessions';
import type { SessionUser } from './database/mongo_sessions';
import {
    ASSESSMENT_INSURANCE_DETAILS,
    BUCKET_DETAIL_FIELDS,
    BUCKET_LABELS,
    DETAIL_WEIGHTS,
    FORM_BUCKETS,
    loadExpenseCategories,
} from './database/expense_categories';
import { nextPeriodWindow } from './database/db_spend';
import type { Period, SpendEntryInput } from './database/db_spend';
import {
    listMongoSpendEntries,
    listMongoSpendEntriesForWindow,
    saveMongoSpendEntries,
} from './database/mongo_spend';
import { initMongo } from './database/mongo_init';
import { rateLimit } from './rate_limit';
import { handlePrototypeRequest } from './database/prototype_router';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// The static site lives one level up from this app.
const SITE_DIR = path.resolve(__dirname, '..', 'html_files');

app.use(express.json());

// The dashboard's data and charts. Mongo in normal mode, xlsx in demo mode.
app.use((req, res, next) => {
    handlePrototypeRequest(req, res).then(done => { if (!done) next(); }).catch(next);
});

/* ─────────────────────────────────────────────────
   SMALL HELPERS
──────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────
   SIGN UP / LOG IN
──────────────────────────────────────────────── */
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

            // Hand out a session cookie so the site knows who this is.
            const { token } = await createSession(result.user.id);
            startSession(res, token);
            await purgeExpiredSessions();

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

// Who am I? The assessment page uses this to show the signed-in note.
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

// Reference data for the assessment page's client-side calculations. Serves
// expense_weight.json straight from the repo root (via expense_categories.ts)
// plus the bucket/detail mappings, so the browser never keeps its own copy.
app.get('/api/expense-weights', (_req, res) => {
    try {
        const categories = loadExpenseCategories();

        const buckets: Record<string, {
            label: string;
            categories: string[];
            details: Array<{ field: string; category: string }>;
        }> = {};

        for (const [key, mapped] of Object.entries(FORM_BUCKETS)) {
            buckets[key] = {
                label: BUCKET_LABELS[key] ?? key,
                categories: mapped,
                // Shared breakdowns plus the assessment-only insurance fields.
                details: [
                    ...(BUCKET_DETAIL_FIELDS[key] ?? []).map(field => ({
                        field,
                        category: DETAIL_WEIGHTS[field] ?? mapped[0] ?? '',
                    })),
                    ...(ASSESSMENT_INSURANCE_DETAILS[key] ?? []),
                ],
            };
        }

        return res.json({
            ok: true,
            categories: categories.map(category => ({
                name: category.expense,
                description: category.description,
                weight: category.val,
                average: category.cost_per_month,
                estimated: category.estimated,
            })),
            buckets,
        });
    } catch (err) {
        console.error('expense weights failed:', err);
        return res.status(500).json({ ok: false, error: 'Could not load the expense reference data.' });
    }
});

/* ─────────────────────────────────────────────────
   SPENDING
   Kept for the future authenticated dashboard. The
   current pages do not call these routes yet.
──────────────────────────────────────────────── */
app.get('/api/spend', async (req, res) => {
    try {
        const user = await currentUser(req);
        if (!user) {
            return res.status(401).json({ ok: false, error: 'Not signed in.' });
        }

        const period = toPeriod(req.query.period);
        const window = nextPeriodWindow(period);
        const entries = await listMongoSpendEntriesForWindow(user.id, period, window);
        const history = await listMongoSpendEntries(user.id);

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

        // The assessment is client-side now, so accept any known bucket key.
        const allowed = new Set(Object.keys(FORM_BUCKETS));

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
        try {
            const saved = await saveMongoSpendEntries(user.id, period, window, entries);
            return res.json({
                ok: true,
                saved,
                period,
                period_start: window.start,
                period_end: window.end,
            });
        } catch (err) {
            // A failed save still answers politely instead of erroring the page
            // — the warning flag tells anyone watching the payload.
            console.error('spend save failed:', err);
            return res.json({
                ok: true,
                saved: 0,
                period,
                period_start: window.start,
                period_end: window.end,
                warning: 'Spending could not be saved right now. Try again shortly.',
            });
        }
    } catch (err) {
        console.error('spend save failed:', err);
        return res.status(500).json({ ok: false, error: 'Could not save your spending.' });
    }
});

/* ─────────────────────────────────────────────────
   STATIC SITE
──────────────────────────────────────────────── */
app.use(express.static(SITE_DIR));

app.get('/', (_req, res) => {
    res.sendFile(path.join(SITE_DIR, 'index.html'));
});

async function start(): Promise<void> {
    // Start serving before the database work. A slow or missing Mongo must not
    // block the static site; the prototype router falls back to demo mode.
    app.listen(PORT, () => {
        console.log(`How2Money server running at http://localhost:${PORT}`);
        console.log(`Serving site from ${SITE_DIR}`);
    });

    // Mongo: indexes, the demo user, and a seed profile on a fresh database.
    // Failure never blocks the server — the router switches to xlsx demo mode.
    initMongo()
        .then(() => {
            console.log('Mongo store ready — dashboard data and accounts live in MongoDB.');
        })
        .catch((err) => {
            const reset = /ECONNRESET|ETIMEDOUT|ENOTFOUND|MongoServerSelectionError|MongoNetworkError/i
                .test(String((err as { message?: string })?.message ?? err));
            console.error(
                'Mongo setup failed — the dashboard will run in demo mode from its workbook ' +
                'until Mongo is reachable. Check database/mongo_connection_info.env.'
            );
            if (reset) {
                // The usual cause at school: client-isolated wifi resets the
                // Atlas TLS handshake, so a perfectly good link still fails.
                console.error(
                    'If this is school/guest wifi, that is expected: client isolation blocks ' +
                    'MongoDB traffic (TLS reset on port 27017) even though the hostname resolves. ' +
                    'Use a phone hotspot or non-isolated network, point MONGO_URI at a local ' +
                    'mongod, or run with H2M_DEMO=1 to skip Mongo on purpose.'
                );
            }
            console.error(err);
        });
}

start().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
});
