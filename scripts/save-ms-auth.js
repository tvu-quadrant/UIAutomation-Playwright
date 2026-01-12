const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const AUTH_FILE = path.resolve(__dirname, '..', 'MSAuth.json');

  let browser;
  let context;

  // Option 1: Connect to existing Edge via CDP if EDGE_CDP_PORT is set
  const cdpPort = process.env.EDGE_CDP_PORT || process.env.EDGE_REMOTE_DEBUGGING_PORT;

  if (cdpPort) {
    console.log(`Connecting to existing Edge on port ${cdpPort}...`);
    try {
      browser = await chromium.connectOverCDP(`http://localhost:${cdpPort}`);
      context = browser.contexts()[0] || await browser.newContext();
    } catch (e) {
      console.error('Failed to connect to Edge via CDP:', e.message);
      console.log('\nTo use an existing Edge session, start Edge with remote debugging:');
      console.log('  msedge.exe --remote-debugging-port=9222');
      console.log('\nThen set EDGE_CDP_PORT=9222 and run this script again.');
      process.exit(1);
    }
  } else {
    // Option 2: Launch a new Edge browser and wait for manual sign-in
    console.log('Launching new Edge browser for authentication...');
    browser = await chromium.launch({ channel: 'msedge', headless: false });
    context = await browser.newContext();
  }

  const page = context.pages()[0] || await context.newPage();

  await page.goto('https://ppeportal.microsofticm.com/imp/v3/incidents/search/advanced', { waitUntil: 'networkidle' });

  console.log('Waiting for IcM dashboard with search input...');
  console.log('(Complete Microsoft sign-in if prompted)');

  try {
    await page.waitForSelector('input[aria-label="Incident search bar input"], input[name="searchText"], input[placeholder*="Search by incident ID" i]', { timeout: 600000 });
    await context.storageState({ path: AUTH_FILE });
    console.log('✓ Saved authentication to', AUTH_FILE);
  } catch (e) {
    console.error('Failed to save auth:', e.message);
    process.exit(1);
  } finally {
    if (!cdpPort) {
      // Only close if we launched a new browser
      await browser.close().catch(() => { });
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
