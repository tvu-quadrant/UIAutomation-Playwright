const { readRunStatus } = require('../shared/runStatus');

function readQuery(req, key) {
  return (req.query && req.query[key]) || (req.queries && req.queries[key]);
}

module.exports = async function (context, req) {
  const runId = readQuery(req, 'runId') || readQuery(req, 'id');
  const includeMsAuthRaw = readQuery(req, 'includeMsAuth') || readQuery(req, 'msauth') || readQuery(req, 'includeAuth');
  const includeLogsRaw = readQuery(req, 'includeLogs') || readQuery(req, 'logs');
  const includeMsAuth =
    String(includeMsAuthRaw || '') === '1' ||
    String(includeMsAuthRaw || '').toLowerCase() === 'true' ||
    String(includeMsAuthRaw || '').toLowerCase() === 'yes';
  const includeLogs =
    String(includeLogsRaw || '') === '1' ||
    String(includeLogsRaw || '').toLowerCase() === 'true' ||
    String(includeLogsRaw || '').toLowerCase() === 'yes';
  if (!runId) {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: { ok: false, error: 'Missing required query parameter: runId' },
    };
  }

  let status;
  try {
    status = await readRunStatus(String(runId));
  } catch (e) {
    return {
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: { ok: false, error: `Failed to read run status: ${e?.message || e}` },
    };
  }

  if (!status) {
    return {
      status: 404,
      headers: { 'content-type': 'application/json' },
      body: { ok: false, error: 'Run not found', runId: String(runId) },
    };
  }

  // By default, omit auth metadata (paths/etc). Add `includeMsAuth=1` to include it.
  if (!includeMsAuth && status && typeof status === 'object' && ('msAuth' in status || 'msAuthConfig' in status)) {
    status = { ...status };
    delete status.msAuth;
    delete status.msAuthConfig;
  }

  // By default, omit debug logs. Add `includeLogs=1` to include them.
  if (!includeLogs && status && typeof status === 'object' && 'logs' in status) {
    status = { ...status };
    delete status.logs;
  }

  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: status,
  };
};
