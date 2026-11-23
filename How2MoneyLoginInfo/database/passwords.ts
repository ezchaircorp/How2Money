// Password hashing for user accounts.
//
// New passwords are hashed with Argon2id (via @node-rs/argon2, which ships
// prebuilt binaries, so no compiler or install script is needed).
//
// Accounts created before the switch still have bcrypt hashes. Those keep
// working: verifyPassword() checks them with bcrypt, and login() then replaces
// the hash with Argon2id (needsRehash), so every account moves over the next
// time its owner signs in. Once no bcrypt hashes are left in `users`, the
// bcrypt branch and the bcrypt dependency can be removed.

import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import bcrypt from 'bcrypt';

// OWASP's recommended Argon2id settings: 19 MiB of memory, 2 passes, 1 lane.
// @node-rs/argon2 uses Argon2id by default; the hash string records the
// algorithm and these settings, so they can be raised later without breaking
// existing hashes (needsRehash picks up the old ones).
export const ARGON2_OPTIONS = {
    memoryCost: 19_456, // KiB
    timeCost: 2,
    parallelism: 1,
} as const;

const ARGON2_PREFIX = '$argon2id$';
const BCRYPT_PREFIX = /^\$2[aby]\$/;

export function hashPassword(password: string): Promise<string> {
    return argon2Hash(password, ARGON2_OPTIONS);
}

// True when the password matches the stored hash, whichever algorithm made it.
// An empty, unknown or corrupt hash never matches, and never throws.
export async function verifyPassword(storedHash: string | undefined | null, password: string): Promise<boolean> {
    if (!storedHash) return false;
    try {
        if (storedHash.startsWith(ARGON2_PREFIX)) return await argon2Verify(storedHash, password);
        if (BCRYPT_PREFIX.test(storedHash)) return await bcrypt.compare(password, storedHash);
    } catch {
        // A malformed hash is treated as a failed login rather than a crash.
    }
    return false;
}

// True when a hash should be replaced: it is bcrypt, or Argon2 with weaker
// settings than ARGON2_OPTIONS.
export function needsRehash(storedHash: string): boolean {
    if (!storedHash.startsWith(ARGON2_PREFIX)) return true;
    const params = /\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
    if (!params) return true;
    const memory = Number(params[1]);
    const time = Number(params[2]);
    const lanes = Number(params[3]);
    return (
        memory < ARGON2_OPTIONS.memoryCost ||
        time < ARGON2_OPTIONS.timeCost ||
        lanes !== ARGON2_OPTIONS.parallelism
    );
}
