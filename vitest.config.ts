import os from 'node:os';
import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * How many test files run at once. Vitest defaults to one worker per CPU core, which is the right answer for a laptop
 * running one suite and the wrong one for this office: several agents on one machine each run the whole suite, so the
 * default multiplies rather than divides. Measured on an 8-core machine with a 9-agent floor: 27 suites in flight, 18
 * workers, 2 GB of them, and every core pegged -- against a single suite that takes about 90 seconds either way.
 *
 * Two workers per suite keeps a run's own parallelism useful while leaving the machine to the other agents. Raise it
 * with CUBEFARM_TEST_WORKERS on a quiet machine if a full run ever needs to be fast.
 */
const workers = Number(process.env.CUBEFARM_TEST_WORKERS) > 0 ? Number(process.env.CUBEFARM_TEST_WORKERS) : 2;

// Kept apart from vite.config.ts, whose root is client/, so tests in server/, shared/ and scripts/ are found too.
export default defineConfig({
  test: {
    root: '.',
    include: ['{client,server,shared,scripts}/**/*.test.{ts,tsx}'],
    // e2e/ is Playwright's (npm run test:e2e): it needs a browser and a running demo office.
    exclude: [...configDefaults.exclude, 'e2e/**'],
    environment: 'node',
    maxWorkers: workers,
    // Anything a test imports must never see the live office's state (~/.cubefarm) or its ports.
    // Previews tests probe ports: keep them clear of the live office's preview ranges (6300-6499).
    env: { SWARM_HOME: path.join(os.tmpdir(), `cubefarm-vitest-${process.pid}`), SWARM_PORT: '0', SWARM_PREVIEW_PORT: '9300' },
  },
});
