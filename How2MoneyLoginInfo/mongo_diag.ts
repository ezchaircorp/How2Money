// Diagnoses the Atlas connection without printing credentials. Deleted after use.
import dns from 'node:dns/promises';
import net from 'node:net';
import dotenv from 'dotenv';
import path from 'path';

// This file lives in How2MoneyLoginInfo/, so the repo-root .env is one level up.
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const link = process.env.database_link || '';

// Everything below prints hostnames/ports only — never the userinfo.
const m = /^mongodb\+srv:\/\/([^@]+)@([^/?]+)/.exec(link);
if (!m) {
    console.log('could not parse the link (unexpected shape)');
    process.exit(0);
}
const host = m[2];
console.log('cluster host:', host.replace(/^[^.]+/, '<masked-cluster>'));

async function main(): Promise<void> {
    let srv: Array<{ name: string; port: number }> = [];
    try {
        srv = await dns.resolveSrv(`_mongodb._tcp.${host}`);
        console.log('SRV records:', srv.map((r) => `${r.name}:${r.port} (prio ${r.priority})`).join(', '));
    } catch (err) {
        console.log('SRV lookup failed:', (err as Error).message);
        return;
    }

    for (const { name, port } of srv.slice(0, 2)) {
        const ok = await new Promise<boolean>((resolve) => {
            const socket = net.connect({ host: name, port, timeout: 8000 });
            socket.once('connect', () => { socket.destroy(); resolve(true); });
            socket.once('timeout', () => { socket.destroy(); resolve(false); });
            socket.once('error', () => resolve(false));
        });
        console.log(`TCP ${name}:${port} -> ${ok ? 'open' : 'FAILED (reset/blocked)'}`);
    }
}

void main();
