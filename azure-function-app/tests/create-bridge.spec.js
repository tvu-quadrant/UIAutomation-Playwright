const { test } = require('@playwright/test');
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const https = require('https');
const path = require('path');

// Local dev convenience only: in Azure, use Function App Configuration (App Settings).
// Avoid calling dotenv in cloud; enable only when explicitly requested.
if (String(process.env.LOAD_DOTENV || '').trim() === '1') {
  try {
    require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
  } catch {
    /* ignore */
  }
}

const { IncidentPage } = require('./helpers/findCreateBridge');

const DEFAULT_MSAUTH_BLOB_URL = 'https://uiautopw254394.blob.core.windows.net/playwright/MSAuth.json';

const nowIso = () => new Date().toISOString();

const safeUrlForLog = (urlStr) => {
  try {
    const u = new URL(urlStr);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '(invalid url)';
  }
};

const logStep = (msg) => {
  console.log(`[${nowIso()}] [create-bridge-msauth] ${msg}`);
};

const downloadToFile = async (urlStr, outFile) => {
  await fs.promises.mkdir(path.dirname(outFile), { recursive: true });
  const tmpFile = `${outFile}.download-${process.pid}-${Date.now()}`;

  const doRequest = (currentUrl, redirectCount) =>
    new Promise((resolve, reject) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects downloading MSAuth.json'));
        return;
      }

      https
        .get(currentUrl, (res) => {
          const code = res.statusCode || 0;

          if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
            const nextUrl = new URL(res.headers.location, currentUrl).toString();
            res.resume();
            resolve(doRequest(nextUrl, redirectCount + 1));
            return;
          }

          if (code < 200 || code >= 300) {
            res.resume();
            reject(new Error(`Failed to download MSAuth.json: HTTP ${code}`));
            return;
          }

          const file = fs.createWriteStream(tmpFile);
          res.pipe(file);
          file.on('finish', () => file.close(resolve));
          file.on('error', (err) => {
            try {
              file.close(() => {});
            } catch {
              /* ignore */
            }
            reject(err);
          });
        })
        .on('error', reject);
    });

  await doRequest(urlStr, 0);
  await fs.promises.rename(tmpFile, outFile);
};

const validateStorageStateFile = async (filePath) => {
  const raw = await fs.promises.readFile(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('MSAuth.json exists but is not valid JSON');
  }

  const hasCookies = Array.isArray(parsed?.cookies);
  const hasOrigins = Array.isArray(parsed?.origins);
  if (!hasCookies && !hasOrigins) {
    throw new Error('MSAuth.json JSON shape looks wrong (expected cookies/origins)');
  }

  const stat = await fs.promises.stat(filePath);
  if (!stat.size || stat.size < 50) {
    throw new Error('MSAuth.json file is unexpectedly small');
  }

  return { bytes: stat.size, cookieCount: hasCookies ? parsed.cookies.length : undefined };
};

const resolveAuthFilePath = () => {
  if (process.env.MSAUTH_PATH) return path.resolve(process.env.MSAUTH_PATH);

  // In Azure (zip deploy / run-from-package), repo files may not exist or are read-only.
  // Prefer temp for downloaded auth.
  if (process.env.WEBSITE_INSTANCE_ID) {
    return path.join(os.tmpdir(), 'MSAuth.json');
  }

  return path.resolve(__dirname, '..', 'MSAuth.json');
};

const ensureAuthFile = async () => {
  const authFile = resolveAuthFilePath();
  const runningInAzure = Boolean(process.env.WEBSITE_INSTANCE_ID);
  const runningOnService = Boolean(process.env.PLAYWRIGHT_SERVICE_URL);
  const blobUrl = process.env.MSAUTH_BLOB_URL || DEFAULT_MSAUTH_BLOB_URL;

  logStep(`auth resolve path=${authFile}`);

  // If it already exists, validate and use it.
  if (fs.existsSync(authFile)) {
    const info = await validateStorageStateFile(authFile);
    logStep(`auth ok (existing) bytes=${info.bytes}${typeof info.cookieCount === 'number' ? ` cookies=${info.cookieCount}` : ''}`);
    return authFile;
  }

  // In cloud/Workspaces runs, attempt download from Blob before proceeding.
  if (runningInAzure || runningOnService) {
    logStep(`auth missing; downloading from ${safeUrlForLog(blobUrl)}`);
    await downloadToFile(blobUrl, authFile);
    const info = await validateStorageStateFile(authFile);
    logStep(`auth ok (downloaded) bytes=${info.bytes}${typeof info.cookieCount === 'number' ? ` cookies=${info.cookieCount}` : ''}`);
    return authFile;
  }

  // Local runs can continue to use existing repo MSAuth.json or skip later.
  logStep('auth missing; local run will skip unless CDP settings present');
  return authFile;
};

test('search incident and click Create bridge', async ({ browser: pwBrowser }) => {
  if (String(process.env.LOAD_DOTENV || '').trim() === '1' && !process.env.INCIDENT_NUMBER) {
    try {
      require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), override: true });
    } catch {
      /* ignore */
    }
  }

  const INCIDENT_NUMBER = process.env.INCIDENT_NUMBER || '154880884';
  test.setTimeout(600000);

  const runningOnService = Boolean(process.env.PLAYWRIGHT_SERVICE_URL);
  const runningInAzure = Boolean(process.env.WEBSITE_INSTANCE_ID);

  logStep(`start incident=${INCIDENT_NUMBER} azure=${runningInAzure} workspaces=${runningOnService}`);
  const AUTH_FILE = await ensureAuthFile();

  try {
    const stat = fs.statSync(AUTH_FILE);
    console.log(`[test] storageState path=${AUTH_FILE} bytes=${stat.size}`);
  } catch {
    console.log(`[test] storageState path=${AUTH_FILE} (missing)`);
  }

  let browser;
  let context;
  let usedPage;

  const browserName = String(process.env.BROWSER || '').trim().toLowerCase();
  let launchChannel = 'msedge';
  if (browserName === 'chrome') {
    launchChannel = 'chrome';
  } else if (browserName === 'msedge' || browserName === 'edge') {
    launchChannel = 'msedge';
  } else if (browserName) {
    launchChannel = browserName;
  }

  const cdpPort =
    process.env.CDP_PORT ||
    process.env.EDGE_CDP_PORT ||
    process.env.EDGE_REMOTE_DEBUGGING_PORT ||
    process.env.CHROME_CDP_PORT ||
    process.env.CHROME_REMOTE_DEBUGGING_PORT;

  const cdpUrlFromEnv = process.env.CDP_URL || process.env.EDGE_CDP_URL || process.env.CHROME_CDP_URL;

  if (runningOnService) {
    if (!fs.existsSync(AUTH_FILE)) throw new Error('MSAuth.json is required for Workspaces run but was not found after ensureAuthFile()');
    logStep('creating browser context (Workspaces) with storageState');
    context = await pwBrowser.newContext({ storageState: AUTH_FILE });
    usedPage = await context.newPage();
  } else if (cdpPort || cdpUrlFromEnv) {
    const port = cdpPort || 9222;
    const cdpUrl = cdpUrlFromEnv || `http://127.0.0.1:${port}`;
    logStep(`connecting over CDP url=${cdpUrl}`);
    browser = await chromium.connectOverCDP(cdpUrl);
    context = browser.contexts()[0] || (await browser.newContext());
    usedPage = await context.newPage();
  } else if (fs.existsSync(AUTH_FILE)) {
    logStep(`launching local browser channel=${launchChannel} with storageState`);
    browser = await chromium.launch({ channel: launchChannel, headless: false });
    context = await browser.newContext({ storageState: AUTH_FILE });
    usedPage = await context.newPage();
  } else {
    test.skip(true, 'No MSAuth.json and no CDP settings set.');
    return;
  }

  const ensureOpenPage = async () => {
    if (usedPage && !usedPage.isClosed()) return usedPage;
    if (!context) throw new Error('No browser context available to recover from closed page');
    usedPage = await context.newPage();
    return usedPage;
  };

  const gotoSearchWithRetry = async () => {
    try {
      await new IncidentPage(await ensureOpenPage()).gotoSearch();
      return;
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes('has been closed')) {
        await new IncidentPage(await ensureOpenPage()).gotoSearch();
        return;
      }
      throw e;
    }
  };

  logStep('step 1/7 gotoSearch');
  await gotoSearchWithRetry();

  const searchAndOpenDetailsWithRetry = async () => {
    const runOnce = async () => {
      const page = await ensureOpenPage();
      const incident = new IncidentPage(page);
      await incident.searchIncident(INCIDENT_NUMBER);
      await incident.waitForDetails(INCIDENT_NUMBER);
      return incident;
    };

    try {
      return await runOnce();
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes('has been closed')) {
        await gotoSearchWithRetry();
        return await runOnce();
      }
      throw e;
    }
  };

  logStep('step 2/7 search + open details');
  const incident = await searchAndOpenDetailsWithRetry();

  logStep('step 3/7 click Create bridge');
  const result = await incident.clickCreateBridge();
  if (result && result.alreadyCreated) {
    console.log(result.message || 'This incident is already created bridge');
    return;
  }

  logStep('step 4/7 select Engineering option');
  await usedPage.waitForTimeout(3000);
  await incident.selectEngineeringOption();

  logStep('step 5/7 click Save');
  await usedPage.waitForTimeout(4000);
  await incident.clickSaveButton();

  logStep('step 6/7 wait for success message');
  const ok = await incident.waitForSuccessMessage(15_000);
  if (!ok) throw new Error('Expected Success message after saving Create bridge');

  logStep('step 7/7 Success');
});
