const path = require('path');
const os = require('os');
const fs = require('fs');

const { ensureMSAuthFile } = require('../shared/msAuth');
const { writeRunStatus } = require('../shared/runStatus');
const { runCreateBridgeMsAuth } = require('../shared/runCreateBridgeMsAuth');

function truncate(s, max = 50_000) {
  const str = String(s || '');
  if (str.length <= max) return str;
  return str.slice(0, max) + '\n...<truncated>\n';
}

module.exports = async function (context, msg) {
  const functionRoot = path.resolve(__dirname, '..');

  const t0 = Date.now();
  const logStep = (name, details) => {
    const ms = Date.now() - t0;
    const detailText = details ? ` | ${details}` : '';
    context.log(`[create-bridge-msauth-worker] +${ms}ms ${name}${detailText}`);
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

  // For async worker runs, default to 2 minutes unless overridden.
  const timeoutMs =
    Number(parsed?.timeoutMs) ||
    Number(process.env.FUNCTION_TIMEOUT_MS_ASYNC || '') ||
    Number(process.env.FUNCTION_TIMEOUT_MS || '') ||
    2 * 60 * 1000;

  const now = () => new Date().toISOString();

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
    msAuth: {
      ensured: false,
      downloaded: null,
      preexisting: null,
      source: null,
      bytes: null,
      validated: false,
    },
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
  try {
    logStep('msauth_ensure_start');
    msAuthPath = await ensureMSAuthFile(functionRoot, { strict: true, log: (msg) => logStep('msauth_fetch', msg) });
    logStep('msauth_ensure_ok', `path=${msAuthPath || ''}`);
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
      error: 'ensureMSAuthFile returned null (no MSAuth.json available).',
    });
    logStep('msauth_missing_after_ensure');
    return;
  }

  let msAuthBytes = null;
  let msAuthValidated = false;
  let msAuthSource = null;
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
      msAuth: {
        ensured: true,
        downloaded: authDownloaded,
        preexisting: authPreexisting,
        source: msAuthSource,
        bytes: msAuthBytes,
        validated: false,
      },
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

  // Persist msAuth metadata so callers can see it while the run is still executing.
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
    msAuth: {
      ensured: true,
      downloaded: authDownloaded,
      preexisting: authPreexisting,
      source: msAuthSource,
      bytes: msAuthBytes,
      validated: msAuthValidated,
    },
  });

  logStep('playwright_start', safeJson({ incidentId: String(incidentId), browserName }));
  const result = await runCreateBridgeMsAuth({
    functionRoot,
    incidentId,
    browserName,
    timeoutMs,
    msAuthPath,
  });

  logStep('playwright_done', safeJson({ exitCode: result.code, timedOut: Boolean(result.timedOut) }));

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
    msAuth: {
      ensured: true,
      downloaded: authDownloaded,
      preexisting: authPreexisting,
      source: msAuthSource,
      bytes: msAuthBytes,
      validated: msAuthValidated,
    },
    exitCode: result.code,
    timedOut: Boolean(result.timedOut),
    output: truncate(result.output),
  });

  logStep('status_final_written', safeJson({ state }));
};
