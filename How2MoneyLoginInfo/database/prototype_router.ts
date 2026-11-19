// HTTP entry point for every /api/prototype/* route.
//
// Normal mode reads and writes MongoDB. If Mongo is unreachable — at startup
// or later — the router switches to the xlsx workbook and stays there until
// the process restarts ("demo mode"). That keeps the prototype dashboard
// usable without a database and stops half an outage from flipping back and
// forth between two data sets.

import type { Request, Response } from 'express';
import { getDb } from './db_mongo';
import { FORM_BUCKETS } from './expense_categories';
import {
    BIG_PICTURE_CATEGORIES,
    BUCKETS,
    PrototypeRequestError,
    isFrequency,
    isRealDay,
    profilePayload,
    roundCents,
    statsPayload,
    type BigPictureEntry,
    type MonthlySetupEntry,
    type NewTransaction,
    type PrototypeMode,
    type Row,
} from './prototype_model';
import {
    addTransaction as mongoAddTransaction,
    getProfileData as mongoProfileData,
    removeTransaction as mongoRemoveTransaction,
    replaceBigPicture as mongoReplaceBigPicture,
    replaceMonthlySetup as mongoReplaceMonthlySetup,
} from './prototype_mongo_store';
import {
    addTransaction as demoAddTransaction,
    getProfilePayload as demoProfilePayload,
    getStatsPayload as demoStatsPayload,
    removeTransaction as demoRemoveTransaction,
    saveBigPicture as demoSaveBigPicture,
    saveMonthlySetup as demoSaveMonthlySetup,
} from './prototype_workbook_store';

const FORCED_DEMO = process.env.H2M_DEMO === '1' || process.env.H2M_DEMO === 'true';

let mode: PrototypeMode | null = null;
let announcedFallback = false;

function asRecord(value: unknown): Row | null {
    return typeof value === 'object' && value !== null ? (value as Row) : null;
}

const BUCKET_KEYS = new Set(Object.keys(FORM_BUCKETS));
const BIG_PICTURE_KEYS = new Set<string>(BIG_PICTURE_CATEGORIES);
const CATEGORY_BY_BUCKET = new Map(BUCKETS.map(bucket => [bucket.bucket, bucket]));

function connectionProblem(err: unknown): boolean {
    const name = (err as { name?: string })?.name ?? '';
    if ([
        'MongoServerSelectionError',
        'MongoNetworkError',
        'MongoNetworkTimeoutError',
        'MongoTopologyClosedError',
        'MongoNotConnectedError',
        // Bad link / empty userinfo — the dashboard is better off on the
        // workbook than answering 500s until someone fixes the .env.
        'MongoParseError',
        'MongoInvalidArgumentError',
    ].includes(name)) {
        return true;
    }
    // Atlas answers blank or placeholder credentials with an auth error rather
    // than a network one, so count that as "can't use Mongo" too.
    const code = (err as { code?: number })?.code;
    return code === 18 || code === 13 || code === 8000;
}

async function currentMode(): Promise<PrototypeMode> {
    if (FORCED_DEMO) return 'demo';
    if (mode) return mode;

    try {
        await getDb();
        mode = 'mongo';
    } catch (err) {
        mode = 'demo';
        console.error(
            'Mongo is unreachable — prototype dashboard is in demo mode (xlsx). ' +
            'On school/guest wifi this is expected: client isolation resets Mongo connections. ' +
            'Use a hotspot, a local mongod, or H2M_DEMO=1.',
            err
        );
    }
    return mode;
}

function enterDemo(reason: unknown): void {
    mode = 'demo';
    if (!announcedFallback) {
        announcedFallback = true;
        console.error(
            'Mongo became unreachable — falling back to demo mode (xlsx). ' +
            '(School/guest wifi client isolation also looks like this.)',
            reason
        );
    }
}

// Runs one operation against the selected store. A Mongo connection failure
// retries once in demo mode; validation errors are passed straight through.
async function withBackend<T>(operation: (backend: PrototypeMode) => Promise<T>): Promise<{ mode: PrototypeMode; value: T }> {
    const selected = await currentMode();
    try {
        return { mode: selected, value: await operation(selected) };
    } catch (err) {
        if (selected === 'mongo' && connectionProblem(err)) {
            enterDemo(err);
            return { mode: 'demo', value: await operation('demo') };
        }
        throw err;
    }
}

/* ── Request parsing ── */

function readEntries(body: Row): Row[] {
    if (!Array.isArray(body.entries)) {
        throw new PrototypeRequestError(400, 'entries must be a list.');
    }
    return body.entries as Row[];
}

function validAmount(value: unknown): number {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new PrototypeRequestError(400, 'Amounts must be greater than zero.');
    }
    return roundCents(amount);
}

function rejectDuplicates(keys: string[]): void {
    if (new Set(keys).size !== keys.length) {
        throw new PrototypeRequestError(400, 'Each category can only be listed once.');
    }
}

function parseMonthlySetup(body: Row): MonthlySetupEntry[] {
    const entries = readEntries(body).map(item => {
        const entry = asRecord(item) ?? {};
        const bucket = String(entry.bucket ?? '');
        if (!BUCKET_KEYS.has(bucket)) {
            throw new PrototypeRequestError(400, 'Choose a valid category.');
        }
        const frequency = isFrequency(entry.frequency) ? entry.frequency : 'monthly';
        return { bucket, amount: validAmount(entry.amount), frequency };
    });
    rejectDuplicates(entries.map(entry => entry.bucket));
    return entries;
}

function parseBigPicture(body: Row): BigPictureEntry[] {
    const entries = readEntries(body).map(item => {
        const entry = asRecord(item) ?? {};
        const category = String(entry.category ?? '');
        if (!BIG_PICTURE_KEYS.has(category)) {
            throw new PrototypeRequestError(400, 'Choose a valid Big Picture category.');
        }
        if (entry.frequency !== 'monthly' && entry.frequency !== 'yearly') {
            throw new PrototypeRequestError(400, 'Choose a valid frequency.');
        }
        return {
            category,
            amount: validAmount(entry.amount),
            frequency: entry.frequency as 'monthly' | 'yearly',
        };
    });
    rejectDuplicates(entries.map(entry => entry.category));
    return entries;
}

function todayString(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate()
    ).padStart(2, '0')}`;
}

function parseTransaction(body: Row): NewTransaction {
    const bucket = String(body.bucket ?? '');
    const category = String(body.category ?? '');
    const definition = CATEGORY_BY_BUCKET.get(bucket);
    if (!definition) {
        throw new PrototypeRequestError(400, 'Choose a valid category.');
    }
    const categories = definition.detailFields.length ? definition.detailFields : [definition.bucket];
    if (!categories.includes(category)) {
        throw new PrototypeRequestError(400, 'Choose a valid category.');
    }

    const amount = validAmount(body.amount);
    if (body.spent_on !== undefined && body.spent_on !== null && body.spent_on !== '') {
        if (!isRealDay(body.spent_on)) {
            throw new PrototypeRequestError(400, 'Enter a valid date.');
        }
    }
    if (body.note !== undefined && typeof body.note !== 'string') {
        throw new PrototypeRequestError(400, 'The note must be text.');
    }
    const note = String(body.note ?? '').trim();
    if (note.length > 200) {
        throw new PrototypeRequestError(400, 'Keep the note to 200 characters.');
    }

    const recurring =
        body.recurring === true ||
        body.recurring === 'true' ||
        body.recurring === 1 ||
        body.recurring === '1' ||
        body.recurring === 'on';

    return {
        category,
        bucket,
        amount,
        spentOn: isRealDay(body.spent_on) ? body.spent_on : todayString(),
        note,
        recurring,
    };
}

function parseTransactionId(body: Row): string {
    const id = String(body.transaction_id ?? body.id ?? '');
    if (!/^\d+$/.test(id)) {
        throw new PrototypeRequestError(400, 'Pick a valid transaction.');
    }
    return id;
}

/* ── Response helpers ── */

function sendJson(res: Response, status: number, data: unknown): void {
    res.status(status).json(data);
}

/** Handles /api/prototype/* and returns false for any other URL. */
export async function handlePrototypeRequest(req: Request, res: Response): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/prototype/')) return false;

    try {
        if (req.method === 'GET' && url.pathname === '/api/prototype/profile') {
            const { mode: active, value } = await withBackend(async backend => {
                if (backend === 'mongo') {
                    return profilePayload(await mongoProfileData());
                }
                return demoProfilePayload();
            });
            sendJson(res, 200, { ok: true, mode: active, ...value });
            return true;
        }

        if (req.method === 'GET' && url.pathname === '/api/prototype/stats') {
            const period = typeof req.query.period === 'string' ? req.query.period : null;
            const { mode: active, value } = await withBackend(async backend => {
                if (backend === 'mongo') {
                    return statsPayload(await mongoProfileData(), period);
                }
                return demoStatsPayload(period);
            });
            sendJson(res, 200, { ok: true, mode: active, ...value });
            return true;
        }

        if (req.method === 'POST') {
            const body = asRecord(req.body) ?? {};

            if (url.pathname === '/api/prototype/transactions') {
                const input = parseTransaction(body);
                const { mode: active, value } = await withBackend(async backend => {
                    if (backend === 'mongo') {
                        await mongoAddTransaction(input);
                        return profilePayload(await mongoProfileData());
                    }
                    await demoAddTransaction(input);
                    return demoProfilePayload();
                });
                sendJson(res, 200, { ok: true, mode: active, ...value });
                return true;
            }

            if (url.pathname === '/api/prototype/transactions/remove') {
                const id = parseTransactionId(body);
                const { mode: active, value } = await withBackend(async backend => {
                    if (backend === 'mongo') {
                        if (!(await mongoRemoveTransaction(id))) {
                            throw new PrototypeRequestError(404, 'That transaction no longer exists.');
                        }
                        return profilePayload(await mongoProfileData());
                    }
                    if (!(await demoRemoveTransaction(id))) {
                        throw new PrototypeRequestError(404, 'That transaction no longer exists.');
                    }
                    return demoProfilePayload();
                });
                sendJson(res, 200, { ok: true, mode: active, ...value });
                return true;
            }

            if (url.pathname === '/api/prototype/monthly-setup') {
                const entries = parseMonthlySetup(body);
                const { mode: active, value } = await withBackend(async backend => {
                    if (backend === 'mongo') {
                        await mongoReplaceMonthlySetup(entries);
                        return profilePayload(await mongoProfileData());
                    }
                    await demoSaveMonthlySetup(entries);
                    return demoProfilePayload();
                });
                sendJson(res, 200, { ok: true, mode: active, ...value });
                return true;
            }

            if (url.pathname === '/api/prototype/big-picture') {
                const entries = parseBigPicture(body);
                const { mode: active, value } = await withBackend(async backend => {
                    if (backend === 'mongo') {
                        await mongoReplaceBigPicture(entries);
                        return profilePayload(await mongoProfileData());
                    }
                    await demoSaveBigPicture(entries);
                    return demoProfilePayload();
                });
                sendJson(res, 200, { ok: true, mode: active, ...value });
                return true;
            }

            sendJson(res, 404, { error: 'Not found.' });
            return true;
        }

        sendJson(res, 404, { error: 'Not found.' });
        return true;
    } catch (err) {
        if (err instanceof PrototypeRequestError) {
            sendJson(res, err.status, { error: err.message });
        } else {
            console.error('Prototype dashboard error:', err);
            sendJson(res, 500, { error: 'The prototype data could not be read or saved.' });
        }
    }
    return true;
}

export function prototypeMode(): PrototypeMode | null {
    return FORCED_DEMO ? 'demo' : mode;
}
