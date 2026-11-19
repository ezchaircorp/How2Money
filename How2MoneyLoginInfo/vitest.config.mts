import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['**/*.test.ts'],
        exclude: ['**/node_modules/**'],
        // The first run downloads a MongoDB binary for the in-memory test
        // database (about 100 MB, cached afterwards), so setup can be slow.
        hookTimeout: 180_000,
        testTimeout: 30_000,
    },
});
