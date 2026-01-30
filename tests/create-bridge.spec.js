const { test } = require('@playwright/test');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { IncidentPage } = require('./helpers/findCreateBridge');

const AUTH_FILE = path.resolve(__dirname, '..', 'MSAuth.json');

test('search incident and click Create bridge', async () => {
  // Load .env fresh and get INCIDENT_NUMBER
  // IMPORTANT:
  // If `INCIDENT_NUMBER` is already set (e.g., injected by an external runner like the
  // Azure Function), do not override it with local `.env`.
  if (!process.env.INCIDENT_NUMBER) {
    require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: true });
  }
  const INCIDENT_NUMBER = process.env.INCIDENT_NUMBER || '154880884';
  // Allow manual sign-in to complete (up to 10 minutes)
  test.setTimeout(600000);

  let browser;
  let context;
  let usedPage;
  let launchedBrowser = false;

  // No OS-level helpers: rely on Playwright storage state and site behavior only

  // Authentication is read directly from MSAuth.json if present.

  if (process.env.EDGE_CDP_PORT || process.env.EDGE_CDP_URL || process.env.EDGE_REMOTE_DEBUGGING_PORT) {
    const port = process.env.EDGE_CDP_PORT || process.env.EDGE_REMOTE_DEBUGGING_PORT;
    const cdpUrl = process.env.EDGE_CDP_URL || `http://localhost:${port}`;
    browser = await chromium.connectOverCDP(cdpUrl);
    context = browser.contexts()[0] || await browser.newContext();
    usedPage = await context.newPage();
  } else if (fs.existsSync(AUTH_FILE)) {
    // Launch Edge and create a new context using saved Playwright storage state so
    // the session from `MSAuth.json` is restored (no interactive login required).
    const browserLaunchOptions = { channel: 'msedge', headless: false };
    browser = await chromium.launch(browserLaunchOptions);
    context = await browser.newContext({ storageState: AUTH_FILE });
    usedPage = await context.newPage();
    launchedBrowser = true;
  } else {
    test.skip(true, 'No MSAuth.json and no EDGE_CDP_PORT set. Run `npm run save-auth` to store auth or start Edge with remote debugging.');
    return;
  }

  const ensureOpenPage = async () => {
    if (usedPage && !usedPage.isClosed()) return usedPage;
    if (!context) throw new Error('No browser context available to recover from closed page');
    usedPage = await context.newPage();
    return usedPage;
  };

  const gotoSearchWithRetry = async () => {
    // Give the ESC helper a moment to run as navigation may trigger the OS dialog
    try {
      await new IncidentPage(await ensureOpenPage()).gotoSearch();
      return;
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes('has been closed')) {
        console.log('Active tab closed during navigation; retrying with a new tab...');
        await new IncidentPage(await ensureOpenPage()).gotoSearch();
        return;
      }
      throw e;
    }
  };

  await gotoSearchWithRetry();

  const incident = new IncidentPage(usedPage);
  await incident.searchIncident(INCIDENT_NUMBER);
  await incident.waitForDetails(INCIDENT_NUMBER);

  // Click Create Bridge
  const result = await incident.clickCreateBridge();
  if (result && result.alreadyCreated) {
    console.log(result.message || 'This incident is already created bridge');
    return;
  } else {
    // Wait 3 seconds for form to load
    console.log('Waiting 3 seconds for Create Bridge form to load...');
    await usedPage.waitForTimeout(3000);

    // Select Engineering option
    await incident.selectEngineeringOption();

    // Wait 2 seconds
    console.log('Waiting 2 seconds before clicking Save...');
    await usedPage.waitForTimeout(2000);

    // Click Save button
    await incident.clickSaveButton();
    const ok = await incident.waitForSuccessMessage(15_000);
    if (!ok) throw new Error('Expected Success message after saving Create bridge');
    console.log('Success');
    return;
  }
  await usedPage.waitForTimeout(2000);

  // Intentionally keep the browser/context open for manual inspection per user request.
});
