const path = require('path');
const fs = require('fs');

const { ensureMSAuthFile } = require('../shared/msAuth');

function readQuery(req, key) {
  return (req.query && req.query[key]) || (req.queries && req.queries[key]);
}

function safeUrlForLog(urlStr) {
  try {
    const u = new URL(String(urlStr));
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

module.exports = async function (context, req) {
  const t0 = Date.now();
  const logStep = (name, details) => {
    const ms = Date.now() - t0;
    const detailText = details ? ` | ${details}` : '';
    context.log(`[msauth-preflight] +${ms}ms ${name}${detailText}`);
  };

  const functionRoot = path.resolve(__dirname, '..');

  const doFetchRaw = String(readQuery(req, 'fetch') ?? '1').trim();
  const doFetch = doFetchRaw !== '0' && doFetchRaw.toLowerCase() !== 'false';

  logStep('request_received', `invocationId=${context.invocationId}`);

  const config = {
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
  };

  const configured = {
    keyVault: Boolean(String(config.keyVaultUrl || '').trim()) && Boolean(String(config.msAuthSecretName || '').trim()),
    blobUrl: Boolean(String(process.env.MSAUTH_BLOB_URL || '').trim()),
    blob: Boolean(
      String(process.env.MSAUTH_BLOB_CONNECTION || '').trim() ||
        String(process.env.MSAUTH_BLOB_ACCOUNT_URL || '').trim() ||
        String(process.env.MSAUTH_BLOB_CONTAINER || '').trim() ||
        String(process.env.MSAUTH_BLOB_NAME || '').trim(),
    ),
  };

  const logs = [];
  const captureLog = (msg) => {
    const line = String(msg || '');
    logs.push(line);
    // Mirror to Functions logs for easy viewing in Application Insights.
    logStep('msauth', line);
  };

  const localDefaultPath = path.resolve(functionRoot, 'MSAuth.json');

  const result = {
    ok: false,
    fetched: false,
    validated: false,
    authPath: null,
    authExists: false,
    bytes: null,
    json: null,
    version: null,
  };

  // Quick local check first (informational only; fetch may refresh it).
  const existedBefore = fs.existsSync(localDefaultPath);
  if (existedBefore) {
    result.authPath = localDefaultPath;
    result.authExists = true;
    logStep('local_found', `path=${localDefaultPath}`);
  }

  if (doFetch) {
    const anyConfigured = configured.keyVault || configured.blobUrl || configured.blob;
    if (!anyConfigured) {
      logStep('not_configured', 'no keyvault/blob settings found');
      return {
        status: 412,
        headers: { 'content-type': 'application/json' },
        body: {
          ok: false,
          error: 'MSAuth retrieval is not configured.',
          hint: [
            'Set one of the following:',
            '- MSAUTH_BLOB_URL (public or SAS URL)',
            '- or KEYVAULT_URL + MSAUTH_SECRET_NAME',
            '- or MSAUTH_BLOB_CONTAINER/MSAUTH_BLOB_NAME with storage settings (MSAUTH_BLOB_CONNECTION or AzureWebJobsStorage or MSAUTH_BLOB_ACCOUNT_URL)',
          ].join('\n'),
          config,
          configured,
        },
      };
    }

    logStep('fetch_start', safeJson({ strict: true, doFetch }));
    try {
      const fetchedInfo = await ensureMSAuthFile(functionRoot, { strict: true, log: captureLog, returnInfo: true });
      const fetchedPath = fetchedInfo?.path;
      if (fetchedPath) {
        result.fetched = true;
        result.authPath = fetchedPath;
        result.authExists = fs.existsSync(fetchedPath);
        result.version = {
          downloadedAt: fetchedInfo?.meta?.downloadedAt || null,
          blobLastModified: fetchedInfo?.meta?.lastModified || null,
          etag: fetchedInfo?.meta?.etag || null,
          contentLength: typeof fetchedInfo?.meta?.contentLength === 'number' ? fetchedInfo.meta.contentLength : null,
          refreshed: typeof fetchedInfo?.refreshed === 'boolean' ? fetchedInfo.refreshed : null,
        };
        logStep('fetch_done', `path=${fetchedPath} exists=${result.authExists}`);
      }
    } catch (e) {
      logStep('fetch_failed', safeJson({ message: e?.message || String(e) }));
      return {
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: {
          ok: false,
          error: `Failed to fetch MSAuth.json: ${e?.message || e}`,
          config,
          configured,
          logs,
        },
      };
    }
  }

  if (!result.authPath || !fs.existsSync(result.authPath)) {
    logStep('auth_missing', 'MSAuth.json not present');
    return {
      status: 412,
      headers: { 'content-type': 'application/json' },
      body: {
        ok: false,
        error: 'MSAuth.json is missing (after optional fetch).',
        doFetch,
        existedBefore,
        config,
        configured,
        logs,
      },
    };
  }

  // Validate JSON shape without exposing secrets.
  try {
    const stat = fs.statSync(result.authPath);
    result.bytes = stat.size;

    const raw = fs.readFileSync(result.authPath, 'utf8');
    const parsed = JSON.parse(raw);

    const cookiesCount = Array.isArray(parsed?.cookies) ? parsed.cookies.length : null;
    const originsCount = Array.isArray(parsed?.origins) ? parsed.origins.length : null;
    const keysPreview = parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 10) : null;

    result.validated = true;
    result.ok = true;
    result.json = { cookiesCount, originsCount, keysPreview };

    logStep('validate_ok', safeJson({ bytes: stat.size, cookiesCount, originsCount }));
  } catch (e) {
    logStep('validate_failed', safeJson({ message: e?.message || String(e) }));
    return {
      status: 412,
      headers: { 'content-type': 'application/json' },
      body: {
        ok: false,
        error: 'MSAuth.json exists but failed validation (invalid JSON or unexpected shape).',
        details: e?.message || String(e),
        authPath: result.authPath,
        bytes: result.bytes,
        doFetch,
        config,
        configured,
        logs,
      },
    };
  }

  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      ok: true,
      ts: nowIso(),
      doFetch,
      config,
      configured,
      result,
      logs,
    },
  };
};
