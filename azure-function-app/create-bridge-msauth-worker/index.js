const path = require('path');
const os = require('os');
const fs = require('fs');

const { ensureMSAuthFile } = require('../shared/msAuth');
const { writeRunStatus } = require('../shared/runStatus');
const { runCreateBridgeMsAuth } = require('../shared/runCreateBridgeMsAuth');
const { uploadPlaywrightHtmlReport, defaultAzureReportDir } = require('../shared/uploadPlaywrightReport');

function safeUrlForLog(urlStr) {
  try {
    const u = new URL(String(urlStr));
    // Strip query/fragment so SAS tokens aren't exposed.
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

function truncate(s, max = 50_000) {
  const str = String(s || '');
  if (str.length <= max) return str;
  return str.slice(0, max) + '\n...<truncated>\n';
}

function inferPlaywrightLastStep(output) {
  const text = String(output || '');
  const lines = text.split(/\r?\n/);

  // Prefer explicit step markers from the test.
  const stepLines = lines.filter((l) => l.includes('[create-bridge-msauth] step '));
  if (stepLines.length) return stepLines[stepLines.length - 1].trim();

  // Fallback: any line containing "step X/Y".
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\bstep\s+\d+\s*\/\s*\d+\b/i.test(lines[i])) return lines[i].trim();
  }

  // Last non-empty line.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (String(lines[i]).trim()) return String(lines[i]).trim();
  }

  return null;
}

function toPacificDateTime(isoOrDateHeader) {
  if (!isoOrDateHeader) return null;
  const d = new Date(isoOrDateHeader);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const mm = get('month');
  const dd = get('day');
  const yyyy = get('year');
  const hh = get('hour');
  const mi = get('minute');
  const ss = get('second');
  const tz = get('timeZoneName');
  if (!mm || !dd || !yyyy || !hh || !mi || !ss) return null;
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}${tz ? ` ${tz}` : ''}`;
}

module.exports = async function (context, msg) {
  const functionRoot = path.resolve(__dirname, '..');

  const t0 = Date.now();
  const runLogs = [];
  const pushLog = (name, details) => {
    const ms = Date.now() - t0;
    const record = {
      t: new Date().toISOString(),
      ms,
      name: String(name),
      details: details ? String(details).slice(0, 2000) : null,
    };
    runLogs.push(record);
    // Keep status payload bounded.
    if (runLogs.length > 250) runLogs.splice(0, runLogs.length - 250);
  };

  const logStep = (name, details) => {
    const ms = Date.now() - t0;
    const detailText = details ? ` | ${details}` : '';
    context.log(`[create-bridge-msauth-worker] +${ms}ms ${name}${detailText}`);
    pushLog(name, details);
  };

  const safeJson = (value) => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };

  const safeWriteStatus = async (runId, status) => {
    try {
      await writeRunStatus(runId, status);
      return true;
    } catch (e) {
      logStep('write_status_failed', safeJson({ runId, message: e?.message || String(e) }));
      return false;
    }
  };

  logStep('msg_received', `invocationId=${context.invocationId}`);

  let parsed;
  try {
    parsed = typeof msg === 'string' ? JSON.parse(msg) : msg;
  } catch (e) {
    logStep('invalid_message_json', safeJson({ message: e?.message || String(e) }));
    return;
  }

  const runId = parsed?.runId;
  const incidentId = parsed?.incidentId;

  if (!runId || !incidentId) {
    logStep('missing_runId_or_incidentId', safeJson({ runId, incidentId }));
    return;
  }

  logStep('msg_parsed', safeJson({ runId, incidentId }));

  const browserName = String(parsed?.browserName || process.env.BROWSER || 'edge').trim() || 'edge';

  // For async worker runs, default to 5 minutes unless overridden.
  const timeoutMs =
    Number(parsed?.timeoutMs) ||
    Number(process.env.FUNCTION_TIMEOUT_MS_ASYNC || '') ||
    Number(process.env.FUNCTION_TIMEOUT_MS || '') ||
    5 * 60 * 1000;

  const now = () => new Date().toISOString();

  const msAuthConfig = {
    config: {
      hasWebsiteInstanceId: Boolean(process.env.WEBSITE_INSTANCE_ID),
      hasPlaywrightServiceUrl: Boolean(process.env.PLAYWRIGHT_SERVICE_URL),
      runFromPackage: Boolean(String(process.env.WEBSITE_RUN_FROM_PACKAGE || '').trim()),

      msAuthBlobUrl: safeUrlForLog(process.env.MSAUTH_BLOB_URL),
      msAuthBlobContainer: process.env.MSAUTH_BLOB_CONTAINER || null,
      msAuthBlobName: process.env.MSAUTH_BLOB_NAME || null,
      hasMsAuthBlobConnection: Boolean(String(process.env.MSAUTH_BLOB_CONNECTION || '').trim()),
      msAuthBlobAccountUrl: process.env.MSAUTH_BLOB_ACCOUNT_URL || null,

      keyVaultUrl: process.env.KEYVAULT_URL || null,
      msAuthSecretName: process.env.MSAUTH_SECRET_NAME || null,

      msAuthWritePathOverride: process.env.MSAUTH_WRITE_PATH || null,
    },
    configured: {
      keyVault:
        Boolean(String(process.env.KEYVAULT_URL || '').trim()) && Boolean(String(process.env.MSAUTH_SECRET_NAME || '').trim()),
      blobUrl: Boolean(String(process.env.MSAUTH_BLOB_URL || '').trim()),
      blob: Boolean(
        String(process.env.MSAUTH_BLOB_CONNECTION || '').trim() ||
          String(process.env.MSAUTH_BLOB_ACCOUNT_URL || '').trim() ||
          String(process.env.MSAUTH_BLOB_CONTAINER || '').trim() ||
          String(process.env.MSAUTH_BLOB_NAME || '').trim(),
      ),
    },
  };

  await safeWriteStatus(runId, {
    runId,
    incidentId: String(incidentId),
    state: 'running',
    createdAt: parsed?.enqueuedAt || now(),
    startedAt: now(),
    updatedAt: now(),
    browserName,
    timeoutMs,
    mode: 'create-bridge-msauth',
    msAuthConfig,
    msAuth: {
      ensured: false,
      downloaded: null,
      preexisting: null,
      source: null,
      bytes: null,
      validated: false,
    },
    logs: runLogs,
  });

  logStep('status_set_running', safeJson({ runId, timeoutMs, browserName }));

  const resolveAuthWritePath = () => {
    const explicit = String(process.env.MSAUTH_WRITE_PATH || '').trim();
    if (explicit) return path.resolve(explicit);
    const runFromPackage = String(process.env.WEBSITE_RUN_FROM_PACKAGE || '').trim();
    if (runFromPackage) return path.join(os.tmpdir(), 'MSAuth.json');
    return path.resolve(functionRoot, 'MSAuth.json');
  };

  const authDefaultPath = path.resolve(functionRoot, 'MSAuth.json');
  const authWritePath = resolveAuthWritePath();
  const authExistedBefore = fs.existsSync(authDefaultPath) || fs.existsSync(authWritePath);

  let msAuthPath;
  let msAuthInfo = null;
  try {
    logStep('msauth_ensure_start');

    const home = String(process.env.HOME || '').trim();
    const preferredWritePath = home ? path.join(home, 'data', 'MSAuth.json') : null;

    msAuthInfo = await ensureMSAuthFile(functionRoot, {
      strict: true,
      returnInfo: true,
      writePath: preferredWritePath || undefined,
      log: (msg) => logStep('msauth_fetch', msg),
    });
    msAuthPath = msAuthInfo?.path;
    logStep('msauth_ensure_ok', safeJson({ path: msAuthPath || null, source: msAuthInfo?.source || null, refreshed: msAuthInfo?.refreshed }));
  } catch (e) {
    await safeWriteStatus(runId, {
      runId,
      incidentId: String(incidentId),
      state: 'failed',
      createdAt: parsed?.enqueuedAt || now(),
      endedAt: now(),
      updatedAt: now(),
      browserName,
      timeoutMs,
      mode: 'create-bridge-msauth',
      msAuthConfig,
      logs: runLogs,
      error: `Failed to fetch MSAuth.json: ${e?.message || e}`,
    });
    logStep('msauth_ensure_failed', safeJson({ message: e?.message || String(e) }));
    return;
  }

  if (!msAuthPath) {
    await safeWriteStatus(runId, {
      runId,
      incidentId: String(incidentId),
      state: 'failed',
      createdAt: parsed?.enqueuedAt || now(),
      endedAt: now(),
      updatedAt: now(),
      browserName,
      timeoutMs,
      mode: 'create-bridge-msauth',
      msAuthConfig,
      logs: runLogs,
      error: 'ensureMSAuthFile returned null (no MSAuth.json available).',
    });
    logStep('msauth_missing_after_ensure');
    return;
  }

  let msAuthBytes = null;
  let msAuthValidated = false;
  let msAuthSource = msAuthInfo?.source || null;
  const authPreexisting = authExistedBefore;
  // User-facing meaning: "we have MSAuth ready" (cached or freshly downloaded).
  const authDownloaded = Boolean(msAuthPath && fs.existsSync(msAuthPath));

  try {
    const stat = fs.statSync(msAuthPath);
    msAuthBytes = stat.size;
    logStep('msauth_file_stat', safeJson({ bytes: stat.size }));

    const raw = fs.readFileSync(msAuthPath, 'utf8');
    const parsedAuth = JSON.parse(raw);
    const cookiesCount = Array.isArray(parsedAuth?.cookies) ? parsedAuth.cookies.length : null;
    const originsCount = Array.isArray(parsedAuth?.origins) ? parsedAuth.origins.length : null;
    const keys = parsedAuth && typeof parsedAuth === 'object' ? Object.keys(parsedAuth).slice(0, 10) : null;
    logStep('msauth_valid_json', safeJson({ cookiesCount, originsCount, keysPreview: keys }));
    msAuthValidated = true;
  } catch (e) {
    logStep('msauth_invalid', safeJson({ path: msAuthPath, message: e?.message || String(e) }));
    await safeWriteStatus(runId, {
      runId,
      incidentId: String(incidentId),
      state: 'failed',
      createdAt: parsed?.enqueuedAt || now(),
      endedAt: now(),
      updatedAt: now(),
      browserName,
      timeoutMs,
      mode: 'create-bridge-msauth',
      msAuthConfig,
      msAuth: {
        ensured: true,
        downloaded: authDownloaded,
        preexisting: authPreexisting,
        source: msAuthSource,
        bytes: msAuthBytes,
        validated: false,
      },
      logs: runLogs,
      error: `MSAuth.json invalid: ${e?.message || e}`,
    });
    return;
  }

  // Best-effort source inference based on recent logs (KeyVault/BlobUrl/Blob).
  // This is safe metadata only.
  try {
    // We logged with logStep('msauth_fetch', msg). That shows up in App Insights but not in status.
    // Infer from env: if MSAUTH_BLOB_URL set, call it blobUrl; else blob/keyvault depends on configuration.
    if (String(process.env.KEYVAULT_URL || '').trim() && String(process.env.MSAUTH_SECRET_NAME || '').trim()) {
      msAuthSource = 'keyvault-or-fallback';
    }
    if (String(process.env.MSAUTH_BLOB_URL || '').trim()) {
      msAuthSource = 'blobUrl';
    } else if (
      String(process.env.MSAUTH_BLOB_CONNECTION || '').trim() ||
      String(process.env.MSAUTH_BLOB_ACCOUNT_URL || '').trim() ||
      String(process.env.MSAUTH_BLOB_CONTAINER || '').trim() ||
      String(process.env.MSAUTH_BLOB_NAME || '').trim()
    ) {
      msAuthSource = msAuthSource || 'blob';
    }
  } catch {
    /* ignore */
  }

  const msAuthVersion = {
    // Backward-compatible keys
    downloadedAt: msAuthInfo?.meta?.downloadedAt || null,
    blobLastModified: msAuthInfo?.meta?.lastModified || msAuthInfo?.meta?.blobLastModifiedUtc || null,

    downloadedAtUtc: msAuthInfo?.meta?.downloadedAtUtc || msAuthInfo?.meta?.downloadedAt || null,
    downloadedAtPacific: msAuthInfo?.meta?.downloadedAtPacific || toPacificDateTime(msAuthInfo?.meta?.downloadedAtUtc || msAuthInfo?.meta?.downloadedAt || null),
    lastModifiedUtc: msAuthInfo?.meta?.blobLastModifiedUtc || msAuthInfo?.meta?.lastModified || null,
    lastModifiedPacific:
      msAuthInfo?.meta?.blobLastModifiedPacific ||
      toPacificDateTime(msAuthInfo?.meta?.blobLastModifiedUtc || msAuthInfo?.meta?.lastModified || null),
    etag: msAuthInfo?.meta?.etag || null,
    contentLength: typeof msAuthInfo?.meta?.contentLength === 'number' ? msAuthInfo.meta.contentLength : null,
    refreshed: typeof msAuthInfo?.refreshed === 'boolean' ? msAuthInfo.refreshed : null,
  };

  // Persist msAuth metadata so callers can see it while the run is still executing.
  // MSAuth.json is referenced via an absolute MSAUTH_PATH; we don't need to copy it into wwwroot.
  // Playwright is spawned from the function root; reporters are configured to write artifacts to writable locations.
  const plannedCwd = functionRoot;
  const msAuthPathForPlaywright = msAuthPath;
  const authCopy = {
    attempted: false,
    from: msAuthPath,
    to: msAuthPath,
    ok: null,
    error: null,
    existsAfter: null,
  };

  try {
    authCopy.ok = Boolean(msAuthPathForPlaywright && fs.existsSync(String(msAuthPathForPlaywright)));
    authCopy.existsAfter = authCopy.ok;
  } catch (e) {
    authCopy.ok = false;
    authCopy.error = e?.message || String(e);
    authCopy.existsAfter = null;
  }

  const playwrightHost = {
    platform: process.platform,
    home: process.env.HOME || null,
    tmpdir: os.tmpdir(),
    functionRoot,
  };

  await safeWriteStatus(runId, {
    runId,
    incidentId: String(incidentId),
    state: 'running',
    createdAt: parsed?.enqueuedAt || now(),
    startedAt: parsed?.enqueuedAt || now(),
    updatedAt: now(),
    browserName,
    timeoutMs,
    mode: 'create-bridge-msauth',
    msAuthConfig,
    msAuth: {
      ensured: true,
      downloaded: authDownloaded,
      preexisting: authPreexisting,
      source: msAuthSource,
      bytes: msAuthBytes,
      validated: msAuthValidated,
      version: msAuthVersion,
    },
    logs: runLogs,
    playwright: {
      lastStep: null,
      cwd: plannedCwd,
      msAuthPathUsed: msAuthPathForPlaywright,
      authCopy,
      host: playwrightHost,
    },
  });

  if (!authCopy.existsAfter) {
    logStep('msauth_copy_missing', safeJson({ msAuthPathForPlaywright, plannedCwd, authCopy }));
    await safeWriteStatus(runId, {
      runId,
      incidentId: String(incidentId),
      state: 'failed',
      createdAt: parsed?.enqueuedAt || now(),
      endedAt: now(),
      updatedAt: now(),
      browserName,
      timeoutMs,
      mode: 'create-bridge-msauth',
      msAuthConfig,
      msAuth: {
        ensured: true,
        downloaded: authDownloaded,
        preexisting: authPreexisting,
        source: msAuthSource,
        bytes: msAuthBytes,
        validated: msAuthValidated,
        version: msAuthVersion,
      },
      logs: runLogs,
      playwright: {
        lastStep: null,
        cwd: plannedCwd,
        msAuthPathUsed: msAuthPathForPlaywright,
        authCopy,
        host: playwrightHost,
      },
      error: `MSAuth.json missing at the path Playwright will use: ${msAuthPathForPlaywright || '(null)'}`,
    });
    return;
  }

  logStep('playwright_start', safeJson({ incidentId: String(incidentId), browserName }));
  const result = await runCreateBridgeMsAuth({
    functionRoot,
    incidentId,
    browserName,
    timeoutMs,
    msAuthPath: msAuthPathForPlaywright,
  });

  logStep('playwright_done', safeJson({ exitCode: result.code, timedOut: Boolean(result.timedOut) }));

  let reportUpload = null;
  try {
    reportUpload = await uploadPlaywrightHtmlReport({
      runId,
      reportDir: defaultAzureReportDir(),
      prefix: `reports/${runId}`,
    });
    logStep('report_upload', safeJson(reportUpload));
  } catch (e) {
    reportUpload = { ok: false, error: e?.message || String(e) };
    logStep('report_upload', safeJson(reportUpload));
  }

  // Post-run diagnostics: verify where the HTML report exists (Workspaces reporter uploads this folder).
  const htmlReport = (() => {
    try {
      const baseHome = String(process.env.HOME || '').trim() || os.tmpdir();
      const dir = path.join(baseHome, 'data', 'playwright-report');
      const exists = fs.existsSync(dir);
      const files = exists
        ? fs
            .readdirSync(dir)
            .slice(0, 25)
            .map((name) => {
              const fullPath = path.join(dir, name);
              try {
                const stat = fs.statSync(fullPath);
                return { name, bytes: stat.isFile() ? stat.size : null, isDir: stat.isDirectory() };
              } catch {
                return { name, bytes: null, isDir: null };
              }
            })
        : [];
      return { dir, exists, fileCount: exists ? files.length : 0, files };
    } catch (e) {
      return { dir: null, exists: null, error: e?.message || String(e) };
    }
  })();

  const ok = result.code === 0;
  const state = result.timedOut ? 'timedOut' : ok ? 'succeeded' : 'failed';

  await safeWriteStatus(runId, {
    runId,
    incidentId: String(incidentId),
    state,
    createdAt: parsed?.enqueuedAt || now(),
    endedAt: now(),
    updatedAt: now(),
    browserName,
    timeoutMs,
    mode: 'create-bridge-msauth',
    msAuthConfig,
    msAuth: {
      ensured: true,
      downloaded: authDownloaded,
      preexisting: authPreexisting,
      source: msAuthSource,
      bytes: msAuthBytes,
      validated: msAuthValidated,
      version: msAuthVersion,
    },
    logs: runLogs,
    exitCode: result.code,
    timedOut: Boolean(result.timedOut),
    playwright: {
      lastStep: inferPlaywrightLastStep(result.output),
      cwd: result?.debug?.cwd || null,
      msAuthPathUsed: result?.debug?.msAuthPathUsed || null,
      authCopy: result?.debug?.msAuthCopy || null,
      htmlReport,
    },
    reportUpload,
    output: truncate(result.output),
  });

  logStep('status_final_written', safeJson({ state }));
};
