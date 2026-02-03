const { defineConfig } = require('@playwright/test');
const { createAzurePlaywrightConfig, ServiceOS } = require('@azure/playwright');
const { DefaultAzureCredential } = require('@azure/identity');

// Optional local dev support only.
// Cloud runs should use Function App Configuration (App Settings) instead of a .env file.
// To enable dotenv locally, set: LOAD_DOTENV=1
if (String(process.env.LOAD_DOTENV || '').trim() === '1') {
  try {
    // eslint-disable-next-line global-require
    require('dotenv').config();
  } catch {
    // ignore
  }
}

const baseConfig = require('./playwright.config.cjs');

// Force headless for all cloud runs.
// (Workspaces is effectively headless anyway, but making this explicit avoids any accidental overrides.)
const cloudConfig = {
  ...baseConfig,
  use: {
    ...(baseConfig.use || {}),
    headless: true,
  },
};

module.exports = defineConfig(
  cloudConfig,
  createAzurePlaywrightConfig(cloudConfig, {
    // Allows cloud browsers to reach local resources if needed.
    // For Function-triggered runs, you’ll usually test public endpoints.
    exposeNetwork: '<loopback>',
    connectTimeout: 3 * 60 * 1000,
    os: ServiceOS.LINUX,
    credential: new DefaultAzureCredential(),
    runName: process.env.PLAYWRIGHT_RUN_NAME || `CreateBridge-${new Date().toISOString()}`,
  }),
  {
    // Upload results to the Playwright Workspace so you can see runs in the portal.
    reporter: [
      ['list'],
      ['html', { open: 'never' }],
      ['@azure/playwright/reporter'],
    ],
  }
);
