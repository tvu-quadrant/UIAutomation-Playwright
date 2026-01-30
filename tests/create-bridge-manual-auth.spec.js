const { test } = require('@playwright/test');
const { chromium } = require('playwright');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { IncidentPage } = require('./helpers/findCreateBridge');

const OVERVIEW_URL = 'https://ppeportal.microsofticm.com/imp/v3/overview/main';

function urlsMatchOverview(url) {
  if (!url) return false;
  return url.startsWith('https://ppeportal.microsofticm.com/imp/v3/overview/main');
}

function urlsMatchIncidentDetails(url, incidentNumber) {
  if (!url) return false;
  return url.includes(`/imp/v3/incidents/details/${encodeURIComponent(String(incidentNumber))}/`);
}

async function waitForIncidentDetailsInAnyPage(context, initialPage, incidentNumber, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const pages = context.pages().filter(p => !p.isClosed());

    for (const p of pages) {
      const url = p.url();
      if (urlsMatchIncidentDetails(url, incidentNumber)) {
        return p;
      }
    }

    if (initialPage && !initialPage.isClosed() && urlsMatchIncidentDetails(initialPage.url(), incidentNumber)) {
      return initialPage;
    }

    await new Promise(r => setTimeout(r, 500));
  }

  const openUrls = context
    .pages()
    .filter(p => !p.isClosed())
    .map(p => p.url());

  throw new Error(
    [
      'Timed out waiting for the incident details page to load.',
      `Expected details URL to contain: /imp/v3/incidents/details/${incidentNumber}/`,
      '',
      'Last open page URLs:',
      ...openUrls.map(u => `- ${u}`),
    ].join('\n')
  );
}

async function waitForOverviewAfterLogin(context, initialPage, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const pages = context.pages().filter(p => !p.isClosed());

    for (const p of pages) {
      const url = p.url();
      if (urlsMatchOverview(url)) {
        return p;
      }
    }

    // If the initial page got redirected and is still open, prefer it.
    if (initialPage && !initialPage.isClosed() && urlsMatchOverview(initialPage.url())) {
      return initialPage;
    }

    await new Promise(r => setTimeout(r, 500));
  }

  const openUrls = context
    .pages()
    .filter(p => !p.isClosed())
    .map(p => p.url());

  throw new Error(
    [
      'Timed out waiting for Microsoft Entra sign-in to complete.',
      `Expected redirect back to: ${OVERVIEW_URL}`,
      '',
      'Last open page URLs:',
      ...openUrls.map(u => `- ${u}`),
      '',
      'If login requires user interaction, complete it in the opened browser window.',
      'You can increase the wait using MANUAL_AUTH_WAIT_MS (e.g., 600000 for 10 minutes).',
    ].join('\n')
  );
}

function getBrowserName() {
  const raw = (process.env.BROWSER || process.env.BROWSER_NAME || '').trim().toLowerCase();
  if (raw === 'chrome' || raw === 'googlechrome') return 'chrome';
  if (raw === 'edge' || raw === 'msedge' || raw === '') return 'edge';
  return raw;
}

function getDefaultUserDataDir(browserName) {
  // Typical profile locations on Windows
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  if (browserName === 'chrome') {
    return path.join(localAppData, 'Google', 'Chrome', 'User Data');
  }
  return path.join(localAppData, 'Microsoft', 'Edge', 'User Data');
}

function getFallbackDebugUserDataDir(browserName) {
  const fromEnv = process.env.BROWSER_DEBUG_USER_DATA_DIR;
  if (fromEnv) return fromEnv;

  // A separate profile avoids lock conflicts when the user's browser is already running.
  // This still supports interactive Entra login (passwordless/MFA) but won't reuse existing cookies.
  return browserName === 'chrome' ? 'C:\\tmp\\chrome-playwright-profile' : 'C:\\tmp\\edge-playwright-profile';
}

async function connectToBrowserOverCdp() {
  const portEnv =
    process.env.CDP_PORT ||
    process.env.EDGE_CDP_PORT ||
    process.env.EDGE_REMOTE_DEBUGGING_PORT ||
    process.env.CHROME_CDP_PORT;
  const cdpUrlFromEnv =
    process.env.CDP_URL ||
    process.env.EDGE_CDP_URL ||
    process.env.CHROME_CDP_URL;
  const port = Number(portEnv || 9222);

  // If the user explicitly set CDP details, treat failures as hard errors.
  // If not, we treat CDP attach as best-effort so we can fall back to auto-starting Edge.
  const strict = Boolean(portEnv || cdpUrlFromEnv);

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

  throw new Error(
    [
      'Could not connect to browser over CDP.',
      `Tried: ${candidates.join(', ')}`,
      `Last error: ${lastErr?.message || lastErr}`,
    ].join('\n')
  );
}

function resolveBrowserExePath(browserName) {
  const fromEnv = process.env.BROWSER_EXE_PATH || (browserName === 'chrome' ? process.env.CHROME_EXE_PATH : process.env.EDGE_EXE_PATH);
  if (fromEnv) return fromEnv;

  const candidates =
    browserName === 'chrome'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ]
      : [
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return browserName === 'chrome' ? 'chrome.exe' : 'msedge.exe';
}

function isProcessRunningOnWindows(imageName) {
  if (process.platform !== 'win32') return false;
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${imageName}" /FO CSV /NH`, { encoding: 'utf8' });
    // If Edge isn't running, tasklist returns: INFO: No tasks are running...
    return out && !out.toLowerCase().includes('no tasks are running');
  } catch {
    return false;
  }
}

function startBrowserWithRemoteDebugging({ browserName, port, userDataDir, profileDirectory }) {
  const exe = resolveBrowserExePath(browserName);
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

async function connectOrStartCdpSession() {
  const browserName = getBrowserName();

  // Default behavior: try to attach to CDP on the standard port first.
  // This supports the "full current profile" workflow when the browser was started with remote debugging.
  const existing = await connectToBrowserOverCdp();
  if (existing) return existing;

  // Otherwise start the browser with remote debugging against the real profile directory.
  const configuredUserDataDir = process.env.BROWSER_USER_DATA_DIR || process.env.EDGE_USER_DATA_DIR;
  const defaultUserDataDir = getDefaultUserDataDir(browserName);
  const userDataDir = configuredUserDataDir || defaultUserDataDir;

  if (!userDataDir) {
    throw new Error(
      [
        'Could not determine browser profile directory.',
        'Set BROWSER_USER_DATA_DIR (or EDGE_USER_DATA_DIR) to your profile folder, or start the browser manually with remote debugging and set CDP_URL.',
      ].join('\n')
    );
  }

  if (!fs.existsSync(userDataDir)) {
    throw new Error(`Browser user data dir not found: ${userDataDir}`);
  }

  const profileDirectory = process.env.BROWSER_PROFILE_DIRECTORY || process.env.EDGE_PROFILE_DIRECTORY || 'Default';
  const port = Number(
    process.env.CDP_PORT ||
      process.env.EDGE_CDP_PORT ||
      process.env.EDGE_REMOTE_DEBUGGING_PORT ||
      process.env.CHROME_CDP_PORT ||
      9222
  );

  const imageName = browserName === 'chrome' ? 'chrome.exe' : 'msedge.exe';
  const requireCurrentProfile = String(process.env.REQUIRE_CURRENT_PROFILE || '').trim() === '1';

  if (isProcessRunningOnWindows(imageName)) {
    if (requireCurrentProfile) {
      throw new Error(
        [
          `${browserName === 'chrome' ? 'Chrome' : 'Edge'} appears to already be running, but CDP attach did not work.`,
          '',
          'REQUIRE_CURRENT_PROFILE=1 is set, so this test will not use a separate profile.',
          '',
          'To use the full current profile via CDP, start the browser with remote debugging, for example:',
          browserName === 'chrome'
            ? `  chrome.exe --remote-debugging-port=${port} --profile-directory=${profileDirectory}`
            : `  msedge.exe --remote-debugging-port=${port} --profile-directory=${profileDirectory}`,
          '',
          `Or fully close ${browserName === 'chrome' ? 'Chrome' : 'Edge'} (including background/tray) and rerun this test so it can start it itself.`,
          '',
          `Tip: you can also set CDP_URL=http://127.0.0.1:${port} explicitly.`,
        ].join('\n')
      );
    }

    // Best-effort fallback: launch a separate profile so this works "out of the box" on other machines.
    const fallbackDir = getFallbackDebugUserDataDir(browserName);
    console.log(
      [
        `${browserName === 'chrome' ? 'Chrome' : 'Edge'} is already running without CDP; using a separate profile to avoid lock conflicts.`,
        `Using BROWSER_DEBUG_USER_DATA_DIR=${fallbackDir}`,
        'If you need the full current profile, start the browser with remote debugging and set CDP_URL/CDP_PORT.',
      ].join('\n')
    );

    console.log(`Starting ${browserName} with remote debugging on port ${port}...`);
    startBrowserWithRemoteDebugging({ browserName, port, userDataDir: fallbackDir, profileDirectory });

    const start = Date.now();
    const timeoutMs = 30_000;
    while (Date.now() - start < timeoutMs) {
      try {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        const context = browser.contexts()[0] || (await browser.newContext());
        return { browser, context, url: `http://127.0.0.1:${port}` };
      } catch {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    throw new Error(
      [
        'Started browser with a separate profile but could not attach over CDP.',
        `Tried: http://127.0.0.1:${port}`,
      ].join('\n')
    );
  }

  console.log(`Starting ${browserName} with remote debugging on port ${port}...`);
  startBrowserWithRemoteDebugging({ browserName, port, userDataDir, profileDirectory });

  // Give Edge time to boot before attempting to attach.
  const start = Date.now();
  const timeoutMs = 30_000;
  while (Date.now() - start < timeoutMs) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const context = browser.contexts()[0] || (await browser.newContext());
      return { browser, context, url: `http://127.0.0.1:${port}` };
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  throw new Error(
    [
      'Started Edge but could not attach over CDP.',
      `Tried: http://127.0.0.1:${port}`,
      'If you have corporate policy blocking remote debugging, start Edge manually and confirm the port is listening.',
    ].join('\n')
  );
}

test('manual auth: incident create bridge flow (no MSAuth.json)', async () => {
  // Give plenty of time for manual passwordless/MFA
  test.setTimeout(15 * 60 * 1000);

  // Load .env fresh and get INCIDENT_NUMBER
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: true });
  const INCIDENT_NUMBER = process.env.INCIDENT_NUMBER || '154880884';

  const manualWaitMs = Number(process.env.MANUAL_AUTH_WAIT_MS || 10 * 60 * 1000);

  const browserName = getBrowserName();
  const defaultUserDataDir = getDefaultUserDataDir(browserName);
  console.log(`Browser: ${browserName}`);
  console.log(`Default profile dir (if not overridden): ${defaultUserDataDir || '(unknown)'}`);

  const { browser, context, url } = await connectOrStartCdpSession();
  const page = context.pages()[0] || (await context.newPage());

  console.log(`Connected via CDP: ${url}`);

  page.on('close', () => {
    console.log('Active tab was closed (SSO flow may open a new tab/window).');
  });
  browser.on('disconnected', () => {
    console.log('CDP browser disconnected (browser may have exited).');
  });

  // Step 1: Navigate to overview to trigger Microsoft Entra sign-in.
  console.log('Navigating to IcM overview:', OVERVIEW_URL);
  console.log('If redirected to Microsoft Entra sign-in, complete passwordless/MFA in the opened browser window.');
  await page.goto(OVERVIEW_URL, { waitUntil: 'domcontentloaded' });

  // Step 1b: Block until sign-in completes and we are redirected back to the overview page.
  const signedInPage = await waitForOverviewAfterLogin(context, page, manualWaitMs);
  if (signedInPage !== page) {
    console.log('Detected overview page in a different tab/window; continuing from that page.');
  }

  // Step 2: Run the same scenario as create-bridge.spec.js (but without MSAuth.json).
  const incident = new IncidentPage(signedInPage);

  await incident.gotoSearch();
  await incident.searchIncident(INCIDENT_NUMBER);

  // SSO flows can close the active tab and open a new tab/window.
  // Wait for the incident details page in *any* open tab, then continue there.
  const detailsPage = await waitForIncidentDetailsInAnyPage(context, signedInPage, INCIDENT_NUMBER, 60_000);
  if (detailsPage !== signedInPage) {
    console.log('Detected incident details page in a different tab/window; continuing from that page.');
  }

  // Prefer a lightweight load state; networkidle can hang on pages with long-polling.
  await detailsPage.waitForLoadState('domcontentloaded').catch(() => {});
  await detailsPage.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

  const incidentOnDetails = new IncidentPage(detailsPage);

  const clickCreateBridgeWithRetry = async () => {
    const tryOnce = async (page) => {
      const incident = new IncidentPage(page);
      return await incident.clickCreateBridge();
    };

    try {
      if (detailsPage.isClosed()) {
        const recovered = await waitForIncidentDetailsInAnyPage(context, signedInPage, INCIDENT_NUMBER, 30_000);
        return await tryOnce(recovered);
      }

      return await tryOnce(detailsPage);
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes('has been closed')) {
        const recovered = await waitForIncidentDetailsInAnyPage(context, signedInPage, INCIDENT_NUMBER, 30_000);
        return await tryOnce(recovered);
      }
      throw e;
    }
  };

  const result = await clickCreateBridgeWithRetry();
  if (result && result.alreadyCreated) {
    console.log(result.message || 'This incident is already created bridge');
    return;
  } else {
    console.log('Waiting 3 seconds for Create Bridge form to load...');
    // Use the currently-open incident tab (detailsPage may have been replaced by SSO)
    const activeDetailsPage = detailsPage.isClosed()
      ? await waitForIncidentDetailsInAnyPage(context, signedInPage, INCIDENT_NUMBER, 30_000)
      : detailsPage;

    await activeDetailsPage.waitForTimeout(3000);

    const incidentOnActiveDetails = new IncidentPage(activeDetailsPage);
    await incidentOnActiveDetails.selectEngineeringOption();

    console.log('Waiting 2 seconds before clicking Save...');
    await activeDetailsPage.waitForTimeout(2000);

    await incidentOnActiveDetails.clickSaveButton();
    const ok = await incidentOnActiveDetails.waitForSuccessMessage(15_000);
    if (!ok) throw new Error('Expected Success message after saving Create bridge');
    console.log('Success');
    return;
  }

  // Keep the session open for manual inspection.
  await new Promise(r => setTimeout(r, manualWaitMs));
});
