const { test } = require('@playwright/test');
const { chromium } = require('playwright');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

function getBrowserName() {
  const raw = (process.env.BROWSER || process.env.BROWSER_NAME || '').trim().toLowerCase();
  if (raw === 'chrome' || raw === 'googlechrome') return 'chrome';
  if (raw === 'edge' || raw === 'msedge' || raw === '') return 'edge';
  return raw;
}

function getDefaultUserDataDir(browserName) {
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
  return browserName === 'chrome'
    ? 'C:\\tmp\\chrome-playwright-profile'
    : 'C:\\tmp\\edge-playwright-profile';
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

  const strict = Boolean(portEnv || cdpUrlFromEnv);
  const candidates = [
    cdpUrlFromEnv,
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ].filter(Boolean);

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
  const fromEnv =
    process.env.BROWSER_EXE_PATH ||
    (browserName === 'chrome' ? process.env.CHROME_EXE_PATH : process.env.EDGE_EXE_PATH);
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

  const existing = await connectToBrowserOverCdp();
  if (existing) return existing;

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
          `Tip: you can also set CDP_URL=http://127.0.0.1:${port} explicitly.`,
        ].join('\n')
      );
    }

    const fallbackDir = getFallbackDebugUserDataDir(browserName);
    console.log(
      [
        `${browserName === 'chrome' ? 'Chrome' : 'Edge'} is already running without CDP; using a separate profile to avoid lock conflicts.`,
        `Using BROWSER_DEBUG_USER_DATA_DIR=${fallbackDir}`,
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
      'Started browser but could not attach over CDP.',
      `Tried: http://127.0.0.1:${port}`,
      'If you have corporate policy blocking remote debugging, start the browser manually and confirm the port is listening.',
    ].join('\n')
  );
}

function urlsMatchExactOrStartsWith(url, expected) {
  if (!url || !expected) return false;
  return url === expected || url.startsWith(expected);
}

async function waitForUrlInAnyPage(context, initialPage, expectedUrl, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const pages = context.pages().filter(p => !p.isClosed());

    for (const p of pages) {
      if (urlsMatchExactOrStartsWith(p.url(), expectedUrl)) {
        return p;
      }
    }

    if (initialPage && !initialPage.isClosed() && urlsMatchExactOrStartsWith(initialPage.url(), expectedUrl)) {
      return initialPage;
    }

    await new Promise(r => setTimeout(r, 500));
  }

  const openUrls = context.pages().filter(p => !p.isClosed()).map(p => p.url());
  throw new Error(
    [
      'Timed out waiting for sign-in to complete and redirect to the incident summary page.',
      `Expected: ${expectedUrl}`,
      '',
      'Last open page URLs:',
      ...openUrls.map(u => `- ${u}`),
      '',
      'Complete Microsoft Entra sign-in in the opened browser window.',
      'You can increase the wait using MANUAL_AUTH_WAIT_MS (e.g., 600000 for 10 minutes).',
    ].join('\n')
  );
}

async function clickJoinBridge(page) {
  if (!page || page.isClosed()) return false;

  // Case 1: button is directly visible on the page
  const direct = page.locator('button[data-navigator-id="button-Join_bridge"]').first();
  const directVisible = await direct.isVisible().catch(() => false);
  if (directVisible) {
    await direct.click({ timeout: 5000 });
    return true;
  }

  // Case 2: inside More actions menu
  const moreActions = page.locator('button[aria-label="More actions"]').first();
  const moreVisible = await moreActions.isVisible().catch(() => false);
  if (moreVisible) {
    await moreActions.click({ timeout: 5000 });

    const menuItem = page.locator('button[role="menuitem"][data-navigator-id="button-Join_bridge"]').first();
    const menuItemVisible = await menuItem.isVisible({ timeout: 2000 }).catch(() => false);

    if (menuItemVisible) {
      await menuItem.click({ timeout: 5000 });
      return true;
    }

    await page.keyboard.press('Escape').catch(() => {});
  }

  // Fallback: try role-based "More actions" button and then look again
  try {
    const moreRole = page.getByRole('button', { name: /More actions/i }).first();
    await moreRole.click({ timeout: 2000 });

    const menuItem = page.locator('button[role="menuitem"][data-navigator-id="button-Join_bridge"]').first();
    const menuItemVisible = await menuItem.isVisible({ timeout: 2000 }).catch(() => false);

    if (menuItemVisible) {
      await menuItem.click({ timeout: 5000 });
      return true;
    }

    await page.keyboard.press('Escape').catch(() => {});
  } catch {
    // ignore
  }

  return false;
}

async function clickJoinBridgeInAnyIncidentPage(context, incidentUrl, timeoutMs) {
  const start = Date.now();
  let lastErr;

  while (Date.now() - start < timeoutMs) {
    const pages = context
      .pages()
      .filter(p => p && !p.isClosed())
      .filter(p => urlsMatchExactOrStartsWith(p.url(), incidentUrl));

    for (const p of pages) {
      try {
        const clicked = await clickJoinBridge(p);
        if (clicked) return { clicked: true, page: p };
      } catch (e) {
        lastErr = e;
      }
    }

    await safeSleep(300);
  }

  const openUrls = context.pages().filter(p => p && !p.isClosed()).map(p => p.url());
  return {
    clicked: false,
    page: null,
    diagnostics: {
      lastErr: lastErr?.message || String(lastErr || ''),
      openUrls,
    },
  };
}

async function moveMouseAndClick(locator, opts = {}) {
  const visibleTimeout = Number.isFinite(opts.visibleTimeout) ? opts.visibleTimeout : 60000;

  await locator.waitFor({ state: 'visible', timeout: visibleTimeout });
  await locator.scrollIntoViewIfNeeded().catch(() => {});

  const box = await locator.boundingBox();
  if (!box) {
    throw new Error('Element is visible but bounding box is unavailable for mouse click.');
  }

  const page = locator.page();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  // Explicit mouse movement requested.
  await page.mouse.move(x, y, { steps: 12 });
  await page.mouse.down();
  await page.mouse.up();
}

async function clickJoinEngineeringBridge(page, opts = {}) {
  const visibleTimeout = Number.isFinite(opts.visibleTimeout) ? opts.visibleTimeout : 60000;
  const clickTimeout = Number.isFinite(opts.clickTimeout) ? opts.clickTimeout : 15000;

  // The button is rendered by the portal as:
  // <button class="btn-primary mt-3"> Join Engineering Bridge </button>
  // In some builds the clickable target is the wrapping div:
  // <div class="btn-group"><button class="btn-primary mt-3"> Join Engineering Bridge </button></div>
  // Some tenants may wrap it in a dialog without proper ARIA roles, so don't rely on role=dialog.
  const joinEngineeringCandidates = [
    page.locator('div.btn-group:has(button.btn-primary.mt-3:has-text("Join Engineering Bridge"))').first(),
    page.locator('button.btn-primary.mt-3:has-text("Join Engineering Bridge")').first(),
    page.locator('button.btn-primary.mt-3').filter({ hasText: /Join\s+Engineering\s+Bridge/i }).first(),
    page.locator('button:has-text("Join Engineering Bridge")').first(),
    page.locator('a:has-text("Join Engineering Bridge")').first(),
    page.getByRole('button', { name: /Join\s+Engineering\s+Bridge/i }).first(),
    page.locator('text=/Join\s+Engineering\s+Bridge/i').first(),
  ];

  let lastErr;
  for (const candidate of joinEngineeringCandidates) {
    try {
      await candidate.waitFor({ state: 'visible', timeout: visibleTimeout });
      await moveMouseAndClick(candidate, { visibleTimeout: clickTimeout });
      return;
    } catch (e) {
      lastErr = e;
    }
  }

  throw new Error(
    [
      'Could not find "Join Engineering Bridge" button after opening Join bridge dialog.',
      `Last error: ${lastErr?.message || lastErr}`,
    ].join('\n')
  );
}

async function clickJoinEngineeringBridgeInAnyPage(context, timeoutMs) {
  const start = Date.now();
  let lastErr;

  async function tryInPageOrFrames(p) {
    // Try main page first
    await clickJoinEngineeringBridge(p, { visibleTimeout: 2000, clickTimeout: 5000 });
    return;
  }

  while (Date.now() - start < timeoutMs) {
    const pages = context.pages().filter(p => !p.isClosed());

    for (const p of pages) {
      try {
        await tryInPageOrFrames(p);
        return p;
      } catch (e) {
        lastErr = e;
      }

      // If the portal renders the dialog inside an iframe, try frames as well.
      // Note: frame.url() may be about:blank or same-origin; we only use it for diagnostics.
      try {
        const frames = p.frames().filter(f => f !== p.mainFrame());
        for (const frame of frames) {
          const joinEngineeringCandidates = [
            frame.locator('div.btn-group:has(button.btn-primary.mt-3:has-text("Join Engineering Bridge"))').first(),
            frame.locator('button.btn-primary.mt-3:has-text("Join Engineering Bridge")').first(),
            frame.locator('button.btn-primary.mt-3').filter({ hasText: /Join\s+Engineering\s+Bridge/i }).first(),
            frame.locator('button:has-text("Join Engineering Bridge")').first(),
            frame.locator('a:has-text("Join Engineering Bridge")').first(),
            frame.locator('text=/Join\s+Engineering\s+Bridge/i').first(),
          ];

          for (const candidate of joinEngineeringCandidates) {
            try {
              await candidate.waitFor({ state: 'visible', timeout: 1000 });
              await moveMouseAndClick(candidate, { visibleTimeout: 5000 });
              return p;
            } catch (e2) {
              lastErr = e2;
            }
          }
        }
      } catch (e) {
        lastErr = e;
      }
    }

    await new Promise(r => setTimeout(r, 500));
  }

  const openUrls = context.pages().filter(p => !p.isClosed()).map(p => p.url());
  throw new Error(
    [
      'Could not find "Join Engineering Bridge" in any open tab/window after clicking Join bridge.',
      `Last error: ${lastErr?.message || lastErr}`,
      '',
      'Last open page URLs:',
      ...openUrls.map(u => `- ${u}`),
      '',
      'Tip: if your tenant opens Teams directly without the extra dialog, this test can be updated to treat Teams-opening as success.',
    ].join('\n')
  );
}

async function waitForTeamsTab(context, timeoutMs) {
  const start = Date.now();
  const teamsUrlRe = /https?:\/\/(?:.+\.)?teams\.(?:microsoft|live)\.com\//i;

  while (Date.now() - start < timeoutMs) {
    const pages = context.pages().filter(p => !p.isClosed());
    for (const p of pages) {
      const u = p.url();
      if (teamsUrlRe.test(u)) return p;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  return null;
}

async function waitForTeamsOrJoinEngineering(context, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const teams = await waitForTeamsTab(context, 1);
    if (teams) return { kind: 'teams', page: teams };

    try {
      const joinPage = await clickJoinEngineeringBridgeInAnyPage(context, 1);
      return { kind: 'joinEngineeringClicked', page: joinPage };
    } catch {
      // ignore and keep polling
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return { kind: 'timeout', page: null };
}

function safeSleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

test('manual auth: join bridge flow (no MSAuth.json)', async () => {
  test.setTimeout(15 * 60 * 1000);

  // Load .env fresh and get INCIDENT_NUMBER
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: true });
  const INCIDENT_NUMBER = (process.env.INCIDENT_NUMBER || '154880884').trim();

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
  context.on('page', p => {
    try {
      console.log('New tab/window opened:', p.url());
      p.on('framenavigated', f => {
        if (f === p.mainFrame()) {
          console.log('Tab navigated to:', p.url());
        }
      });
    } catch {
      // ignore
    }
  });
  browser.on('disconnected', () => {
    console.log('CDP browser disconnected (browser may have exited).');
  });

  const incidentUrl = `https://ppeportal.microsofticm.com/imp/v5/incidents/details/${INCIDENT_NUMBER}/summary`;

  console.log('Navigating to incident summary:', incidentUrl);
  console.log('If redirected to Microsoft Entra sign-in, complete passwordless/MFA in the opened browser window.');

  try {
    await page.goto(incidentUrl, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    // SSO flows can close the initiating tab; we'll recover by searching other open tabs.
    console.log('Initial navigation did not complete (tab may have closed). Continuing...', e?.message || e);
  }
  await safeSleep(5000);

  // If sign-in is required, wait until redirect back to the incident summary page.
  const signedInPage = await waitForUrlInAnyPage(context, page, incidentUrl, manualWaitMs);
  if (signedInPage !== page) {
    console.log('Detected incident summary in a different tab/window; continuing from that page.');
  }

  await safeSleep(5000);

  const joinBridgeResult = await clickJoinBridgeInAnyIncidentPage(context, incidentUrl, 30_000);
  if (!joinBridgeResult.clicked) {
    console.log('This incident is not created bridge yet');
    return;
  }

  const incidentPageAfterJoin = joinBridgeResult.page || signedInPage;

  console.log('Clicked Join bridge. Waiting 2 seconds for Join bridge dialog to load...');
  await safeSleep(2000);

  // Some tenants show a "Join Engineering Bridge" step; others may open Teams directly.
  const postJoin = await waitForTeamsOrJoinEngineering(context, 90_000);
  if (postJoin.kind === 'joinEngineeringClicked') {
    if (postJoin.page !== incidentPageAfterJoin) {
      console.log('Join Engineering Bridge appeared in a different tab/window; continued from there.');
    }
    console.log('Clicked Join Engineering Bridge successfully');

    const teamsPage = await waitForTeamsTab(context, 30_000);
    if (teamsPage) {
      console.log('Detected Teams meeting tab:', teamsPage.url());
    } else {
      console.log('Teams tab not detected (it may open externally or be blocked).');
    }
  } else if (postJoin.kind === 'teams') {
    console.log('Teams meeting tab opened directly (no Join Engineering Bridge step detected):', postJoin.page.url());
  } else {
    const openUrls = context.pages().filter(p => !p.isClosed()).map(p => p.url());
    console.log('Timed out waiting for Join Engineering Bridge or Teams tab. Open URLs:');
    for (const u of openUrls) console.log('-', u);
    throw new Error('Did not observe Join Engineering Bridge step or Teams meeting tab opening after clicking Join bridge.');
  }

  // Keep session open for manual inspection.
  await new Promise(r => setTimeout(r, manualWaitMs));
});
