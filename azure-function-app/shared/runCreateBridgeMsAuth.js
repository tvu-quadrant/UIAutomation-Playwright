const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function runCreateBridgeMsAuth({ functionRoot, incidentId, browserName, timeoutMs, msAuthPath }) {
  return new Promise((resolve) => {
    const runningOnService = Boolean(process.env.PLAYWRIGHT_SERVICE_URL);

    // Always run the MSAuth test.
    const configArg = runningOnService ? [`--config=${path.join(functionRoot, 'playwright.service.config.cjs')}`] : [];
    const args = ['test', 'tests/create-bridge.spec.js', ...configArg, '--workers=1'];

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
          ...playwrightCliJsCandidates.map((p) => `Tried: ${p}`),
        ].join('\n'),
      });
      return;
    }

    const env = {
      ...process.env,
      INCIDENT_NUMBER: String(incidentId),
      BROWSER: String(browserName || process.env.BROWSER || 'edge'),
      ...(msAuthPath ? { MSAUTH_PATH: String(msAuthPath) } : {}),
    };

    // Cloud runs should not use .env files; keep dotenv quiet/disabled if it gets loaded indirectly.
    env.LOAD_DOTENV = '0';
    env.DOTENV_CONFIG_QUIET = 'true';
    env.DOTENV_CONFIG_PATH = env.DOTENV_CONFIG_PATH || '__disabled__.env';

    // Always headless in cloud/service.
    if (runningOnService) {
      env.HEADED = '0';
      env.PWHEADLESS = '1';
    }

    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;

    const child = spawn(process.execPath, [playwrightCliJs, ...args], {
      cwd: functionRoot,
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
      // Keep the *tail* so the most recent logs (steps/errors) are preserved.
      output += str;
      if (output.length > maxBytes) {
        output = output.slice(output.length - maxBytes);
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

module.exports = { runCreateBridgeMsAuth };
