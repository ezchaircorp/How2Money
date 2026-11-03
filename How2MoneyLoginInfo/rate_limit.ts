// A tiny in-memory rate limiter.
//
// Enough to slow down someone hammering /api/login on a single box. It
// doesn't survive a restart and isn't shared between processes, which is
// fine for a prototype — swap in Redis if this ever runs more than one
// instance.

import type { NextFunction, Request, Response } from 'express';

type Bucket = { count: number; resetAt: number };

export type RateLimitOptions = {
    windowMs: number;
    max: number;
    message?: string;
};

export function rateLimit(options: RateLimitOptions) {
    const { windowMs, max } = options;
    const message = options.message ?? 'Too many attempts. Please wait a moment and try again.';
    const buckets = new Map<string, Bucket>();

    // Drop buckets that have expired so the map can't grow without bound.
    const sweeper = setInterval(() => {
        const now = Date.now();
        for (const [key, bucket] of buckets) {
            if (bucket.resetAt <= now) buckets.delete(key);
        }
    }, windowMs);
    // Don't hold the process open just for the sweeper.
    sweeper.unref?.();

    return function limiter(req: Request, res: Response, next: NextFunction): void {
        const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
        const now = Date.now();
        const bucket = buckets.get(key);

        if (!bucket || bucket.resetAt <= now) {
            buckets.set(key, { count: 1, resetAt: now + windowMs });
            next();
            return;
        }

        bucket.count++;
        if (bucket.count > max) {
            const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
            res.setHeader('Retry-After', String(retryAfter));
            res.status(429).json({ ok: false, error: message });
            return;
        }

        next();
    };
}
