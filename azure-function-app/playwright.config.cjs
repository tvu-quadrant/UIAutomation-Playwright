const path = require('path');
const os = require('os');

const isAzure = Boolean(process.env.WEBSITE_INSTANCE_ID);
const home = String(process.env.HOME || '').trim() || os.tmpdir();

const outputDir =
  String(process.env.PLAYWRIGHT_OUTPUT_DIR || '').trim() || (isAzure ? path.join(home, 'data', 'test-results') : undefined);

/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
  testDir: 'tests',
  timeout: 60_000,
  expect: { timeout: 5000 },
  fullyParallel: false,
  ...(outputDir ? { outputDir } : {}),
  reporter: isAzure ? [['list']] : [['html', { open: 'never' }], ['list']],
  use: {
    channel: 'msedge',
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 10_000,
    ignoreHTTPSErrors: true,
  },
};
