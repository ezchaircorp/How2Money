// Login + signup backed by MongoDB.
//
// Passwords are hashed with Argon2id (see passwords.ts) and stored in `users`.
// Older accounts with bcrypt hashes still log in, and are moved to Argon2id
// the first time they do. The document shape matches the demo user the server
// seeds at startup, plus password_hash.

import { getDb } from './db_mongo';
import { hashPassword, needsRehash, verifyPassword } from './passwords';
import { COLLECTIONS, type UserDoc } from './schema';

const ALLOWED_DOMAINS = ['@gmail.com', '@hotmail.com', '@yahoo.com'];

export type User = { id: string; name: string; email: string };

export type Result =
    | { ok: true; user: User }
    | { ok: false; status: number; error: string };

export type StoredUserDoc = UserDoc;

function isValidEmail(email: string): boolean {
    // endsWith instead of includes, so "x@gmail.com.evil.com" is rejected
    return ALLOWED_DOMAINS.some(d => email.endsWith(d)) || email.endsWith('.edu');
}

export async function signup(
    username: string,
    email: string,
    password: string,
    confirm?: string
): Promise<Result> {
    username = username.trim();
    email = email.trim().toLowerCase();

    if (!username || !email || !password) {
        return { ok: false, status: 400, error: 'Name, email, and password are all required.' };
    }
    if (!isValidEmail(email)) {
        return { ok: false, status: 400, error: 'Please enter a valid email address.' };
    }
    if (password.length < 8) {
        return { ok: false, status: 400, error: 'Password must be at least 8 characters.' };
    }
    // Only checked if the page sends a confirm field
    if (confirm !== undefined && password !== confirm) {
        return { ok: false, status: 400, error: "Passwords aren't the same." };
    }

    const db = await getDb();
    const users = db.collection<StoredUserDoc>(COLLECTIONS.users);

    // The users collection ignores case (see CASE_INSENSITIVE in schema.ts),
    // so "Jane" here also finds "JANE" and "jane".
    if (await users.findOne({ email }, { projection: { _id: 1 } })) {
        return { ok: false, status: 409, error: 'That email is already registered.' };
    }
    if (await users.findOne({ username }, { projection: { _id: 1 } })) {
        return { ok: false, status: 409, error: 'That username already exists.' };
    }

    const hash = await hashPassword(password);
    let inserted;
    try {
        inserted = await users.insertOne({
            username,
            email,
            password_hash: hash,
            name: username,
            created_at: new Date(),
        });
    } catch (err) {
        // Two signups for the same name or email at the same moment: the
        // checks above both pass, and the unique index stops the second.
        if ((err as { code?: number })?.code === 11000) {
            return { ok: false, status: 409, error: 'That email or username is already registered.' };
        }
        throw err;
    }

    return { ok: true, user: { id: String(inserted.insertedId), name: username, email } };
}

export async function login(email: string, password: string): Promise<Result> {
    email = email.trim().toLowerCase();

    if (!email || !password) {
        return { ok: false, status: 400, error: 'Email and password are required.' };
    }

    const db = await getDb();
    const users = db.collection<StoredUserDoc>(COLLECTIONS.users);
    const user = await users.findOne({ email });

    // Same message whether the email is missing or the password is wrong,
    // so nobody can probe which emails are registered.
    if (!user?.password_hash || !(await verifyPassword(user.password_hash, password))) {
        return { ok: false, status: 401, error: 'Invalid email or password.' };
    }

    // The password is right. If it was stored with bcrypt (or older Argon2
    // settings), store it again as Argon2id. A failure here must not block
    // the login, so it is only logged.
    if (needsRehash(user.password_hash)) {
        try {
            await users.updateOne(
                { _id: user._id, password_hash: user.password_hash },
                { $set: { password_hash: await hashPassword(password) } },
            );
        } catch (err) {
            console.error('Could not upgrade a password hash to Argon2id:', err);
        }
    }

    return {
        ok: true,
        user: {
            id: String(user._id),
            name: user.username || user.name,
            email: user.email,
        },
    };
}
