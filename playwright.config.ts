// Browser journeys against the real board, with the pinned Playwright and a host-installed
// Chromium (`bun run test:browser` builds first). Each spec starts and restarts its own board on
// a temporary data directory, so there is no shared web server here. The diagram journey saves
// its screenshots with the test results, for review of the rendered layout.
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
