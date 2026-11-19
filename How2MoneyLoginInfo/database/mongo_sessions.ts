// Login sessions backed by MongoDB.
//
// A session is a random token stored in an httpOnly cookie. The matching
// document in `sessions` is what makes the token valid — clearing the cookie
// alone doesn't sign anyone out, so logout deletes the document too.
// A TTL index on expires_at lets Mongo clean up old sessions.

import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import { getDb } from './db_mongo';

export const SESSION_COOKIE = 'h2m_session';
export const SESSION_TTL_DAYS = 30;

export type SessionUser = { id: string; name: string; email: string };

type SessionDoc = {
    session_id: string;
    userid: ObjectId;
    expires_at: Date;
    created_at: Date;
};

type SessionUserDoc = {
    _id?: ObjectId;
    username: string;
    name?: string;
    email: string;
};

export async function createSession(userid: string): Promise<{ token: string; expiresAt: Date }> {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

    if (!ObjectId.isValid(userid)) {
        throw new Error('createSession needs a MongoDB user id');
    }

    const db = await getDb();
    await db.collection<SessionDoc>('sessions').insertOne({
        session_id: token,
        userid: new ObjectId(userid),
        expires_at: expiresAt,
        created_at: new Date(),
    });

    return { token, expiresAt };
}

// Returns the logged-in user for a token, or null when there isn't one.
export async function getSessionUser(token: string | undefined): Promise<SessionUser | null> {
    if (!token) return null;

    const db = await getDb();
    const session = await db.collection<SessionDoc>('sessions').findOne({
        session_id: token,
        expires_at: { $gt: new Date() },
    });
    if (!session) return null;

    const user = await db.collection<SessionUserDoc>('users').findOne({ _id: session.userid });
    if (!user?._id) return null;

    return {
        id: String(user._id),
        name: user.username || user.name || '',
        email: user.email,
    };
}

export async function deleteSession(token: string | undefined): Promise<void> {
    if (!token) return;
    const db = await getDb();
    await db.collection<SessionDoc>('sessions').deleteOne({ session_id: token });
}

// Housekeeping: drop sessions that have expired. Called on login so it
// doesn't need a background job. The TTL index also handles this eventually.
export async function purgeExpiredSessions(): Promise<void> {
    const db = await getDb();
    await db.collection<SessionDoc>('sessions').deleteMany({ expires_at: { $lte: new Date() } });
}
