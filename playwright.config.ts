// Browser journeys against the real board. Playwright is not a declared dependency: run these
// where it is installed (`npx playwright test`), after `bun run build`. Each spec starts and
// restarts its own board on a temporary data directory, so there is no shared web server here.
//
// Specs are named `*.e2e.ts` so that `bun test`, which also collects `*.spec.ts`, never runs
// them.

import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests',
  testMatch: '**/*.e2e.ts',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
})
