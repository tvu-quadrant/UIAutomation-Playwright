const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const AUTH_FILE = path.resolve(__dirname, '..', 'MSAuth.json');
  const userDataDir = process.env.EDGE_USER_DATA_DIR;

  let context;
  let browser;

  if (userDataDir) {
    // Use persistent context with the provided user profile so existing sign-ins are available
    context = await chromium.launchPersistentContext(userDataDir, { channel: 'msedge', headless: false });
    // context.pages() may contain a default blank page
    const pages = context.pages();
    browser = context.browser();
    var page = pages.length ? pages[0] : await context.newPage();
  } else {
    browser = await chromium.launch({ channel: 'msedge', headless: false });
    context = await browser.newContext();
    var page = await context.newPage();
  }

  await page.goto('https://ppeportal.microsofticm.com/imp/v3/incidents/search/advanced', { waitUntil: 'networkidle' });

  console.log('Please complete Microsoft Entra sign-in in the opened Edge window. Waiting for landing page with search input...');

  const fs = require('fs');
  const envPath = path.resolve(__dirname, '..', '.env');
  try {
    await page.waitForSelector('input[aria-label="Incident search bar input"], input[name="searchText"], input[placeholder*="Search by incident ID" i]', { timeout: 600000 });
    await context.storageState({ path: AUTH_FILE });
    console.log('Saved authentication to', AUTH_FILE);

    // Note: we save authentication to MSAuth.json only. Do not write secrets to .env.
  } catch (e) {
    console.error('Timed out waiting for sign-in or failed to save storage state:', e);
    process.exit(1);
  } finally {
    try {
      await context.close();
    } catch (err) {
      // ignore
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
