const { test } = require('@playwright/test');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { IncidentPage } = require('./helpers/incidentPage');

const INCIDENT_NUMBER = process.env.INCIDENT_NUMBER || '154847522';
const AUTH_FILE = path.resolve(__dirname, '..', 'MSAuth.json');

test('search incident and click Create bridge', async () => {
  // Allow manual sign-in to complete (up to 10 minutes)
  test.setTimeout(600000);

  let browser;
  let context;
  let usedPage;
  let launchedBrowser = false;

  // Authentication is read directly from MSAuth.json if present.

  if (fs.existsSync(AUTH_FILE)) {
    // Launch Edge with stored auth state
    browser = await chromium.launch({ channel: 'msedge', headless: false });
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

  await incident.gotoSearch();
  await incident.searchIncident(INCIDENT_NUMBER);
  await incident.waitForDetails(INCIDENT_NUMBER);
  await incident.clickCreateBridge();
  await usedPage.waitForTimeout(2000);

  if (launchedBrowser && browser) await browser.close();
});

