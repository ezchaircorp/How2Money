// HTTP API + static file server for the How2Money site.
//
// Run with:  npx tsx server.ts   (needs a reachable Postgres)
// Serves:    html_files/ at http://localhost:3000
// API:       POST /api/signup   { name, email, password }
//            POST /api/login    { email, password }
//
// The old readline CLI (main.ts) is untouched and still works on its own.

import express from 'express';
import path from 'path';

import { emailExists, createUser, findUserByEmailAndPassword } from './database/db_users';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// The static site lives one level up from this app.
const SITE_DIR = path.resolve(__dirname, '..', 'html_files');

app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

// Same loose email rule the CLI used, so the two agree on what's valid.
function looksLikeEmail(value: string): boolean {
    return (
        value.includes('@gmail.com') ||
        value.includes('.edu') ||
        value.includes('@hotmail.com') ||
        value.includes('@yahoo.com')
    );
}

type SignupBody = { name?: unknown; email?: unknown; password?: unknown };
type LoginBody = { email?: unknown; password?: unknown };

function asString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/signup', async (req, res) => {
    const body = req.body as SignupBody;
    const name = asString(body.name);
    const email = asString(body.email);
    const password = typeof body.password === 'string' ? body.password : '';

    if (!name || !email || !password) {
        return res.status(400).json({ ok: false, error: 'Name, email, and password are all required.' });
    }
    if (!looksLikeEmail(email)) {
        return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
    }
    if (password.length < 8) {
        return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
    }

    try {
        if (await emailExists(email)) {
            return res.status(409).json({ ok: false, error: 'That email is already registered.' });
        }
        const user = await createUser(name, email, password);
        return res.status(201).json({
            ok: true,
            message: `Welcome, ${user.Username}! Your account has been created.`,
            user: { name: user.Username, email: user.Useremail },
        });
    } catch (err) {
        console.error('signup failed:', err);
        return res.status(500).json({ ok: false, error: 'Something went wrong creating your account.' });
    }
});

app.post('/api/login', async (req, res) => {
    const body = req.body as LoginBody;
    const email = asString(body.email);
    const password = typeof body.password === 'string' ? body.password : '';

    if (!email || !password) {
        return res.status(400).json({ ok: false, error: 'Email and password are required.' });
    }

    try {
        const user = await findUserByEmailAndPassword(email, password);
        if (!user) {
            return res.status(401).json({ ok: false, error: 'Invalid email or password.' });
        }
        return res.json({
            ok: true,
            message: `Welcome back, ${user.Username}!`,
            user: { name: user.Username, email: user.Useremail },
        });
    } catch (err) {
        console.error('login failed:', err);
        return res.status(500).json({ ok: false, error: 'Something went wrong signing you in.' });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Static site
// ─────────────────────────────────────────────────────────────────────────────

app.use(express.static(SITE_DIR));

// A friendly root → the marketing home page.
app.get('/', (_req, res) => {
    res.sendFile(path.join(SITE_DIR, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`How2Money server running at http://localhost:${PORT}`);
    console.log(`Serving site from ${SITE_DIR}`);
});
