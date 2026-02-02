const path = require('path');

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

  // For async worker runs, default to 9 minutes (fits Consumption max) unless overridden.
  const timeoutMs =
    Number(parsed?.timeoutMs) ||
    Number(process.env.FUNCTION_TIMEOUT_MS_ASYNC || '') ||
    Number(process.env.FUNCTION_TIMEOUT_MS || '') ||
    9 * 60 * 1000;

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
  });

  logStep('status_set_running', safeJson({ runId, timeoutMs, browserName }));

  let msAuthPath;
  try {
    logStep('msauth_ensure_start');
    msAuthPath = await ensureMSAuthFile(functionRoot, { strict: true });
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

  try {
    const fs = require('fs');
    const stat = fs.statSync(msAuthPath);
    logStep('msauth_file_stat', safeJson({ bytes: stat.size }));

    const raw = fs.readFileSync(msAuthPath, 'utf8');
    const parsedAuth = JSON.parse(raw);
    const cookiesCount = Array.isArray(parsedAuth?.cookies) ? parsedAuth.cookies.length : null;
    const originsCount = Array.isArray(parsedAuth?.origins) ? parsedAuth.origins.length : null;
    const keys = parsedAuth && typeof parsedAuth === 'object' ? Object.keys(parsedAuth).slice(0, 10) : null;
    logStep('msauth_valid_json', safeJson({ cookiesCount, originsCount, keysPreview: keys }));
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
      error: `MSAuth.json invalid: ${e?.message || e}`,
    });
    return;
  }

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
    exitCode: result.code,
    timedOut: Boolean(result.timedOut),
    output: truncate(result.output),
  });

  logStep('status_final_written', safeJson({ state }));
};
