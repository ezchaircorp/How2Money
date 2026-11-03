// Login sessions.
//
// A session is a random token stored in an httpOnly cookie. The matching row
// in the sessions table is what makes the token valid — clearing the cookie
// alone doesn't sign anyone out, so logout deletes the row too.

import crypto from 'crypto';
import { pool } from './db_con';

export const SESSION_COOKIE = 'h2m_session';
export const SESSION_TTL_DAYS = 30;

export type SessionUser = { id: number; name: string; email: string };

export async function createSession(userid: number): Promise<{ token: string; expiresAt: Date }> {
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

    await pool.query(
        'INSERT INTO sessions (session_id, userid, expires_at) VALUES ($1, $2, $3)',
        [token, userid, expiresAt]
    );

    return { token, expiresAt };
}

// Returns the logged-in user for a token, or null when there isn't one.
export async function getSessionUser(token: string | undefined): Promise<SessionUser | null> {
    if (!token) return null;

    const result = await pool.query(
        `SELECT s.userid, l.username, l.useremail
           FROM sessions s
           JOIN login_info l ON l.userid = s.userid
          WHERE s.session_id = $1 AND s.expires_at > now()`,
        [token]
    );

    const row = result.rows[0] as
        | { userid: number; username: string; useremail: string }
        | undefined;

    if (!row) return null;
    return { id: row.userid, name: row.username, email: row.useremail };
}

export async function deleteSession(token: string | undefined): Promise<void> {
    if (!token) return;
    await pool.query('DELETE FROM sessions WHERE session_id = $1', [token]);
}

// Housekeeping: drop sessions that have expired. Called on login so it
// doesn't need a background job.
export async function purgeExpiredSessions(): Promise<void> {
    await pool.query('DELETE FROM sessions WHERE expires_at <= now()');
}
