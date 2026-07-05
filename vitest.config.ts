import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Several integration tests spawn the CLI as a subprocess (`npx tsx
    // src/index.ts` / `node dist/index.js`). A cold subprocess start under the
    // serial suite can exceed the default 5s per-test timeout on a loaded
    // machine, causing sporadic timeouts unrelated to behavior. 20s gives
    // ample headroom while still catching genuine hangs.
    testTimeout: 20000,
  },
});
