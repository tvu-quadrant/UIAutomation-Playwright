const { defineConfig } = require('@playwright/test');
const { createAzurePlaywrightConfig, ServiceOS } = require('@azure/playwright');
const { DefaultAzureCredential } = require('@azure/identity');

// Optional local dev support: if a .env exists in this folder, load it.
try {
  // eslint-disable-next-line global-require
  require('dotenv').config();
} catch {
  // ignore
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
