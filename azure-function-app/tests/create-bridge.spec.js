const { test } = require('@playwright/test');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// For local dev, allow a local .env in the Function App folder.
// In Azure, use Function App Configuration (App Settings).
try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch {
  /* ignore */
}

const { IncidentPage } = require('./helpers/findCreateBridge');

const AUTH_FILE = path.resolve(process.env.MSAUTH_PATH || path.resolve(__dirname, '..', 'MSAuth.json'));

test('search incident and click Create bridge', async ({ browser: pwBrowser }) => {
  if (!process.env.INCIDENT_NUMBER) {
    try {
      require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: true });
    } catch {
      /* ignore */
    }
  }

  const INCIDENT_NUMBER = process.env.INCIDENT_NUMBER || '154880884';
  test.setTimeout(600000);

  const runningOnService = Boolean(process.env.PLAYWRIGHT_SERVICE_URL);

  let browser;
  let context;
  let usedPage;

  const browserName = String(process.env.BROWSER || '').trim().toLowerCase();
  let launchChannel = 'msedge';
  if (browserName === 'chrome') {
    launchChannel = 'chrome';
  } else if (browserName === 'msedge' || browserName === 'edge') {
    launchChannel = 'msedge';
  } else if (browserName) {
    launchChannel = browserName;
  }

  const cdpPort =
    process.env.CDP_PORT ||
    process.env.EDGE_CDP_PORT ||
    process.env.EDGE_REMOTE_DEBUGGING_PORT ||
    process.env.CHROME_CDP_PORT ||
    process.env.CHROME_REMOTE_DEBUGGING_PORT;

  const cdpUrlFromEnv = process.env.CDP_URL || process.env.EDGE_CDP_URL || process.env.CHROME_CDP_URL;

  if (runningOnService) {
    if (!fs.existsSync(AUTH_FILE)) {
      test.skip(true, 'No MSAuth.json found. Provide it via Key Vault/secret before running in Playwright Workspaces.');
      return;
    }

    context = await pwBrowser.newContext({ storageState: AUTH_FILE });
    usedPage = await context.newPage();
  } else if (cdpPort || cdpUrlFromEnv) {
    const port = cdpPort || 9222;
    const cdpUrl = cdpUrlFromEnv || `http://127.0.0.1:${port}`;
    browser = await chromium.connectOverCDP(cdpUrl);
    context = browser.contexts()[0] || (await browser.newContext());
    usedPage = await context.newPage();
  } else if (fs.existsSync(AUTH_FILE)) {
    browser = await chromium.launch({ channel: launchChannel, headless: false });
    context = await browser.newContext({ storageState: AUTH_FILE });
    usedPage = await context.newPage();
  } else {
    test.skip(true, 'No MSAuth.json and no CDP settings set.');
    return;
  }

  const ensureOpenPage = async () => {
    if (usedPage && !usedPage.isClosed()) return usedPage;
    if (!context) throw new Error('No browser context available to recover from closed page');
    usedPage = await context.newPage();
    return usedPage;
  };

  const gotoSearchWithRetry = async () => {
    try {
      await new IncidentPage(await ensureOpenPage()).gotoSearch();
      return;
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes('has been closed')) {
        await new IncidentPage(await ensureOpenPage()).gotoSearch();
        return;
      }
      throw e;
    }
  };

  await gotoSearchWithRetry();

  const searchAndOpenDetailsWithRetry = async () => {
    const runOnce = async () => {
      const page = await ensureOpenPage();
      const incident = new IncidentPage(page);
      await incident.searchIncident(INCIDENT_NUMBER);
      await incident.waitForDetails(INCIDENT_NUMBER);
      return incident;
    };

    try {
      return await runOnce();
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes('has been closed')) {
        await gotoSearchWithRetry();
        return await runOnce();
      }
      throw e;
    }
  };

  const incident = await searchAndOpenDetailsWithRetry();

  const result = await incident.clickCreateBridge();
  if (result && result.alreadyCreated) {
    console.log(result.message || 'This incident is already created bridge');
    return;
  }

  await usedPage.waitForTimeout(3000);
  await incident.selectEngineeringOption();
  await usedPage.waitForTimeout(2000);
  await incident.clickSaveButton();

  const ok = await incident.waitForSuccessMessage(15_000);
  if (!ok) throw new Error('Expected Success message after saving Create bridge');

  console.log('Success');
});
