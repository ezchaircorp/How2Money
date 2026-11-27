// Mongo startup: indexes, the demo user, and a demo profile on a fresh DB.
//
// Called once in the background when the server starts and by the workbook
// import script. A Mongo outage never blocks boot — the prototype router then
// falls back to demo mode.

import fs from 'node:fs';
import type { Collection, Document, IndexDescription } from 'mongodb';
import { getDb } from './db_mongo';
import { COLLECTIONS, SCHEMA_COLLECTIONS, type CollectionSpec, type UserDoc } from './schema';
import {
    hasPrototypeProfile,
    importProfileData,
} from './prototype_mongo_store';
import {
    demoSeedWorkbookPath,
    readProfileFromWorkbook,
} from './prototype_workbook_store';

const DEMO_USERNAME = 'demo';
const DEMO_EMAIL = 'demo@how2money.local';
const DEMO_DISPLAY_NAME = 'Demo';

// Indexes are idempotent, so re-running this on every boot is fine.
type IndexOptions = {
    unique?: boolean;
    sparse?: boolean;
    expireAfterSeconds?: number;
};

const OPTION_KEYS: Array<keyof IndexOptions> = ['unique', 'sparse', 'expireAfterSeconds'];

// Older versions of this project created some of these indexes without the
// unique flag. createIndex then stops startup with IndexKeySpecsConflict, so
// reconcile instead: when the same key pattern already exists with different
// options, drop it and recreate it the way we want.
async function ensureIndex(
    collection: Collection<Document>,
    key: Record<string, 1 | -1>,
    options: IndexOptions = {},
): Promise<void> {
    let existing: IndexDescription[] = [];
    try {
        existing = await collection.indexes();
    } catch {
        // A collection that does not exist yet has no indexes to reconcile.
    }

    const match = existing.find(index => {
        const entries = Object.entries(index.key as Record<string, number>);
        return entries.length === Object.keys(key).length
            && Object.entries(key).every(([field, direction]) =>
                entries.some(([name, value]) => name === field && value === direction)
            );
    });

    if (match?.name) {
        const same = OPTION_KEYS.every(option =>
            (match[option] as unknown) === (options[option] as unknown)
        );
        if (same) return;
        await collection.dropIndex(match.name);
    }

    await collection.createIndex(key, options);
}

// True when two collations compare text the same way.
function sameCollation(a: Document | undefined, b: Document | undefined): boolean {
    return (a?.locale ?? null) === (b?.locale ?? null) && (a?.strength ?? null) === (b?.strength ?? null);
}

// Creates any collection that has a default collation in schema.ts, so a new
// database starts out case-insensitive. A collection's collation cannot be
// changed after it is made, so an existing one without it is left alone and
// reported: database/migrate_users_collation.ts moves it over.
export async function ensureCollections(): Promise<CollectionSpec[]> {
    const db = await getDb();
    const outdated: CollectionSpec[] = [];
    for (const spec of SCHEMA_COLLECTIONS) {
        if (!spec.collation) continue;
        const [info] = await db.listCollections({ name: spec.name }).toArray();
        if (!info) {
            await db.createCollection(spec.name, { collation: spec.collation });
        } else if (!sameCollation((info as { options?: Document }).options?.collation, spec.collation)) {
            outdated.push(spec);
        }
    }
    return outdated;
}

// The indexes come from database/schema.ts, so adding one there is enough.
// Collections still waiting for the collation migration are skipped: their
// indexes would be built case-sensitive, and the migration builds them anyway.
export async function ensureIndexes(skip: CollectionSpec[] = []): Promise<void> {
    const db = await getDb();
    for (const spec of SCHEMA_COLLECTIONS) {
        if (skip.includes(spec)) continue;
        const collection = db.collection(spec.name);
        for (const index of spec.indexes) {
            await ensureIndex(collection, index.key, index.options ?? {});
        }
    }
}

async function seedDemoUser(): Promise<void> {
    const db = await getDb();
    const users = db.collection<UserDoc>(COLLECTIONS.users);
    await users.updateOne(
        { username: DEMO_USERNAME },
        {
            $set: {
                username: DEMO_USERNAME,
                email: DEMO_EMAIL,
                name: DEMO_DISPLAY_NAME,
            },
            $setOnInsert: { created_at: new Date() },
        },
        { upsert: true },
    );
}

// A fresh database with no prototype profile gets the checked-in sample so the
// dashboard shows charts immediately. An existing profile is never replaced.
async function seedDemoProfile(): Promise<void> {
    if (await hasPrototypeProfile()) return;

    const sample = demoSeedWorkbookPath();
    if (!fs.existsSync(sample)) return;

    const { data, displayName } = await readProfileFromWorkbook(sample);
    await importProfileData({ ...data, displayName });
    console.log(`Seeded the Mongo prototype profile from ${sample}`);
}

export async function initMongo(): Promise<void> {
    const outdated = await ensureCollections();
    await ensureIndexes(outdated);
    if (outdated.some(spec => spec.name === COLLECTIONS.users)) {
        // Leave the old users alone until the migration runs: writing the new
        // shape into the old collection would trip its old unique indexes.
        console.error(
            'The users collection is from before case-insensitive logins. Stop the server and run:\n' +
            '  node node_modules/tsx/dist/cli.mjs database/migrate_users_collation.ts\n' +
            'Until then, signing up may fail and logins are case-sensitive.'
        );
    } else {
        await seedDemoUser();
    }
    await seedDemoProfile();
}
