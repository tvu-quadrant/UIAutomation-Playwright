const crypto = require('crypto');

const { writeRunStatus } = require('../shared/runStatus');

function readQuery(req, key) {
  return (req.query && req.query[key]) || (req.queries && req.queries[key]);
}

function getBaseUrl(req) {
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
  const proto = req?.headers?.['x-forwarded-proto'] || 'https';
  if (!host) return null;
  return `${proto}://${host}`;
}

module.exports = async function (context, req) {
  const incidentId =
    readQuery(req, 'incidentId') ||
    readQuery(req, 'incidentID') ||
    readQuery(req, 'incident') ||
    readQuery(req, 'id');

  if (!incidentId) {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: {
        ok: false,
        error: 'Missing required query parameter: incidentId',
        example: '/api/create-bridge-msauth-async?incidentId=155071351',
      },
    };
  }

  const runId = crypto.randomUUID();

  const browserName = String(readQuery(req, 'browser') || process.env.BROWSER || 'edge').trim() || 'edge';
  const timeoutMsRaw = readQuery(req, 'timeoutMs') || readQuery(req, 'timeout');
  const timeoutMs = timeoutMsRaw ? Number(timeoutMsRaw) : undefined;

  const now = new Date().toISOString();
  const status = {
    runId,
    incidentId: String(incidentId),
    state: 'queued',
    createdAt: now,
    updatedAt: now,
    browserName,
    timeoutMs: timeoutMs ?? null,
    mode: 'create-bridge-msauth',
  };

  // Persist initial status so callers can immediately query /run-status.
  try {
    await writeRunStatus(runId, status);
  } catch (e) {
    return {
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: { ok: false, error: `Failed to persist run status: ${e?.message || e}` },
    };
  }

  const msg = {
    runId,
    incidentId: String(incidentId),
    browserName,
    timeoutMs: timeoutMs ?? null,
    enqueuedAt: now,
  };

  // Queue output binding.
  context.bindings.runQueueMessage = JSON.stringify(msg);

  const baseUrl = getBaseUrl(req);
  const statusPath = `/api/run-status?runId=${encodeURIComponent(runId)}`;

  return {
    status: 202,
    headers: { 'content-type': 'application/json' },
    body: {
      ok: true,
      runId,
      incidentId: String(incidentId),
      statusPath,
      statusUrl: baseUrl ? `${baseUrl}${statusPath}` : null,
      hint: 'Poll run-status until state is succeeded/failed/timedOut.',
    },
  };
};
