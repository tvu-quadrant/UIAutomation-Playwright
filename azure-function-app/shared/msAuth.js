const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');
const { BlobServiceClient } = require('@azure/storage-blob');

function safeUrlForLog(urlStr) {
  try {
    const u = new URL(urlStr);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '(invalid url)';
  }
}

function makeLogger(log) {
  if (typeof log !== 'function') return () => {};
  return (msg) => {
    try {
      log(String(msg));
    } catch {
      /* ignore */
    }
  };
}

function nowIso() {
  return new Date().toISOString();
}

function formatPacific(value) {
  try {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    // Includes PST/PDT automatically.
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(d);
  } catch {
    return null;
  }
}

function buildMeta({ downloadedAtUtc, lastModifiedUtc, etag, contentLength }) {
  return {
    // Backward-compatible keys
    downloadedAt: downloadedAtUtc || null,
    lastModified: lastModifiedUtc || null,

    downloadedAtUtc: downloadedAtUtc || null,
    downloadedAtPacific: downloadedAtUtc ? formatPacific(downloadedAtUtc) : null,
    blobLastModifiedUtc: lastModifiedUtc || null,
    blobLastModifiedPacific: lastModifiedUtc ? formatPacific(lastModifiedUtc) : null,
    etag: etag || null,
    contentLength: typeof contentLength === 'number' ? contentLength : null,
  };
}

async function downloadToFile(stream, filePath) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });

  if (!stream) throw new Error('No stream returned from blob download');

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath);
    stream.pipe(out);
    stream.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
  });
}

async function tryKeyVault({ functionRoot }) {
  const keyVaultUrl = String(process.env.KEYVAULT_URL || '').trim();
  const secretName = String(process.env.MSAUTH_SECRET_NAME || '').trim();
  if (!keyVaultUrl || !secretName) return null;

  const credential = new DefaultAzureCredential();
  const client = new SecretClient(keyVaultUrl, credential);
  const secret = await client.getSecret(secretName);
  if (!secret?.value) return null;

  const authPath = getAuthWritePath(functionRoot);
  fs.writeFileSync(authPath, secret.value, 'utf8');
  return {
    path: authPath,
    meta: buildMeta({ downloadedAtUtc: nowIso(), lastModifiedUtc: null, etag: null, contentLength: null }),
  };
}

function getAuthWritePath(functionRoot) {
  const explicit = String(process.env.MSAUTH_WRITE_PATH || '').trim();
  if (explicit) return path.resolve(explicit);

  // Zip deploy / run-from-package commonly makes wwwroot read-only.
  const runFromPackage = String(process.env.WEBSITE_RUN_FROM_PACKAGE || '').trim();
  if (runFromPackage) {
    return path.join(os.tmpdir(), 'MSAuth.json');
  }

  return path.resolve(functionRoot, 'MSAuth.json');
}

async function tryBlob({ functionRoot }) {
  // Configuration options:
  // - Prefer explicit: MSAUTH_BLOB_CONNECTION (conn string) OR MSAUTH_BLOB_ACCOUNT_URL (for managed identity)
  // - Otherwise fallback to AzureWebJobsStorage conn string if present.
  const containerName = String(process.env.MSAUTH_BLOB_CONTAINER || 'playwright').trim() || 'playwright';
  const blobName = String(process.env.MSAUTH_BLOB_NAME || 'MSAuth.json').trim() || 'MSAuth.json';

  const explicitConn = String(process.env.MSAUTH_BLOB_CONNECTION || '').trim();
  const fallbackConn = String(process.env.AzureWebJobsStorage || '').trim();
  const accountUrl = String(process.env.MSAUTH_BLOB_ACCOUNT_URL || '').trim();

  let blobServiceClient;
  if (explicitConn) {
    blobServiceClient = BlobServiceClient.fromConnectionString(explicitConn);
  } else if (fallbackConn) {
    blobServiceClient = BlobServiceClient.fromConnectionString(fallbackConn);
  } else if (accountUrl) {
    const credential = new DefaultAzureCredential();
    blobServiceClient = new BlobServiceClient(accountUrl, credential);
  } else {
    return null;
  }

  const containerClient = blobServiceClient.getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobName);

  const containerExists = await containerClient.exists();
  if (!containerExists) {
    throw new Error(`MSAuth blob container not found: ${containerName}`);
  }

  const blobExists = await blobClient.exists();
  if (!blobExists) {
    throw new Error(`MSAuth blob not found: ${containerName}/${blobName}`);
  }

  const authPath = getAuthWritePath(functionRoot);

  let props;
  try {
    props = await blobClient.getProperties();
  } catch {
    props = null;
  }

  const resp = await blobClient.download();
  await downloadToFile(resp.readableStreamBody, authPath);

  return {
    path: authPath,
    meta: buildMeta({
      downloadedAtUtc: nowIso(),
      lastModifiedUtc: props?.lastModified ? props.lastModified.toISOString() : null,
      etag: props?.etag || null,
      contentLength: typeof props?.contentLength === 'number' ? props.contentLength : null,
    }),
  };
}

async function downloadUrlToFile(urlStr, filePath) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.download-${process.pid}-${Date.now()}`;

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

          const out = fs.createWriteStream(tmpFile);
          res.pipe(out);
          out.on('finish', () => out.close(resolve));
          out.on('error', (err) => {
            try {
              out.close(() => {});
            } catch {
              /* ignore */
            }
            reject(err);
          });
        })
        .on('error', reject);
    });

  await doRequest(urlStr, 0);

  // On Windows, rename fails if destination exists.
  try {
    await fs.promises.rm(filePath, { force: true });
  } catch {
    /* ignore */
  }
  await fs.promises.rename(tmpFile, filePath);
}

async function downloadUrlToFileWithMeta(urlStr, filePath) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.download-${process.pid}-${Date.now()}`;

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

          const out = fs.createWriteStream(tmpFile);
          res.pipe(out);
          out.on('finish', () => out.close(() => resolve(res.headers)));
          out.on('error', (err) => {
            try {
              out.close(() => {});
            } catch {
              /* ignore */
            }
            reject(err);
          });
        })
        .on('error', reject);
    });

  const headers = await doRequest(urlStr, 0);

  try {
    await fs.promises.rm(filePath, { force: true });
  } catch {
    /* ignore */
  }
  await fs.promises.rename(tmpFile, filePath);

  const downloadedAtUtc = nowIso();
  const lastModifiedHeader = headers?.['last-modified'] || null;
  let lastModifiedUtc = null;
  if (lastModifiedHeader) {
    const d = new Date(lastModifiedHeader);
    if (!Number.isNaN(d.getTime())) lastModifiedUtc = d.toISOString();
  }

  return buildMeta({
    downloadedAtUtc,
    lastModifiedUtc,
    etag: headers?.etag || null,
    contentLength: headers?.['content-length'] ? Number(headers['content-length']) : null,
  });
}

async function tryBlobUrl({ functionRoot, log }) {
  const blobUrl = String(process.env.MSAUTH_BLOB_URL || '').trim();
  if (!blobUrl) return null;

  const authPath = getAuthWritePath(functionRoot);
  log(`BlobUrl: downloading from ${safeUrlForLog(blobUrl)} -> ${authPath}`);
  const meta = await downloadUrlToFileWithMeta(blobUrl, authPath);
  try {
    const stat = await fs.promises.stat(authPath);
    log(`BlobUrl: downloaded bytes=${stat.size}`);
    if (meta && typeof meta === 'object') meta.bytes = stat.size;
  } catch {
    /* ignore */
  }

  return { path: authPath, meta };
}

async function ensureMSAuthFile(functionRoot, options = {}) {
  const { strict = false, log, returnInfo = false } = options;
  const logger = makeLogger(log);

  const toInfo = (value, source, refreshed = false) => {
    if (!value) return null;
    if (typeof value === 'string') return { path: value, source: source || 'local', meta: null, refreshed: Boolean(refreshed) };
    if (typeof value === 'object' && value.path) {
      return {
        path: value.path,
        source: value.source || source || 'unknown',
        meta: value.meta || null,
        refreshed: typeof value.refreshed === 'boolean' ? value.refreshed : Boolean(refreshed),
      };
    }
    return null;
  };

  const formatReturn = (info) => {
    if (!returnInfo) return info?.path || null;
    return info;
  };

  const defaultAuthPath = path.resolve(functionRoot, 'MSAuth.json');
  const authWritePath = getAuthWritePath(functionRoot);

  const runningInAzure = Boolean(String(process.env.WEBSITE_INSTANCE_ID || '').trim());

  const keyVaultConfigured = Boolean(String(process.env.KEYVAULT_URL || '').trim()) && Boolean(String(process.env.MSAUTH_SECRET_NAME || '').trim());
  // Treat as "configured" only if the user explicitly opted in to blob settings.
  // (AzureWebJobsStorage is almost always present in Functions and shouldn't by itself force strict failures.)
  const blobConfigured = Boolean(
    String(process.env.MSAUTH_BLOB_URL || '').trim() ||
    String(process.env.MSAUTH_BLOB_CONNECTION || '').trim() ||
      String(process.env.MSAUTH_BLOB_ACCOUNT_URL || '').trim() ||
      String(process.env.MSAUTH_BLOB_CONTAINER || '').trim() ||
      String(process.env.MSAUTH_BLOB_NAME || '').trim(),
  );

  const hasAzureWebJobsStorage = Boolean(String(process.env.AzureWebJobsStorage || '').trim());
  const blobPossible = blobConfigured || hasAzureWebJobsStorage;

  // Azure Functions behavior: if blob is configured, always refresh MSAuth from blob.
  // This avoids reusing stale auth state between runs.
  const forceBlobRefresh =
    runningInAzure &&
    blobPossible &&
    String(process.env.MSAUTH_BLOB_FORCE_REFRESH || '1').trim() !== '0' &&
    String(process.env.MSAUTH_BLOB_FORCE_REFRESH || '1').trim().toLowerCase() !== 'false';

  if (!forceBlobRefresh) {
    if (fs.existsSync(defaultAuthPath)) {
      logger(`Local: found ${defaultAuthPath}`);
      return formatReturn(toInfo(defaultAuthPath, 'local', false));
    }

    if (fs.existsSync(authWritePath)) {
      logger(`Local: found ${authWritePath}`);
      return formatReturn(toInfo(authWritePath, 'local', false));
    }
  } else {
    logger('Azure: forcing MSAuth refresh from Blob (no cache reuse)');
  }

  const retrievalErrors = [];

  // Forced refresh path: blob first.
  if (forceBlobRefresh) {
    if (String(process.env.MSAUTH_BLOB_URL || '').trim()) {
      const urlResult = await tryBlobUrl({ functionRoot, log: logger }).catch((e) => {
        retrievalErrors.push(`BlobUrl: ${e?.message || e}`);
        return null;
      });
      if (urlResult?.path) {
        logger(`BlobUrl: wrote auth to ${urlResult.path}`);
        return formatReturn(toInfo({ ...urlResult, source: 'blobUrl', refreshed: true }, 'blobUrl', true));
      }
    }

    const blobResult = await tryBlob({ functionRoot }).catch((e) => {
      retrievalErrors.push(`Blob: ${e?.message || e}`);
      return null;
    });
    if (blobResult?.path) {
      logger(`Blob: wrote auth to ${blobResult.path}`);
      return formatReturn(toInfo({ ...blobResult, source: 'blob', refreshed: true }, 'blob', true));
    }
  }

  // Prefer Key Vault if configured.
  if (keyVaultConfigured) {
    logger('KeyVault: configured; attempting download');
  }
  const kv = await tryKeyVault({ functionRoot }).catch((e) => {
    retrievalErrors.push(`KeyVault: ${e?.message || e}`);
    return null;
  });
  if (kv) {
    logger(`KeyVault: wrote auth to ${kv.path}`);
    return formatReturn(toInfo({ ...kv, source: 'keyvault', refreshed: true }, 'keyvault', true));
  }

  // Then allow direct Blob URL download (often easiest for debugging / public or SAS URL).
  if (String(process.env.MSAUTH_BLOB_URL || '').trim()) {
    const urlResult = await tryBlobUrl({ functionRoot, log: logger }).catch((e) => {
      retrievalErrors.push(`BlobUrl: ${e?.message || e}`);
      return null;
    });
    if (urlResult?.path) return formatReturn(toInfo({ ...urlResult, source: 'blobUrl', refreshed: true }, 'blobUrl', true));
  }

  // Fall back to blob storage.
  if (blobConfigured) {
    const containerName = String(process.env.MSAUTH_BLOB_CONTAINER || 'playwright').trim() || 'playwright';
    const blobName = String(process.env.MSAUTH_BLOB_NAME || 'MSAuth.json').trim() || 'MSAuth.json';
    const hasExplicitConn = Boolean(String(process.env.MSAUTH_BLOB_CONNECTION || '').trim());
    const hasAzureWebJobsStorage = Boolean(String(process.env.AzureWebJobsStorage || '').trim());
    const hasAccountUrl = Boolean(String(process.env.MSAUTH_BLOB_ACCOUNT_URL || '').trim());
    logger(
      `Blob: configured container=${containerName} blob=${blobName} (explicitConn=${hasExplicitConn} AzureWebJobsStorage=${hasAzureWebJobsStorage} accountUrl=${hasAccountUrl})`,
    );
  }

  const blob = await tryBlob({ functionRoot }).catch((e) => {
    retrievalErrors.push(`Blob: ${e?.message || e}`);
    return null;
  });
  if (blob?.path) {
    logger(`Blob: wrote auth to ${blob.path}`);
    return formatReturn(toInfo({ ...blob, source: 'blob', refreshed: true }, 'blob', true));
  }

  if (strict && (keyVaultConfigured || blobConfigured) && retrievalErrors.length) {
    throw new Error(`MSAuth.json retrieval failed. ${retrievalErrors.join(' | ')}`);
  }

  return null;
}

module.exports = {
  ensureMSAuthFile,
};
