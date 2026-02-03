const fs = require('fs');
const path = require('path');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadTemplateHtml() {
  const templatePath = path.resolve(__dirname, 'landing.html');
  return fs.readFileSync(templatePath, 'utf8');
}

function getBaseUrlFromRequest(req) {
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
  if (!host) return null;
  const proto = req?.headers?.['x-forwarded-proto'] || 'https';
  return `${proto}://${host}`;
}

function safeUrlForLog(urlStr) {
  try {
    const u = new URL(String(urlStr));
    // Strip query/fragment so SAS tokens aren't exposed.
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

function boolText(v) {
  return v ? 'Yes' : 'No';
}

function buildAuthPreflightHtml() {
  const blobUrl = String(process.env.MSAUTH_BLOB_URL || '').trim();
  const blobUrlSafe = blobUrl ? safeUrlForLog(blobUrl) : null;

  const hasKeyVault = Boolean(String(process.env.KEYVAULT_URL || '').trim()) && Boolean(String(process.env.MSAUTH_SECRET_NAME || '').trim());
  const hasBlobSettings = Boolean(
    String(process.env.MSAUTH_BLOB_CONNECTION || '').trim() ||
      String(process.env.MSAUTH_BLOB_ACCOUNT_URL || '').trim() ||
      String(process.env.MSAUTH_BLOB_CONTAINER || '').trim() ||
      String(process.env.MSAUTH_BLOB_NAME || '').trim(),
  );

  const runFromPackage = Boolean(String(process.env.WEBSITE_RUN_FROM_PACKAGE || '').trim());
  const authWritePath = String(process.env.MSAUTH_WRITE_PATH || '').trim() || (runFromPackage ? '(temp folder)' : '(function wwwroot)');

  const items = [
    { k: 'MSAUTH_BLOB_URL set', v: boolText(Boolean(blobUrl)) },
    { k: 'MSAUTH_BLOB_URL', v: blobUrlSafe ? escapeHtml(blobUrlSafe) : '<span style="opacity:.7">(not set)</span>' },
    { k: 'Key Vault configured', v: boolText(hasKeyVault) },
    { k: 'Blob settings configured', v: boolText(hasBlobSettings) },
    { k: 'Run-from-package', v: boolText(runFromPackage) },
    { k: 'MSAuth write path', v: escapeHtml(authWritePath) },
  ];

  return `
    <div class="pill" style="flex: 1; min-width: 320px; align-items: flex-start; gap: 10px;">
      <div style="display:grid; gap:6px;">
        <div style="font-weight:650; color: rgba(234,240,255,0.92);">Auth preflight</div>
        <div style="display:grid; gap:6px;">
          ${items
            .map(
              (x) =>
                `<div style="display:flex; justify-content:space-between; gap:12px; font-size:12px; color: rgba(234,240,255,0.75);"><span>${escapeHtml(
                  x.k,
                )}</span><strong style="color: rgba(234,240,255,0.92); font-weight:600;">${x.v}</strong></div>`,
            )
            .join('')}
        </div>
        <div style="font-size:12px; color: rgba(234,240,255,0.6);">No secrets are downloaded from this page.</div>
      </div>
    </div>
  `;
}

module.exports = async function (context, req) {
  // Prefer explicit override (useful for local testing or custom domains).
  // Otherwise, derive from the current request so Azure links point at the deployed host.
  const configuredBaseUrl = String(process.env.CREATE_BRIDGE_BASE_URL || '').trim();
  const requestBaseUrl = getBaseUrlFromRequest(req);
  const baseUrl = String(configuredBaseUrl || requestBaseUrl || 'http://localhost:7075').replace(/\/$/, '');

  // Which endpoint the landing page should invoke.
  // Default to the MSAuth test endpoint so cloud users don't hit the manual-auth flow.
  const endpointName = String(process.env.CREATE_BRIDGE_ENDPOINT || 'create-bridge-msauth').trim() || 'create-bridge-msauth';
  const endpointUrl = `${baseUrl}/api/${encodeURIComponent(endpointName)}`;
  const createBridgeUrl = (incidentId) => `${endpointUrl}?incidentId=${encodeURIComponent(String(incidentId))}`;
  const preflightUrl = `${baseUrl}/api/msauth-preflight`;

  // Mock incident data (replace later with real source)
  const incidents = [
    { id: 154895666, title: 'IcM: Portal latency spikes', severity: 'Sev2', status: 'Active', owner: 'Eng On-Call', updated: '5m ago' },
    { id: 154896693, title: 'Bridge audio issues reported', severity: 'Sev3', status: 'Mitigating', owner: 'Teams Ops', updated: '12m ago' },
    { id: 154895553, title: 'Auth redirect loop (PPE)', severity: 'Sev2', status: 'Active', owner: 'Identity', updated: '18m ago' },
    { id: 154887055, title: 'Incident timeline missing entries', severity: 'Sev3', status: 'Investigating', owner: 'IcM Platform', updated: '25m ago' },
    { id: 154941406, title: 'Service health banner incorrect', severity: 'Sev4', status: 'Monitoring', owner: 'Web UX', updated: '1h ago' },
    { id: 154942057, title: 'Join bridge button flaky', severity: 'Sev3', status: 'Active', owner: 'Automation', updated: '1h ago' },
    { id: 154941402, title: 'Incident search results stale', severity: 'Sev3', status: 'Mitigating', owner: 'Search', updated: '2h ago' },
    { id: 154941200, title: 'Create bridge action missing', severity: 'Sev2', status: 'Active', owner: 'IcM UI', updated: '3h ago' },
    { id: 155005814, title: 'Notifications delayed', severity: 'Sev2', status: 'Investigating', owner: 'Comms', updated: '6h ago' },
  ];

  const cardsHtml = incidents
    .map((i) => {
      const sevClass = String(i.severity || '').toLowerCase() === 'sev2'
        ? 'sev2'
        : String(i.severity || '').toLowerCase() === 'sev3'
          ? 'sev3'
          : 'sev4';

      const deepLink = createBridgeUrl(i.id);

      return `
        <article class="card" data-text="${escapeHtml([i.id, i.title, i.severity, i.status, i.owner, i.updated].join(' ')).toLowerCase()}">
          <div class="row">
            <div class="id">Incident #${escapeHtml(i.id)}</div>
            <div class="updated">Updated ${escapeHtml(i.updated)}</div>
          </div>
          <div class="title2">${escapeHtml(i.title)}</div>
          <div class="meta">
            <div class="kv"><span>Severity</span><strong><span class="badge ${sevClass}">${escapeHtml(i.severity)}</span></strong></div>
            <div class="kv"><span>Status</span><strong>${escapeHtml(i.status)}</strong></div>
            <div class="kv"><span>Owner</span><strong>${escapeHtml(i.owner)}</strong></div>
          </div>
          <div class="actions">
            <a class="btn" href="${escapeHtml(deepLink)}">Create bridge</a>
            <a class="smallLink" href="${escapeHtml(deepLink)}" title="Copy link">Link</a>
          </div>
        </article>
      `;
    })
    .join('');

  const template = loadTemplateHtml();
  const authPreflightHtml = buildAuthPreflightHtml();
  const html = template
    .replaceAll('{{BASE_URL}}', escapeHtml(baseUrl))
    .replaceAll('{{ENDPOINT_URL}}', escapeHtml(endpointUrl))
    .replaceAll('{{PREFLIGHT_URL}}', escapeHtml(preflightUrl))
    .replace('{{AUTH_PREFLIGHT}}', authPreflightHtml)
    .replace('{{CARDS}}', cardsHtml);

  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: html,
  };
};
