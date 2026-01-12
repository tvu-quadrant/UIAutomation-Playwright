const { test } = require('@playwright/test');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { IncidentPage } = require('./helpers/incidentPage');

const INCIDENT_NUMBER = process.env.INCIDENT_NUMBER || '154880886';
const AUTH_FILE = path.resolve(__dirname, '..', 'MSAuth.json');

test('search incident and click Create bridge', async () => {
  // Allow manual sign-in to complete (up to 10 minutes)
  test.setTimeout(600000);

  let browser;
  let context;
  let usedPage;
  let launchedBrowser = false;

  // No OS-level helpers: rely on Playwright storage state and site behavior only

  // Authentication is read directly from MSAuth.json if present.

  if (fs.existsSync(AUTH_FILE)) {
    // Launch Edge and create a new context using saved Playwright storage state so
    // the session from `MSAuth.json` is restored (no interactive login required).
    const browserLaunchOptions = { channel: 'msedge', headless: false };
    browser = await chromium.launch(browserLaunchOptions);
    context = await browser.newContext({ storageState: AUTH_FILE });
    usedPage = await context.newPage();
    launchedBrowser = true;
  } else if (process.env.EDGE_CDP_PORT || process.env.EDGE_CDP_URL || process.env.EDGE_REMOTE_DEBUGGING_PORT) {
    const port = process.env.EDGE_CDP_PORT || process.env.EDGE_REMOTE_DEBUGGING_PORT;
    const cdpUrl = process.env.EDGE_CDP_URL || `http://localhost:${port}`;
    browser = await chromium.connectOverCDP(cdpUrl);
    context = browser.contexts()[0] || await browser.newContext();
    usedPage = await context.newPage();
  } else {
    test.skip(true, 'No MSAuth.json and no EDGE_CDP_PORT set. Run `npm run save-auth` to store auth or start Edge with remote debugging.');
    return;
  }

  const incident = new IncidentPage(usedPage);

  // Give the ESC helper a moment to run as navigation may trigger the OS dialog
  await incident.gotoSearch();
  await incident.searchIncident(INCIDENT_NUMBER);
  await incident.waitForDetails(INCIDENT_NUMBER);

  const result = await incident.clickCreateBridge();
  if (result && result.alreadyCreated) {
    console.log(result.message);
  } else {
    console.log(result?.message || 'Bridge created successfully');
  }
  await usedPage.waitForTimeout(2000);

  // Intentionally keep the browser/context open for manual inspection per user request.
});

