// Login + signup backed by MongoDB.
//
// Passwords are bcrypt-hashed (10 rounds) and stored in `users`. The document
// shape matches the demo user the server seeds at startup, plus password_hash.

import bcrypt from 'bcrypt';
import type { ObjectId } from 'mongodb';
import { getDb } from './db_mongo';

const ALLOWED_DOMAINS = ['@gmail.com', '@hotmail.com', '@yahoo.com'];
const SALT_ROUNDS = 10;

export type User = { id: string; name: string; email: string };

export type Result =
    | { ok: true; user: User }
    | { ok: false; status: number; error: string };

export type StoredUserDoc = {
    _id?: ObjectId;
    username: string;
    username_lower: string;
    email: string;
    email_lower: string;
    password_hash?: string;
    name: string;
    created_at: Date;
};

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
    const users = db.collection<StoredUserDoc>('users');

    if (await users.findOne({ email_lower: email }, { projection: { _id: 1 } })) {
        return { ok: false, status: 409, error: 'That email is already registered.' };
    }
    if (await users.findOne({ username_lower: username.toLowerCase() }, { projection: { _id: 1 } })) {
        return { ok: false, status: 409, error: 'That username already exists.' };
    }

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const inserted = await users.insertOne({
        username,
        username_lower: username.toLowerCase(),
        email,
        email_lower: email,
        password_hash: hash,
        name: username,
        created_at: new Date(),
    });

    return { ok: true, user: { id: String(inserted.insertedId), name: username, email } };
}

export async function login(email: string, password: string): Promise<Result> {
    email = email.trim().toLowerCase();

    if (!email || !password) {
        return { ok: false, status: 400, error: 'Email and password are required.' };
    }

    const db = await getDb();
    const user = await db.collection<StoredUserDoc>('users').findOne({ email_lower: email });

    // Same message whether the email is missing or the password is wrong,
    // so nobody can probe which emails are registered.
    if (!user?.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
        return { ok: false, status: 401, error: 'Invalid email or password.' };
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
