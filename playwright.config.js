/** @type {import('@playwright/test').PlaywrightTestConfig} */
const config = {
  testDir: 'tests',
  timeout: 60_000,
  expect: {
    timeout: 5000
  },
  fullyParallel: false,
  reporter: [['list']],
  use: {
    // Use Microsoft Edge (Chromium) as the browser channel
    channel: 'msedge',
    headless: false,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 10000,
    ignoreHTTPSErrors: true
  }
};

module.exports = config;
