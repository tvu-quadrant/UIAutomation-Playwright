const { test } = require('@playwright/test');
const { chromium } = require('playwright');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OVERVIEW_URL = 'https://ppeportal.microsofticm.com/imp/v3/overview/main';

function getDefaultEdgeUserDataDir() {
  // Typical Edge profile location on Windows
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  return path.join(localAppData, 'Microsoft', 'Edge', 'User Data');
}

async function connectToEdgeOverCdp() {
  const portEnv = process.env.EDGE_CDP_PORT || process.env.EDGE_REMOTE_DEBUGGING_PORT;
  const cdpUrlFromEnv = process.env.EDGE_CDP_URL;
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
      'Could not connect to Edge over CDP.',
      `Tried: ${candidates.join(', ')}`,
      `Last error: ${lastErr?.message || lastErr}`,
    ].join('\n')
  );
}

function resolveEdgeExePath() {
  const fromEnv = process.env.EDGE_EXE_PATH;
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

function isEdgeRunningOnWindows() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq msedge.exe" /FO CSV /NH', { encoding: 'utf8' });
    // If Edge isn't running, tasklist returns: INFO: No tasks are running...
    return out && !out.toLowerCase().includes('no tasks are running');
  } catch {
    return false;
  }
}

function startEdgeWithRemoteDebugging({ port, userDataDir, profileDirectory }) {
  const edgeExe = resolveEdgeExePath();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--profile-directory=${profileDirectory}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ];

  const child = spawn(edgeExe, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });

  child.unref();
}

async function connectOrStartCdpSession() {
  // Default behavior: try to attach to CDP on the standard port first.
  // This supports the "full current Edge profile" workflow when Edge was started with remote debugging.
  const existing = await connectToEdgeOverCdp();
  if (existing) return existing;

  // Otherwise start Edge with remote debugging against the real profile directory.
  const configuredUserDataDir = process.env.EDGE_USER_DATA_DIR;
  const defaultUserDataDir = getDefaultEdgeUserDataDir();
  const userDataDir = configuredUserDataDir || defaultUserDataDir;

  if (!userDataDir) {
    throw new Error(
      [
        'Could not determine Edge profile directory.',
        'Set EDGE_USER_DATA_DIR to something like:',
        '  %LOCALAPPDATA%\\Microsoft\\Edge\\User Data',
        'or start Edge manually with remote debugging and set EDGE_CDP_URL.',
      ].join('\n')
    );
  }

  if (!fs.existsSync(userDataDir)) {
    throw new Error(`Edge user data dir not found: ${userDataDir}`);
  }

  const profileDirectory = process.env.EDGE_PROFILE_DIRECTORY || 'Default';
  const port = Number(process.env.EDGE_CDP_PORT || process.env.EDGE_REMOTE_DEBUGGING_PORT || 9222);

  if (isEdgeRunningOnWindows()) {
    throw new Error(
      [
        'Edge appears to already be running, but CDP attach did not work.',
        '',
        'To use the full current Edge profile via CDP, start Edge with remote debugging, for example:',
        `  msedge.exe --remote-debugging-port=${port} --profile-directory=${profileDirectory}`,
        '',
        'Or fully close Edge (including background/tray) and rerun this test so it can start Edge itself.',
        '',
        `Tip: you can also set EDGE_CDP_URL=http://127.0.0.1:${port} explicitly.`,
      ].join('\n')
    );
  }

  console.log(`Starting Edge with remote debugging on port ${port}...`);
  startEdgeWithRemoteDebugging({ port, userDataDir, profileDirectory });

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

test('manual auth: open IcM overview in real Edge profile', async () => {
  // Give plenty of time for manual passwordless/MFA
  test.setTimeout(15 * 60 * 1000);

  const manualWaitMs = Number(process.env.MANUAL_AUTH_WAIT_MS || 10 * 60 * 1000);

  const { browser, context, url } = await connectOrStartCdpSession();
  const page = context.pages()[0] || (await context.newPage());

  console.log(`Connected to Edge via CDP: ${url}`);
  console.log('Navigating to IcM overview:', OVERVIEW_URL);
  console.log('If redirected to Microsoft Entra sign-in, complete passwordless/MFA in the opened Edge window.');

  page.on('close', () => {
    console.log('Active tab was closed (SSO flow may open a new tab/window).');
  });
  browser.on('disconnected', () => {
    console.log('CDP browser disconnected (Edge may have exited).');
  });

  await page.goto(OVERVIEW_URL, { waitUntil: 'domcontentloaded' });

  // Keep the session open for manual sign-in / inspection.
  // Use a Node timer rather than page.waitForTimeout so the test doesn't fail if the active tab is closed by SSO.
  await new Promise(r => setTimeout(r, manualWaitMs));

  // Intentionally do not close Edge here.
});
