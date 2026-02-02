const { readRunStatus } = require('../shared/runStatus');

function readQuery(req, key) {
  return (req.query && req.query[key]) || (req.queries && req.queries[key]);
}

module.exports = async function (context, req) {
  const runId = readQuery(req, 'runId') || readQuery(req, 'id');
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

  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: status,
  };
};
