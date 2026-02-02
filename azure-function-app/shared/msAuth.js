const fs = require('fs');
const os = require('os');
const path = require('path');
const { SecretClient } = require('@azure/keyvault-secrets');
const { DefaultAzureCredential } = require('@azure/identity');
const { BlobServiceClient } = require('@azure/storage-blob');

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
  return authPath;
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
  const resp = await blobClient.download();
  await downloadToFile(resp.readableStreamBody, authPath);
  return authPath;
}

async function ensureMSAuthFile(functionRoot, options = {}) {
  const { strict = false } = options;

  const defaultAuthPath = path.resolve(functionRoot, 'MSAuth.json');
  if (fs.existsSync(defaultAuthPath)) return defaultAuthPath;

  const authWritePath = getAuthWritePath(functionRoot);
  if (fs.existsSync(authWritePath)) return authWritePath;

  const keyVaultConfigured = Boolean(String(process.env.KEYVAULT_URL || '').trim()) && Boolean(String(process.env.MSAUTH_SECRET_NAME || '').trim());
  // Treat as "configured" only if the user explicitly opted in to blob settings.
  // (AzureWebJobsStorage is almost always present in Functions and shouldn't by itself force strict failures.)
  const blobConfigured = Boolean(
    String(process.env.MSAUTH_BLOB_CONNECTION || '').trim() ||
      String(process.env.MSAUTH_BLOB_ACCOUNT_URL || '').trim() ||
      String(process.env.MSAUTH_BLOB_CONTAINER || '').trim() ||
      String(process.env.MSAUTH_BLOB_NAME || '').trim(),
  );

  const retrievalErrors = [];

  // Prefer Key Vault if configured.
  const kv = await tryKeyVault({ functionRoot }).catch((e) => {
    retrievalErrors.push(`KeyVault: ${e?.message || e}`);
    return null;
  });
  if (kv) return kv;

  // Fall back to blob storage.
  const blob = await tryBlob({ functionRoot }).catch((e) => {
    retrievalErrors.push(`Blob: ${e?.message || e}`);
    return null;
  });
  if (blob) return blob;

  if (strict && (keyVaultConfigured || blobConfigured) && retrievalErrors.length) {
    throw new Error(`MSAuth.json retrieval failed. ${retrievalErrors.join(' | ')}`);
  }

  return null;
}

module.exports = {
  ensureMSAuthFile,
};
