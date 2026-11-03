// Login + signup logic for the website. Passwords are hashed with bcrypt.
// server.ts calls these; nothing in here reads from the terminal.

import bcrypt from 'bcrypt';
import { pool } from './db_con';

const ALLOWED_DOMAINS = ['@gmail.com', '@hotmail.com', '@yahoo.com'];
const SALT_ROUNDS = 10;

export type User = { id: number; name: string; email: string };

export type Result =
    | { ok: true; user: User }
    | { ok: false; status: number; error: string };

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

    const emailTaken = await pool.query('SELECT 1 FROM login_info WHERE useremail = $1', [email]);
    if (emailTaken.rows.length > 0) {
        return { ok: false, status: 409, error: 'That email is already registered.' };
    }

    const userTaken = await pool.query('SELECT 1 FROM login_info WHERE username = $1', [username]);
    if (userTaken.rows.length > 0) {
        return { ok: false, status: 409, error: 'That username already exists.' };
    }

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const inserted = await pool.query(
        'INSERT INTO login_info (username, password, useremail) VALUES ($1, $2, $3) RETURNING userid',
        [username, hash, email]
    );

    return { ok: true, user: { id: inserted.rows[0]!.userid, name: username, email } };
}

export async function login(email: string, password: string): Promise<Result> {
    email = email.trim().toLowerCase();

    if (!email || !password) {
        return { ok: false, status: 400, error: 'Email and password are required.' };
    }

    const result = await pool.query(
        'SELECT userid, username, password, useremail FROM login_info WHERE useremail = $1',
        [email]
    );
    const row = result.rows[0] as
        | { userid: number; username: string; password: string; useremail: string }
        | undefined;

    // Same message whether the email is missing or the password is wrong,
    // so nobody can probe which emails are registered
    if (!row || !(await bcrypt.compare(password, row.password))) {
        return { ok: false, status: 401, error: 'Invalid email or password.' };
    }

    return { ok: true, user: { id: row.userid, name: row.username, email: row.useremail } };
}