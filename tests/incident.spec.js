const { test } = require('@playwright/test');
const { chromium } = require('playwright');
const { IncidentPage } = require('./helpers/incidentPage');

const INCIDENT_NUMBER = process.env.INCIDENT_NUMBER || '154847522';

test('search incident and click Create bridge', async ({ page }) => {
  // Allow manual sign-in to complete (up to 10 minutes)
  test.setTimeout(600000);

  // If EDGE_CDP_PORT or EDGE_CDP_URL is provided, connect to the existing Edge instance
  let usedPage = page;
  if (process.env.EDGE_CDP_URL || process.env.EDGE_CDP_PORT || process.env.EDGE_REMOTE_DEBUGGING_PORT) {
    const port = process.env.EDGE_CDP_PORT || process.env.EDGE_REMOTE_DEBUGGING_PORT;
    const cdpUrl = process.env.EDGE_CDP_URL || `http://localhost:${port}`;
    const browser = await chromium.connectOverCDP(cdpUrl);
    // Reuse first available context or create a new one in the connected browser
    let context = browser.contexts()[0];
    if (!context) context = await browser.newContext();
    usedPage = await context.newPage();
  } else {
    // If no CDP port/url provided, skip the test to avoid launching a new headed browser
    test.skip(true, 'EDGE_CDP_PORT or EDGE_CDP_URL not set — attach to existing Edge to run this test.');
  }

  const incident = new IncidentPage(usedPage);

  await incident.gotoSearch();
  await incident.searchIncident(INCIDENT_NUMBER);
  await incident.waitForDetails(INCIDENT_NUMBER);
  await incident.clickCreateBridge();
  await usedPage.waitForTimeout(2000);
});

