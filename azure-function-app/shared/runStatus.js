const { BlobServiceClient } = require('@azure/storage-blob');
const path = require('path');

function getContainerName() {
  return String(process.env.RUNS_BLOB_CONTAINER || 'playwright-runs').trim() || 'playwright-runs';
}

function getBlobName(runId) {
  return path.posix.join('runs', `${runId}.json`);
}

function getBlobServiceClient() {
  const conn = String(process.env.AzureWebJobsStorage || '').trim();
  if (!conn) {
    throw new Error('AzureWebJobsStorage is not set; required for run status persistence');
  }
  return BlobServiceClient.fromConnectionString(conn);
}

async function writeRunStatus(runId, status) {
  const blobServiceClient = getBlobServiceClient();
  const containerClient = blobServiceClient.getContainerClient(getContainerName());
  await containerClient.createIfNotExists();

  const blobClient = containerClient.getBlockBlobClient(getBlobName(runId));

  const body = JSON.stringify(status, null, 2);
  await blobClient.upload(body, Buffer.byteLength(body), {
    blobHTTPHeaders: { blobContentType: 'application/json' },
  });
}

async function readRunStatus(runId) {
  const blobServiceClient = getBlobServiceClient();
  const containerClient = blobServiceClient.getContainerClient(getContainerName());
  const blobClient = containerClient.getBlobClient(getBlobName(runId));

  const exists = await blobClient.exists();
  if (!exists) return null;

  const resp = await blobClient.download();
  const chunks = [];
  for await (const chunk of resp.readableStreamBody) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(text);
}

module.exports = {
  writeRunStatus,
  readRunStatus,
};
