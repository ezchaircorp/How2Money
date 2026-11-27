// One-time migration: case-insensitive users collection.
//
// Moves an existing `users` collection to the shape in schema.ts:
//   - a case-insensitive default collation, so lookups and uniqueness ignore case
//   - no more email_lower / username_lower fields (and their indexes)
//   - emails stored lowercased
// Every user keeps the same _id, so sessions and profiles still point at them.
//
// From How2MoneyLoginInfo, with the server STOPPED:
//   node node_modules/tsx/dist/cli.mjs database/migrate_users_collation.ts           (dry run: report only)
//   node node_modules/tsx/dist/cli.mjs database/migrate_users_collation.ts --apply   (make the change)
//
// --apply first copies every user into users_backup_<timestamp>. If anything
// fails after that, the original users are put back from the copy. Delete the
// backup collection yourself once you are happy.

import type { Db, Document } from 'mongodb';
import { closeMongo, getDb } from './db_mongo';
import { CASE_INSENSITIVE, COLLECTIONS, collectionSpec } from './schema';

const USERS = COLLECTIONS.users;
const OLD_FIELDS = ['email_lower', 'username_lower'] as const;

type Plan = {
    users: Document[];
    hasCollation: boolean;
    oldFieldCount: number;
    oldIndexes: string[];
    emailsToLowercase: number;
    problems: string[];
};

// Same rule as the collation: compare ignoring case.
const fold = (value: unknown) => String(value ?? '').trim().toLocaleLowerCase('en');

function duplicates(users: Document[], field: 'email' | 'username'): string[] {
    const groups = new Map<string, Document[]>();
    for (const user of users) {
        const key = fold(user[field]);
        groups.set(key, [...(groups.get(key) ?? []), user]);
    }
    return [...groups.entries()]
        .filter(([, group]) => group.length > 1)
        .map(([key, group]) =>
            `${group.length} users share the ${field} "${key}" (ignoring case): ` +
            group.map(user => String(user._id)).join(', ')
        );
}

async function makePlan(db: Db): Promise<Plan | null> {
    const [info] = await db.listCollections({ name: USERS }).toArray();
    if (!info) return null;

    const collation = (info as { options?: Document }).options?.collation;
    const users = await db.collection(USERS).find().toArray();
    const indexes = await db.collection(USERS).indexes();

    const problems = [...duplicates(users, 'email'), ...duplicates(users, 'username')];
    for (const user of users) {
        if (!String(user.email ?? '').trim()) problems.push(`user ${String(user._id)} has no email`);
        if (!String(user.username ?? '').trim()) problems.push(`user ${String(user._id)} has no username`);
    }

    return {
        users,
        hasCollation:
            collation?.locale === CASE_INSENSITIVE.locale && collation?.strength === CASE_INSENSITIVE.strength,
        oldFieldCount: users.filter(user => OLD_FIELDS.some(field => field in user)).length,
        oldIndexes: indexes
            .map(index => index.name ?? '')
            .filter(name => OLD_FIELDS.some(field => name.startsWith(field))),
        emailsToLowercase: users.filter(user => typeof user.email === 'string' && user.email !== fold(user.email))
            .length,
        problems,
    };
}

function cleaned(user: Document): Document {
    const copy: Document = { ...user };
    for (const field of OLD_FIELDS) delete copy[field];
    if (typeof copy.email === 'string') copy.email = fold(copy.email);
    if (typeof copy.username === 'string') copy.username = copy.username.trim();
    return copy;
}

async function rebuildUsers(db: Db, users: Document[]): Promise<void> {
    await db.collection(USERS).drop().catch(() => undefined);
    await db.createCollection(USERS, { collation: CASE_INSENSITIVE });
    const collection = db.collection(USERS);
    if (users.length) await collection.insertMany(users, { ordered: true });
    for (const index of collectionSpec(USERS).indexes) {
        await collection.createIndex(index.key, index.options ?? {});
    }
}

async function main(): Promise<number> {
    const apply = process.argv.includes('--apply');
    const db = await getDb();
    console.log(`Database: ${db.databaseName}${apply ? '' : '  (dry run: nothing will change)'}\n`);

    const plan = await makePlan(db);
    if (!plan) {
        console.log('There is no users collection yet. The server creates it the right way on startup.');
        return 0;
    }

    console.log(`Users:                         ${plan.users.length}`);
    console.log(`Case-insensitive already:      ${plan.hasCollation ? 'yes' : 'no'}`);
    console.log(`Users with *_lower fields:     ${plan.oldFieldCount}`);
    console.log(`Old *_lower indexes:           ${plan.oldIndexes.join(', ') || 'none'}`);
    console.log(`Emails with capital letters:   ${plan.emailsToLowercase}`);

    if (plan.problems.length) {
        console.log('\nThese must be fixed by hand first (the new unique indexes would refuse them):');
        for (const problem of plan.problems) console.log(`  - ${problem}`);
        return 1;
    }

    if (plan.hasCollation && !plan.oldFieldCount && !plan.oldIndexes.length && !plan.emailsToLowercase) {
        console.log('\nNothing to do: users is already migrated.');
        return 0;
    }

    if (!apply) {
        console.log('\nNo problems found. Stop the server, then run again with --apply to migrate.');
        return 0;
    }

    // 1. Back up every user, and check the copy is complete.
    const backup = `${USERS}_backup_${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}`;
    if (plan.users.length) await db.collection(backup).insertMany(plan.users, { ordered: true });
    const backedUp = await db.collection(backup).countDocuments();
    if (backedUp !== plan.users.length) {
        throw new Error(`backup ${backup} has ${backedUp} users, expected ${plan.users.length}; nothing was changed`);
    }
    console.log(`\nBacked up ${backedUp} users to ${backup}.`);

    // 2. Rebuild users with the collation; put the originals back on failure.
    try {
        await rebuildUsers(db, plan.users.map(cleaned));
        const count = await db.collection(USERS).countDocuments();
        if (count !== plan.users.length) throw new Error(`users has ${count} documents, expected ${plan.users.length}`);
    } catch (err) {
        console.error('\nMigration failed, restoring the original users from the backup...');
        await db.collection(USERS).drop().catch(() => undefined);
        if (plan.users.length) await db.collection(USERS).insertMany(plan.users, { ordered: true });
        console.error(
            `Restored ${await db.collection(USERS).countDocuments()} users. ` +
            'The old indexes are rebuilt when the old server code starts.'
        );
        throw err;
    }

    console.log(`Migrated ${plan.users.length} users: case-insensitive, *_lower fields removed.`);
    console.log(`When everything works, delete the backup collection ${backup}.`);
    return 0;
}

main()
    .then(code => { process.exitCode = code; })
    .catch(err => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => closeMongo());
