const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { BlobServiceClient } = require('@azure/storage-blob');

function getReportsContainerName() {
  return String(process.env.REPORTS_BLOB_CONTAINER || 'playwright-reports').trim() || 'playwright-reports';
}

function getPublicAccessLevel() {
  const v = String(process.env.REPORTS_PUBLIC_ACCESS || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'container' || v === 'blob') return v;
  if (v === '1' || v === 'true' || v === 'public') return 'blob';
  return null;
}

function getBlobServiceClient() {
  const conn = String(process.env.AzureWebJobsStorage || '').trim();
  if (!conn) {
    throw new Error('AzureWebJobsStorage is not set; required for report uploads');
  }
  return BlobServiceClient.fromConnectionString(conn);
}

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html';
    case '.css':
      return 'text/css';
    case '.js':
      return 'application/javascript';
    case '.json':
      return 'application/json';
    case '.map':
      return 'application/json';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.svg':
      return 'image/svg+xml';
    case '.ico':
      return 'image/x-icon';
    case '.txt':
      return 'text/plain';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    case '.ttf':
      return 'font/ttf';
    case '.webmanifest':
      return 'application/manifest+json';
    default:
      return 'application/octet-stream';
  }
}

async function collectFilesRecursive(rootDir) {
  const results = [];
  async function walk(currentDir) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }
  await walk(rootDir);
  return results;
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

async function uploadPlaywrightHtmlReport({ runId, reportDir, prefix }) {
  const enabled = String(process.env.REPORTS_UPLOAD_ENABLED || '').trim();
  const shouldUpload = enabled === '' ? Boolean(process.env.WEBSITE_INSTANCE_ID) : enabled !== '0' && enabled.toLowerCase() !== 'false';
  if (!shouldUpload) {
    return { ok: false, skipped: true, reason: 'REPORTS_UPLOAD_ENABLED=0' };
  }

  const resolvedDir = String(reportDir || '').trim();
  if (!resolvedDir) {
    return { ok: false, skipped: true, reason: 'no reportDir provided' };
  }

  const indexPath = path.join(resolvedDir, 'index.html');
  if (!fs.existsSync(resolvedDir) || !fs.existsSync(indexPath)) {
    return {
      ok: false,
      skipped: true,
      reason: 'report folder missing',
      reportDir: resolvedDir,
      indexExists: fs.existsSync(indexPath),
    };
  }

  const blobServiceClient = getBlobServiceClient();
  const containerName = getReportsContainerName();
  const containerClient = blobServiceClient.getContainerClient(containerName);
  await containerClient.createIfNotExists();

  const publicAccess = getPublicAccessLevel();
  let publicAccessSet = null;
  let publicAccessError = null;
  if (publicAccess) {
    try {
      // Requires: Storage account setting "Allow blob public access" = enabled.
      await containerClient.setAccessPolicy(publicAccess);
      publicAccessSet = publicAccess;
    } catch (e) {
      publicAccessSet = false;
      publicAccessError = e?.message || String(e);
    }
  }

  const reportPrefix = String(prefix || process.env.REPORTS_BLOB_PREFIX || '').trim() || `reports/${runId}`;

  const files = await collectFilesRecursive(resolvedDir);
  let totalBytes = 0;
  let uploaded = 0;

  for (const fullPath of files) {
    const rel = path.relative(resolvedDir, fullPath);
    const blobName = path.posix.join(toPosix(reportPrefix), toPosix(rel));
    const stat = await fsp.stat(fullPath);
    totalBytes += stat.size;

    const blockBlob = containerClient.getBlockBlobClient(blobName);
    await blockBlob.uploadFile(fullPath, {
      blobHTTPHeaders: { blobContentType: guessContentType(fullPath) },
    });
    uploaded += 1;
  }

  const indexBlobName = path.posix.join(toPosix(reportPrefix), 'index.html');
  const indexUrl = `${containerClient.url}/${indexBlobName}`;

  return {
    ok: true,
    container: containerName,
    prefix: toPosix(reportPrefix),
    indexBlobName,
    indexUrl,
    fileCount: uploaded,
    totalBytes,
    reportDir: resolvedDir,
    publicAccessRequested: publicAccess,
    publicAccessSet,
    publicAccessError,
  };
}

function defaultAzureReportDir() {
  const home = String(process.env.HOME || '').trim() || os.tmpdir();
  return path.join(home, 'data', 'playwright-report');
}

module.exports = {
  uploadPlaywrightHtmlReport,
  defaultAzureReportDir,
};
