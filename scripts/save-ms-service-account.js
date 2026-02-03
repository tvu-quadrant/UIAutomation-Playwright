const { firefox } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  // Where to store the captured auth state.
  // Keep this separate from MSAuth.json (manual/interactive) to avoid accidental overwrite.
  const AUTH_FILE = path.resolve(__dirname, '..', process.env.AUTH_FILE || 'MSAuth.service-account.json');

  // Target app page that requires Entra auth.
  const SEARCH_URL = process.env.SEARCH_URL || 'https://ppeportal.microsofticm.com/imp/v3/incidents/search/advanced';
  const SEARCH_INPUT =
    'input[aria-label="Incident search bar input"], input[name="searchText"], input[placeholder*="Search by incident ID" i]';

  // Credentials: do NOT hardcode secrets. Provide via env vars if you want autofill.
  const USERNAME = process.env.MS_USERNAME || process.env.SERVICE_ACCOUNT_USERNAME;
  const PASSWORD = process.env.MS_PASSWORD || process.env.SERVICE_ACCOUNT_PASSWORD;

  const waitMs = Number(process.env.SAVE_AUTH_WAIT_MS || 10 * 60 * 1000);

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  async function waitForSearchInputInAnyPage(ctx, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const pages = ctx.pages().filter(p => !p.isClosed());
      for (const p of pages) {
        try {
          const visible = await p.locator(SEARCH_INPUT).first().isVisible({ timeout: 500 });
          if (visible) return p;
        } catch {
          // ignore navigation/closed errors
        }
      }
      await sleep(500);
    }
    const openUrls = ctx.pages().filter(p => !p.isClosed()).map(p => p.url());
    throw new Error(['Timed out waiting for IcM search input after sign-in.', 'Open pages:', ...openUrls.map(u => `- ${u}`)].join('\n'));
  }

  async function bestEffortMicrosoftLoginAutofill(page) {
    // This is intentionally best-effort, because Entra flows can vary
    // (MFA, device compliance, extra prompts, etc.).
    // If env vars are not provided, the user can sign in manually.

    const emailSelector = 'input[name="loginfmt"], input[type="email"]';
    const passwordSelector = 'input[name="passwd"], input[type="password"]';
    const submitSelector = '#idSIButton9, input[type="submit"], button[type="submit"]';

    try {
      if (USERNAME) {
        const email = page.locator(emailSelector).first();
        if (await email.isVisible({ timeout: 1000 }).catch(() => false)) {
          await email.fill(USERNAME, { timeout: 5000 }).catch(() => {});
          // "Next" on Microsoft login is commonly #idSIButton9
          const next = page.locator('#idSIButton9').first();
          if (await next.isVisible({ timeout: 1000 }).catch(() => false)) {
            await next.click().catch(() => {});
          } else {
            await email.press('Enter').catch(() => {});
          }
        }
      }

      if (PASSWORD) {
        const pass = page.locator(passwordSelector).first();
        if (await pass.isVisible({ timeout: 1500 }).catch(() => false)) {
          await pass.fill(PASSWORD, { timeout: 5000 }).catch(() => {});
          const signIn = page.locator('#idSIButton9').first();
          if (await signIn.isVisible({ timeout: 1000 }).catch(() => false)) {
            await signIn.click().catch(() => {});
          } else {
            await pass.press('Enter').catch(() => {});
          }
        }
      }

      // "Stay signed in?" prompt often uses the same #idSIButton9 for "Yes".
      // If it appears, a click is usually safe.
      const staySignedIn = page.locator('#idSIButton9').first();
      if (await staySignedIn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await staySignedIn.click().catch(() => {});
      }

      // Some flows show a "Pick an account" page.
      // If a username is supplied, try to click the first account tile.
      if (USERNAME) {
        const accountTile = page.locator(`[data-test-id="${USERNAME}"]`).first();
        if (await accountTile.isVisible({ timeout: 1000 }).catch(() => false)) {
          await accountTile.click().catch(() => {});
        }
      }

      // If none of the above applied, do nothing — user can complete sign-in manually.
      void submitSelector;
    } catch {
      // best-effort only
    }
  }

  if (fs.existsSync(AUTH_FILE)) {
    console.log(`Auth file already exists: ${AUTH_FILE}`);
    console.log('Delete it first if you want to re-capture.');
  }

  console.log('Launching Firefox for Entra sign-in...');
  const context = await firefox.launchPersistentContext('', {
    headless: false,
    // Do not force window/viewport sizing; let the OS/browser decide.
    viewport: null,
  });

  context.on('page', p => {
    p.on('close', () => console.log('A tab was closed (SSO may open/close tabs).'));
  });

  const page = context.pages()[0] || (await context.newPage());

  console.log('Navigating to IcM advanced search:', SEARCH_URL);
  console.log('(Complete Microsoft sign-in if prompted; this script will wait and scan all open tabs.)');
  await page.goto(SEARCH_URL, { waitUntil: 'load' }).catch(() => {});
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  // Try to assist login if env vars were provided.
  // We also attempt to run this on any newly navigated pages.
  page.on('framenavigated', async frame => {
    try {
      if (frame === page.mainFrame()) await bestEffortMicrosoftLoginAutofill(page);
    } catch {
      // ignore
    }
  });
  await bestEffortMicrosoftLoginAutofill(page);

  try {
    const pageWithSearch = await waitForSearchInputInAnyPage(context, waitMs);
    await pageWithSearch.waitForLoadState('domcontentloaded').catch(() => {});
    await context.storageState({ path: AUTH_FILE });
    console.log('✓ Saved authentication to', AUTH_FILE);
    console.log('Tip: close the Firefox window when you are done.');
    await context.close().catch(() => {});
  } catch (e) {
    console.error('Failed to save auth:', e.message || e);
    await context.close().catch(() => {});
    process.exit(1);
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
