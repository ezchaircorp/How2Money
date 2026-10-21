// HTTP API + static file server for the How2Money site.
//
// Run with:  npx tsx server.ts   (needs a reachable Postgres)
// Serves:    html_files/ at http://localhost:3000
// API:       POST /api/signup   { name, email, password, confirm? }
//            POST /api/login    { email, password }
//
// All login/signup logic lives in database/db_login.ts (bcrypt-hashed passwords).

import express from 'express';
import path from 'path';

import { login, signup } from './database/db_login';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// The static site lives one level up from this app.
const SITE_DIR = path.resolve(__dirname, '..', 'html_files');

app.use(express.json());

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

app.post('/api/signup', async (req, res) => {
    const body = req.body ?? {};
    try {
        const result = await signup(
            str(body.name),
            str(body.email),
            str(body.password),
            typeof body.confirm === 'string' ? body.confirm : undefined
        );
        if (!result.ok) {
            return res.status(result.status).json({ ok: false, error: result.error });
        }
        return res.status(201).json({
            ok: true,
            message: `Welcome, ${result.user.name}! Your account has been created.`,
            user: result.user,
        });
    } catch (err) {
        console.error('signup failed:', err);
        return res.status(500).json({ ok: false, error: 'Something went wrong creating your account.' });
    }
});

app.post('/api/login', async (req, res) => {
    const body = req.body ?? {};
    try {
        const result = await login(str(body.email), str(body.password));
        if (!result.ok) {
            return res.status(result.status).json({ ok: false, error: result.error });
        }
        return res.json({
            ok: true,
            message: `Welcome back, ${result.user.name}!`,
            user: result.user,
        });
    } catch (err) {
        console.error('login failed:', err);
        return res.status(500).json({ ok: false, error: 'Something went wrong signing you in.' });
    }
});

app.use(express.static(SITE_DIR));

app.get('/', (_req, res) => {
    res.sendFile(path.join(SITE_DIR, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`How2Money server running at http://localhost:${PORT}`);
    console.log(`Serving site from ${SITE_DIR}`);
});