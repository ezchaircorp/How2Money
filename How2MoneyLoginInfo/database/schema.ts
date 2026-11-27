// The database schema, in one place.
//
// There is no ORM in this project: the stores talk to the `mongodb` driver
// directly. This file is the schema layer instead — every collection and its
// fields, defaults, references, and indexes, plus the TypeScript document
// types the stores use. mongo_init.ts builds the real indexes from here, so
// the schema and the running database cannot drift apart.
//
// Adding a collection or an index? Do it here. Adding a field? Add it here
// first, then to the store that writes it.

import type { CollationOptions, ObjectId } from 'mongodb';

/* ── Collection names ── */

export const COLLECTIONS = {
    users: 'users',
    sessions: 'sessions',
    profiles: 'profiles',
    transactions: 'transactions',
    spendEntries: 'spend_entries',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/* ── Collation ── */

// Case-insensitive comparison: "Jane" and "JANE" count as equal (strength 2
// ignores case but not accents). The users collection is created with this as
// its default collation, so every query and unique index on it ignores case
// without any extra code. Existing databases are moved over by
// database/migrate_users_collation.ts.
export const CASE_INSENSITIVE: CollationOptions = { locale: 'en', strength: 2 };

/* ── Document types ── */

export type Frequency = 'monthly' | 'yearly' | 'weekly';
export type SpendPeriod = 'week' | 'month';

export type UserDoc = {
    _id?: ObjectId;
    /** Display spelling, e.g. "Jane". Unique ignoring case (collection collation). */
    username: string;
    /** Stored lowercased. Unique ignoring case (collection collation). */
    email: string;
    /** Argon2id hash (older accounts: bcrypt, upgraded on next login). Absent on the seeded demo account. */
    password_hash?: string;
    name: string;
    created_at: Date;
};

export type SessionDoc = {
    _id?: ObjectId;
    /** Random token stored in the httpOnly cookie. */
    session_id: string;
    userid: ObjectId;
    expires_at: Date;
    created_at: Date;
};

/** One bucket row inside a profile document's `expenses` array. */
export type ProfileExpenseDoc = {
    category: string;
    amount: number;
    monthly_amount: number;
    frequency: Frequency;
    detail: Record<string, unknown>;
    updated_at: Date;
};

/** One planner row inside a profile document's `big_picture` array. */
export type ProfileBigPictureDoc = {
    category: string;
    amount: number;
    monthly_amount: number;
    frequency: Frequency;
    updated_at: Date;
};

export type ProfileDoc = {
    _id?: ObjectId;
    profile_key: string;
    /** Nullable on purpose: reserved for the future authenticated path. */
    userid: ObjectId | null;
    display_name: string;
    expenses: ProfileExpenseDoc[];
    big_picture: ProfileBigPictureDoc[];
    next_transaction_id?: number;
    created_at: Date;
    updated_at: Date;
};

export type TransactionDoc = {
    _id?: ObjectId;
    /** Numeric id, unique per profile — it is what the dashboard sends back. */
    transaction_id: number;
    profile_id: ObjectId | null;
    category: string;
    bucket: string;
    amount: number;
    /** YYYY-MM-DD. Kept as text so day arithmetic never shifts a timezone. */
    spent_on: string;
    note: string;
    recurring: boolean;
    created_at: Date;
};

export type SpendEntryDoc = {
    _id?: ObjectId;
    /** String form of the user's ObjectId, matching the session's userid. */
    userid: string;
    category: string;
    amount: number;
    period: SpendPeriod;
    /** YYYY-MM-DD window bounds. */
    period_start: string;
    period_end: string;
    created_at: Date;
};

/* ── Schema description ── */

export type FieldKind =
    | 'string'
    | 'number'
    | 'boolean'
    | 'date'
    | 'dateString'
    | 'objectId'
    | 'object'
    | 'array';

export type FieldSpec = {
    kind: FieldKind;
    required?: boolean;
    /** Human-readable default, e.g. `now` or `0`. */
    default?: string;
    /** Item kind for arrays, or a human note for `object`. */
    of?: string;
    /** Collection/field this points at. */
    ref?: string;
    note?: string;
};

export type IndexSpec = {
    key: Record<string, 1 | -1>;
    options?: {
        unique?: boolean;
        sparse?: boolean;
        expireAfterSeconds?: number;
    };
    note?: string;
};

export type CollectionSpec = {
    name: CollectionName;
    description: string;
    /** Default collation, set when the collection is created. */
    collation?: CollationOptions;
    fields: Record<string, FieldSpec>;
    indexes: IndexSpec[];
};

export const SCHEMA = {
    users: {
        name: COLLECTIONS.users,
        description:
            'One document per account. The demo account is seeded at startup. ' +
            'Created with a case-insensitive default collation, so lookups and uniqueness ignore case.',
        collation: CASE_INSENSITIVE,
        fields: {
            _id: { kind: 'objectId', note: 'Mongo id.' },
            username: { kind: 'string', required: true, note: 'Display spelling; unique ignoring case.' },
            email: { kind: 'string', required: true, note: 'Stored lowercased; unique ignoring case.' },
            password_hash: { kind: 'string', note: 'Argon2id hash (bcrypt on accounts not yet upgraded). Missing on the demo account.' },
            name: { kind: 'string', required: true, default: 'username' },
            created_at: { kind: 'date', required: true, default: 'now' },
        },
        indexes: [
            { key: { username: 1 }, options: { unique: true }, note: 'Case-insensitive via the collation.' },
            { key: { email: 1 }, options: { unique: true }, note: 'Case-insensitive via the collation.' },
        ],
    },
    sessions: {
        name: COLLECTIONS.sessions,
        description: 'One document per logged-in browser. Deleting it signs the user out.',
        fields: {
            _id: { kind: 'objectId', note: 'Mongo id.' },
            session_id: { kind: 'string', required: true, note: 'Random 32-byte base64url token.' },
            userid: { kind: 'objectId', required: true, ref: 'users._id' },
            expires_at: { kind: 'date', required: true, note: '30 days after login.' },
            created_at: { kind: 'date', required: true, default: 'now' },
        },
        indexes: [
            { key: { session_id: 1 }, options: { unique: true } },
            {
                key: { expires_at: 1 },
                options: { expireAfterSeconds: 0 },
                note: 'TTL index: Mongo drops expired sessions on its own.',
            },
        ],
    },
    profiles: {
        name: COLLECTIONS.profiles,
        description:
            'One document per profile. `prototype` holds the monthly setup and Big Picture arrays.',
        fields: {
            _id: { kind: 'objectId', note: 'Mongo id.' },
            profile_key: { kind: 'string', required: true, note: '`prototype` for the demo profile.' },
            userid: { kind: 'objectId', default: 'null', ref: 'users._id' },
            display_name: { kind: 'string', required: true },
            expenses: {
                kind: 'array',
                of: 'expense',
                default: '[]',
                note: 'Embedded bucket rows: category, amount, monthly_amount, frequency, detail, updated_at.',
            },
            big_picture: {
                kind: 'array',
                of: 'bigPicture',
                default: '[]',
                note: 'Embedded planner rows: category, amount, monthly_amount, frequency, updated_at.',
            },
            next_transaction_id: { kind: 'number', default: '1', note: 'Handed out to keep ids unique per profile.' },
            created_at: { kind: 'date', required: true, default: 'now' },
            updated_at: { kind: 'date', required: true, default: 'now' },
        },
        indexes: [{ key: { profile_key: 1 }, options: { unique: true } }],
    },
    transactions: {
        name: COLLECTIONS.transactions,
        description: 'One document per logged purchase, joined to its profile by profile_id.',
        fields: {
            _id: { kind: 'objectId', note: 'Mongo id.' },
            transaction_id: { kind: 'number', required: true, note: 'Numeric id, unique per profile.' },
            profile_id: { kind: 'objectId', required: true, ref: 'profiles._id' },
            category: { kind: 'string', required: true, note: 'Detail-field key, e.g. expense_food_fast_food.' },
            bucket: { kind: 'string', required: true, note: 'Parent bucket key, e.g. food.' },
            amount: { kind: 'number', required: true, note: 'Positive, rounded to cents.' },
            spent_on: { kind: 'dateString', required: true, default: 'today' },
            note: { kind: 'string', default: "''" },
            recurring: { kind: 'boolean', default: 'false' },
            created_at: { kind: 'date', required: true, default: 'now' },
        },
        indexes: [
            {
                key: { profile_id: 1, transaction_id: 1 },
                options: { unique: true },
                note: 'Guards id collisions when two adds race.',
            },
            { key: { profile_id: 1, spent_on: -1 }, note: 'Recent-first listing and stats ranges.' },
        ],
    },
    spend_entries: {
        name: COLLECTIONS.spendEntries,
        description:
            'What a signed-in user spent per category per budget window. Unused by the current pages.',
        fields: {
            _id: { kind: 'objectId', note: 'Mongo id.' },
            userid: { kind: 'string', required: true, ref: 'users._id', note: 'String id.' },
            category: { kind: 'string', required: true },
            amount: { kind: 'number', required: true, default: '0' },
            period: { kind: 'string', required: true, default: 'week', note: '`week` or `month`.' },
            period_start: { kind: 'dateString', required: true },
            period_end: { kind: 'dateString', required: true },
            created_at: { kind: 'date', required: true, default: 'now' },
        },
        indexes: [
            {
                key: { userid: 1, period: 1, period_start: 1, category: 1 },
                options: { unique: true },
                note: 'Makes the window-replace save idempotent.',
            },
        ],
    },
} satisfies Record<string, CollectionSpec>;

// Every collection, in a stable order.
export const SCHEMA_COLLECTIONS: CollectionSpec[] = Object.values(SCHEMA);

export function collectionSpec(name: CollectionName): CollectionSpec {
    const match = SCHEMA_COLLECTIONS.find(spec => spec.name === name);
    if (!match) throw new Error(`no schema for collection ${name}`);
    return match;
}

// Plain-JSON view of the schema, for docs or a quick `node database/schema.ts`.
export function describeSchema() {
    return SCHEMA_COLLECTIONS.map(spec => ({
        collection: spec.name,
        description: spec.description,
        fields: Object.entries(spec.fields).map(([field, def]) => ({
            field,
            ...def,
        })),
        indexes: spec.indexes.map(index => ({
            key: index.key,
            ...index.options,
            ...(index.note ? { note: index.note } : {}),
        })),
    }));
}

// `node node_modules/tsx/dist/cli.mjs database/schema.ts` prints the schema.
if (require.main === module) {
    console.log(JSON.stringify(describeSchema(), null, 2));
}
