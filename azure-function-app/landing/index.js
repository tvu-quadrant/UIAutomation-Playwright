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
  const html = template
    .replaceAll('{{BASE_URL}}', escapeHtml(baseUrl))
    .replaceAll('{{ENDPOINT_URL}}', escapeHtml(endpointUrl))
    .replace('{{CARDS}}', cardsHtml);

  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: html,
  };
};
