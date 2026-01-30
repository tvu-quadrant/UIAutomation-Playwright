const { chromium } = require('playwright');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

(async () => {
  const AUTH_FILE = path.resolve(__dirname, '..', 'MSAuth.json');

  let browser;
  let context;

  const SEARCH_URL = 'https://ppeportal.microsofticm.com/imp/v3/incidents/search/advanced';
  const SEARCH_INPUT = 'input[aria-label="Incident search bar input"], input[name="searchText"], input[placeholder*="Search by incident ID" i]';

  function resolveEdgeExePath() {
    const fromEnv = process.env.EDGE_EXE_PATH || process.env.BROWSER_EXE_PATH;
    if (fromEnv) return fromEnv;

    const candidates = [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return 'msedge.exe';
  }

  function isProcessRunningOnWindows(imageName) {
    if (process.platform !== 'win32') return false;
    try {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${imageName}" /FO CSV /NH`, { encoding: 'utf8' });
      return out && !out.toLowerCase().includes('no tasks are running');
    } catch {
      return false;
    }
  }

  function startEdgeWithRemoteDebugging({ port, userDataDir, profileDirectory }) {
    const exe = resolveEdgeExePath();
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      `--profile-directory=${profileDirectory}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ];

    const child = spawn(exe, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });

    child.unref();
  }

  async function connectToEdgeOverCdp({ port, cdpUrlFromEnv, strict }) {
    const candidates = [cdpUrlFromEnv, `http://127.0.0.1:${port}`, `http://localhost:${port}`].filter(Boolean);
    let lastErr;
    for (const url of candidates) {
      try {
        const browser = await chromium.connectOverCDP(url);
        const context = browser.contexts()[0] || (await browser.newContext());
        return { browser, context, url };
      } catch (e) {
        lastErr = e;
      }
    }

    if (!strict) return null;
    throw new Error(`Could not connect to Edge over CDP. Tried: ${candidates.join(', ')}. Last error: ${lastErr?.message || lastErr}`);
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
      await new Promise(r => setTimeout(r, 500));
    }
    const openUrls = ctx.pages().filter(p => !p.isClosed()).map(p => p.url());
    throw new Error(['Timed out waiting for IcM search input after sign-in.', 'Open pages:', ...openUrls.map(u => `- ${u}`)].join('\n'));
  }

  // CDP settings
  const port = Number(process.env.CDP_PORT || process.env.EDGE_CDP_PORT || process.env.EDGE_REMOTE_DEBUGGING_PORT || 9222);
  const cdpUrlFromEnv = process.env.CDP_URL || process.env.EDGE_CDP_URL;
  const strict = Boolean(process.env.CDP_PORT || process.env.EDGE_CDP_PORT || process.env.EDGE_REMOTE_DEBUGGING_PORT || cdpUrlFromEnv);

  const profileDirectory = process.env.EDGE_PROFILE_DIRECTORY || process.env.BROWSER_PROFILE_DIRECTORY || 'Default';
  const userDataDir =
    process.env.EDGE_USER_DATA_DIR ||
    process.env.BROWSER_USER_DATA_DIR ||
    'C:\\tmp\\edge-playwright-profile';

  // Best-effort: attach first; if it fails, start Edge ourselves with a dedicated profile.
  let connected = await connectToEdgeOverCdp({ port, cdpUrlFromEnv, strict: false });

  if (!connected) {
    if (isProcessRunningOnWindows('msedge.exe')) {
      console.log('Edge is running without CDP; starting a separate CDP-enabled Edge profile for auth capture.');
    }

    console.log(`Starting Edge with remote debugging on port ${port}...`);
    console.log(`Using user data dir: ${userDataDir}`);
    startEdgeWithRemoteDebugging({ port, userDataDir, profileDirectory });

    const start = Date.now();
    const bootTimeoutMs = Number(process.env.CDP_CONNECT_TIMEOUT_MS || 30_000);
    while (Date.now() - start < bootTimeoutMs) {
      connected = await connectToEdgeOverCdp({ port, cdpUrlFromEnv, strict: false });
      if (connected) break;
      await new Promise(r => setTimeout(r, 500));
    }
  }

  if (!connected) {
    // If the user explicitly configured CDP, throw a clearer error.
    await connectToEdgeOverCdp({ port, cdpUrlFromEnv, strict: true });
    throw new Error('Could not connect to Edge over CDP (unexpected).');
  }

  browser = connected.browser;
  context = connected.context;
  console.log(`Connected via CDP: ${connected.url}`);

  // Open the IcM search page to trigger Entra login if needed.
  const page = context.pages()[0] || (await context.newPage());
  page.on('close', () => console.log('Active tab closed (SSO flow may open a new tab/window).'));

  console.log('Navigating to IcM advanced search:', SEARCH_URL);
  console.log('(Complete Microsoft sign-in if prompted; this script will keep waiting and will scan all open tabs.)');
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  try {
    const waitMs = Number(process.env.SAVE_AUTH_WAIT_MS || 10 * 60 * 1000);
    const pageWithSearch = await waitForSearchInputInAnyPage(context, waitMs);
    await pageWithSearch.waitForLoadState('domcontentloaded').catch(() => {});
    await context.storageState({ path: AUTH_FILE });
    console.log('✓ Saved authentication to', AUTH_FILE);
    console.log('Tip: close the Edge window when you are done.');
  } catch (e) {
    console.error('Failed to save auth:', e.message || e);
    process.exit(1);
  }
})().catch(e => { console.error(e); process.exit(1); });
