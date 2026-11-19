// MongoDB connection. Credentials come from mongo_connection_info.env next to this file.
// Same pattern as db_con.ts, but for the document store.

import { MongoClient, type Db } from 'mongodb';
import dotenv from 'dotenv';
import path from 'path';

// Local mongo config first, then the repo-root .env fills any gaps. dotenv
// never overwrites a key that is already set, so the local file wins over the
// root .env, and the real process environment wins over both.
dotenv.config({ path: path.resolve(__dirname, 'mongo_connection_info.env') });
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

// MONGO_URI wins; the repo-root .env's database_link is the fallback the owner
// filled in. Both casings are accepted.
const RAW_URI =
    process.env.MONGO_URI ||
    process.env.database_link ||
    process.env.DATABASE_LINK;

// Credentials can live in the link itself or in these separate keys. The keys
// win per field, so someone can keep the link's username and only override the
// password (or the other way round). Encoding both values also keeps passwords
// with @ : / ? # safe in the URI.
const URI_USER =
    process.env.MONGO_USER ||
    process.env.database_user_name ||
    process.env.DATABASE_USER_NAME;
const URI_PASS =
    process.env.MONGO_PASS ||
    process.env.database_password ||
    process.env.DATABASE_PASSWORD;

// Atlas copies its link with <db_username> / <db_password> placeholders, and
// people often blank the userinfo out (mongodb+srv://:@cluster/...) so the real
// pair can be filled in below. The driver refuses either form with
// "URI contained empty userinfo section", so blanks and placeholders count as
// "not set" here.
function cleanCredential(value?: string): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return '';
    if (/^<.*>$/.test(trimmed)) return '';
    return trimmed;
}

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

type UriParts = { scheme: string; user: string; pass: string; rest: string };

// Splits a mongodb:// link into scheme, userinfo and "everything after the @".
// The userinfo group is optional and may be empty, so blank links still parse.
function splitMongoUri(uri: string): UriParts | null {
    const match = /^(mongodb(?:\+srv)?:\/\/)(?:([^@/]*)@)?(.*)$/.exec(uri);
    if (!match) return null;
    const [, scheme = '', userinfo = '', rest = ''] = match;
    const colon = userinfo.indexOf(':');
    const user = colon === -1 ? userinfo : userinfo.slice(0, colon);
    const pass = colon === -1 ? '' : userinfo.slice(colon + 1);
    return { scheme, user: safeDecode(user), pass: safeDecode(pass), rest };
}

// Rebuilds the link with the credentials that are actually available. A link
// with no usable username loses its userinfo entirely so a local no-auth mongod
// connects instead of the driver choking on an empty userinfo section.
export function buildMongoUri(uri: string, user?: string, pass?: string): string {
    const parts = splitMongoUri(uri);
    if (!parts) return uri;
    const finalUser = cleanCredential(user) || cleanCredential(parts.user);
    const finalPass = cleanCredential(pass) || cleanCredential(parts.pass);
    if (!finalUser) return `${parts.scheme}${parts.rest}`;
    return `${parts.scheme}${encodeURIComponent(finalUser)}:${encodeURIComponent(finalPass)}@${parts.rest}`;
}

const MONGO_URI = RAW_URI ? buildMongoUri(RAW_URI, URI_USER, URI_PASS) : undefined;
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
            // Short selection timeout so the prototype router can fall back to
            // demo mode quickly when Mongo is down.
            //
            // NOTE: a reset during the TLS handshake (beforeHandshake: false) is
            // not a bad URI. School/guest wifi with client isolation resets
            // outbound 27017 traffic, and the dashboard is meant to run from the
            // workbook there. See README.md.
            const c = new MongoClient(MONGO_URI as string, {
                serverSelectionTimeoutMS: 2_000,
                connectTimeoutMS: 2_000,
            });
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
