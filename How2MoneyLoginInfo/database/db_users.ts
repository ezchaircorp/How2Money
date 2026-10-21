// Query helpers for the web API. Kept separate from db_login.ts so the
// readline CLI keeps working exactly as it did before.
//
// NOTE ON PASSWORDS: the existing login_info table stores passwords as plain
// text and the CLI compares them directly. These helpers do the same so both
// paths stay consistent. Hashing is a known follow-up (see AGENTS.md).

import { pool } from './db_con';

export type LoginRow = {
    Username: string;
    Useremail: string;
    Password: string;
};

// Signup: refuse an email that's already registered, mirroring db_login.ts
export async function emailExists(email: string): Promise<boolean> {
    const match = await pool.query(
        'SELECT username FROM login_info WHERE useremail = $1',
        [email],
    );
    return match.rows.length > 0;
}

export async function createUser(name: string, email: string, password: string): Promise<LoginRow> {
    const inserted = await pool.query(
        'INSERT INTO login_info (Username, Password, Useremail) VALUES ($1, $2, $3) RETURNING Username, Useremail;',
        [name, password, email],
    );
    return inserted.rows[0] as LoginRow;
}

// Login: match on email + password, the same way the CLI matches user + password.
export async function findUserByEmailAndPassword(email: string, password: string): Promise<LoginRow | null> {
    const found = await pool.query(
        'SELECT Username, Useremail FROM login_info WHERE useremail = $1 AND Password = $2',
        [email, password],
    );
    return (found.rows[0] as LoginRow | undefined) ?? null;
}
