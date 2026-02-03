const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { ensureMSAuthFile } = require('../shared/msAuth');

function readQuery(req, key) {
  return (req.query && req.query[key]) || (req.queries && req.queries[key]);
}


function runPlaywright({ functionRoot, incidentId, timeoutMs, msAuthPath }) {
  return new Promise((resolve) => {
    const configPath = path.join(functionRoot, 'playwright.service.config.cjs');
    const specPath = path.join(functionRoot, 'tests', 'create-bridge.spec.js');

    const args = ['test', specPath, `--config=${configPath}`, '--workers=1'];

    const playwrightCliJsCandidates = [
      path.join(functionRoot, 'node_modules', 'playwright', 'cli.js'),
      path.join(functionRoot, 'node_modules', '@playwright', 'test', 'cli.js'),
    ];

    const playwrightCliJs = playwrightCliJsCandidates.find((p) => fs.existsSync(p));

    if (!playwrightCliJs) {
      resolve({
        code: -4,
        timedOut: false,
        output: [
          'Playwright CLI not found in azure-function-app/node_modules.',
          'Deploy must include dependencies (run npm install during build/deploy).',
          ...playwrightCliJsCandidates.map((p) => `Tried: ${p}`),
        ].join('\n'),
      });
      return;
    }

    const env = {
      ...process.env,
      INCIDENT_NUMBER: String(incidentId),
      // Workspaces expects PLAYWRIGHT_SERVICE_URL to be set in App Settings.
      ...(msAuthPath ? { MSAUTH_PATH: String(msAuthPath) } : {}),
    };

    // Always force headless on cloud runs.
    env.HEADED = '0';
    env.PWHEADLESS = '1';

    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;

    let cwd = functionRoot;
    if (msAuthPath) {
      try {
        const dir = path.dirname(String(msAuthPath));
        if (dir && fs.existsSync(dir)) cwd = dir;
      } catch {
        /* ignore */
      }
    }

    const child = spawn(process.execPath, [playwrightCliJs, ...args], {
      cwd,
      shell: false,
      env,
    });

    child.on('error', (err) => {
      resolve({ code: -3, output: `Failed to start Playwright: ${err?.message || err}`, timedOut: false });
    });

    let output = '';
    const maxBytes = 250_000;
    const append = (chunk) => {
      if (!chunk) return;
      const str = chunk.toString();
      if (output.length < maxBytes) {
        output += str;
        if (output.length > maxBytes) output = output.slice(0, maxBytes) + '\n...<truncated>\n';
      }
    };

    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? (timedOut ? -1 : -2), output, timedOut });
    });
  });
}

module.exports = async function (context, req) {
  const incidentId =
    readQuery(req, 'incidentId') || readQuery(req, 'incidentID') || readQuery(req, 'incident') || readQuery(req, 'id');

  if (!incidentId) {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: {
        ok: false,
        error: 'Missing required query parameter: incidentId',
        example: '/api/create-bridge-workspace?incidentId=155071351',
      },
    };
  }

  const functionRoot = path.resolve(__dirname, '..');

  if (!process.env.PLAYWRIGHT_SERVICE_URL) {
    return {
      status: 412,
      headers: { 'content-type': 'application/json' },
      body: {
        ok: false,
        error: 'PLAYWRIGHT_SERVICE_URL is not set. Configure it in Function App settings.',
      },
    };
  }

  // Make sure storageState exists (prefer Key Vault secret).
  let msAuthPath;
  try {
    msAuthPath = await ensureMSAuthFile(functionRoot, { strict: true, log: (msg) => context.log(`[msauth] ${msg}`) });
  } catch (e) {
    return {
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: { ok: false, error: `Failed to fetch MSAuth from Key Vault: ${e?.message || e}` },
    };
  }

  const timeoutMs = 5 * 60 * 1000;

  context.log(`Triggering Playwright Workspaces run for incidentId=${incidentId}`);

  const result = await runPlaywright({ functionRoot, incidentId, timeoutMs, msAuthPath });
  const ok = result.code === 0;

  return {
    status: ok ? 200 : 500,
    headers: { 'content-type': 'application/json' },
    body: {
      ok,
      incidentId: String(incidentId),
      exitCode: result.code,
      timedOut: result.timedOut,
      output: result.output,
    },
  };
};
