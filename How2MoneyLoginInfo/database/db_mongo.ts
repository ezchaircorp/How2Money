// MongoDB connection. Credentials come from mongo_connection_info.env next to this file.
// Same pattern as db_con.ts, but for the document store.

import { MongoClient, type Db } from 'mongodb';
import dotenv from 'dotenv';
import path from 'path';

// Repo-root .env (the owner's database_link lives there), then the local
// mongo config, which wins when both define the same key.
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
dotenv.config({ path: path.resolve(__dirname, 'mongo_connection_info.env') });

// MONGO_URI wins; the repo-root .env's database_link is the fallback the owner
// filled in. Both casings are accepted.
const MONGO_URI =
    process.env.MONGO_URI ||
    process.env.database_link ||
    process.env.DATABASE_LINK;
// Optional override; when unset the driver uses the database name embedded in the URI.
const DB_NAME = process.env.MONGO_DB_NAME;

let client: MongoClient | null = null;
let connectPromise: Promise<Db> | null = null;

// Lazily connects and hands back the Db handle. The first caller starts the
// connection; everyone after that reuses the same promise, so calling this per
// request is fine.
export async function getDb(): Promise<Db> {
    if (!MONGO_URI) {
        throw new Error(
            'MONGO_URI is not set — add it to database/mongo_connection_info.env',
        );
    }
    if (!connectPromise) {
        // If the first attempt fails (mongod down, bad URI) forget the rejected
        // promise so the next caller retries instead of getting the same error forever.
        connectPromise = (async () => {
            const c = new MongoClient(MONGO_URI as string);
            await c.connect();
            client = c;
            // Ping so a bad URI/host fails here instead of on the first query.
            await c.db().command({ ping: 1 });
            return DB_NAME ? c.db(DB_NAME) : c.db();
        })().catch((err) => {
            connectPromise = null;
            throw err;
        });
    }
    return connectPromise;
}

// Closes the connection and forgets it, so a later getDb() reconnects fresh.
// Useful for tests and for a graceful-shutdown hook when the server learns to close things.
export async function closeMongo(): Promise<void> {
    connectPromise = null;
    if (client) {
        await client.close();
        client = null;
    }
}
