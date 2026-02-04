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

const isAzure = Boolean(process.env.WEBSITE_INSTANCE_ID);
// Note: @azure/playwright/reporter resolves the HTML report folder relative to process.cwd().
// The Functions worker runs Playwright with cwd set to a writable directory (e.g., C:\home\data),
// so we keep the default folder name (playwright-report) here.

// Force headless for all cloud runs.
// (Workspaces is effectively headless anyway, but making this explicit avoids any accidental overrides.)
const cloudConfig = {
  ...baseConfig,
  use: {
    ...(baseConfig.use || {}),
    headless: true,
  },
};

// Reporter must be part of the config passed to createAzurePlaywrightConfig.
// The Workspaces reporter expects an HTML report to exist after the run.
cloudConfig.reporter = isAzure
  ? [
      // HTML reporter must come first.
      // IMPORTANT: In Azure Functions, `wwwroot` can be read-only (run-from-package), so we must
      // write the HTML report to a writable location.
      // Keep this as a *relative* path: @azure/playwright/reporter uses `path.join(process.cwd(), outputFolder)`.
      // Absolute Windows paths (e.g., C:\home\data\...) do not behave as expected with `path.join`.
      ['html', { open: 'never', outputFolder: '../../data/playwright-report' }],
      // NOTE: Do NOT use '@azure/playwright/reporter' here.
      // It uploads to the Playwright Workspaces-owned storage account, which may not exist anymore.
      // We upload the HTML report ourselves from the queue worker into Azure Blob Storage.
      // Extra console visibility while running in Functions.
      ['list'],
    ]
  : [['html', { open: 'never' }], ['list']];

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
  })
);
