// Migration runner.
//
// Applies every SQL file in ../migrations that hasn't run yet, in filename
// order, each inside its own transaction. Applied versions are recorded in
// schema_migrations so re-running is a no-op.
//
//   npx tsx database/migrate.ts            apply anything outstanding
//   npx tsx database/migrate.ts --reset    drop everything and re-apply
//   npx tsx database/migrate.ts --status   list applied vs pending
//
// The server also calls runMigrations() on startup, so this file is mostly
// useful on its own when you're poking at the database by hand.

import fs from 'fs';
import path from 'path';
import { pool } from './db_con';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

// Arbitrary but fixed key for the advisory lock that keeps two containers
// starting at the same time from applying the same migration twice.
const MIGRATION_LOCK_KEY = 841_233_001;

export type MigrationFile = {
    version: string;
    name: string;
    filename: string;
    sql: string;
};

export function readMigrations(): MigrationFile[] {
    if (!fs.existsSync(MIGRATIONS_DIR)) return [];
    return fs
        .readdirSync(MIGRATIONS_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort()
        .map(filename => {
            const [version, ...rest] = filename.replace(/\.sql$/, '').split('_');
            return {
                version: version ?? filename,
                name: rest.join('_'),
                filename,
                sql: fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8'),
            };
        });
}

async function ensureMigrationsTable(): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version    TEXT PRIMARY KEY,
            filename   TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
}

async function appliedVersions(): Promise<Set<string>> {
    const res = await pool.query('SELECT version FROM schema_migrations');
    return new Set(res.rows.map((r: { version: string }) => r.version));
}

export async function runMigrations(options: { quiet?: boolean } = {}): Promise<number> {
    const log = options.quiet ? () => {} : (msg: string) => console.log(msg);
    const migrations = readMigrations();

    const client = await pool.connect();
    let count = 0;
    try {
        // Serialise migrations across processes, so two containers starting at
        // the same time don't both try to apply 001.
        await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

        await ensureMigrationsTable();
        const done = await appliedVersions();

        for (const m of migrations) {
            if (done.has(m.version)) {
                log(`  skip   ${m.filename} (already applied)`);
                continue;
            }
            try {
                await client.query('BEGIN');
                await client.query(m.sql);
                await client.query(
                    'INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)',
                    [m.version, m.filename]
                );
                await client.query('COMMIT');
                log(`  apply  ${m.filename}`);
                count++;
            } catch (err) {
                await client.query('ROLLBACK');
                console.error(`  FAIL   ${m.filename}: ${(err as Error).message}`);
                throw err;
            }
        }
    } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
        client.release();
    }

    if (!options.quiet) {
        console.log(
            count === 0
                ? 'Database is up to date — nothing to apply.'
                : `Applied ${count} migration(s).`
        );
    }
    return count;
}

async function reset(migrations: MigrationFile[]): Promise<void> {
    console.log('Dropping every table in the public schema...');
    await pool.query(`
        DROP SCHEMA public CASCADE;
        CREATE SCHEMA public;
    `);
    await runMigrations({ quiet: true });
    console.log(`Re-applied ${migrations.length} migration(s).`);
}

async function status(migrations: MigrationFile[]): Promise<void> {
    await ensureMigrationsTable();
    const done = await appliedVersions();
    console.log('\nMigrations:');
    for (const m of migrations) {
        console.log(`  ${done.has(m.version) ? 'applied' : ' pending'}  ${m.filename}`);
    }
    console.log('');
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const migrations = readMigrations();

    if (args.includes('--reset')) {
        await reset(migrations);
    } else if (args.includes('--status')) {
        await status(migrations);
    } else {
        await runMigrations();
    }
}

// Only run the CLI when this file is the entry point; the server imports
// runMigrations() instead.
if (require.main === module) {
    main()
        .then(() => pool.end())
        .catch(async (err) => {
            console.error(err);
            await pool.end().catch(() => {});
            process.exit(1);
        });
}
