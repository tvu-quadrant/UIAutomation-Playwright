const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function runCreateBridgeMsAuth({ functionRoot, incidentId, browserName, timeoutMs, msAuthPath }) {
  return new Promise((resolve) => {
    const runningOnService = Boolean(process.env.PLAYWRIGHT_SERVICE_URL);

    // Always run the MSAuth test.
    const configPath = path.join(functionRoot, 'playwright.service.config.cjs');
    const specPath = path.join(functionRoot, 'tests', 'create-bridge.spec.js');
    const configArg = runningOnService ? [`--config=${configPath}`] : [];
    const args = ['test', specPath, ...configArg, '--workers=1'];

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

    // Best-effort: ensure MSAuth.json exists in the Playwright process working directory.
    // (Some setups/logging expect it in the "workspace root".)
    let cwd = functionRoot;
    const debug = {
      cwd: functionRoot,
      msAuthPathInput: msAuthPath ? String(msAuthPath) : null,
      msAuthPathUsed: msAuthPath ? String(msAuthPath) : null,
      msAuthCopy: {
        attempted: false,
        from: msAuthPath ? String(msAuthPath) : null,
        to: null,
        ok: null,
        error: null,
      },
    };

    if (msAuthPath) {
      try {
        const dir = path.dirname(String(msAuthPath));
        if (dir && fs.existsSync(dir)) {
          cwd = dir;
          debug.cwd = dir;

          const cwdAuthPath = path.join(dir, 'MSAuth.json');
          debug.msAuthCopy.to = cwdAuthPath;

          if (fs.existsSync(String(msAuthPath))) {
            // Only copy if the file isn't already at the expected name in the cwd.
            if (path.resolve(String(msAuthPath)) !== path.resolve(cwdAuthPath)) {
              debug.msAuthCopy.attempted = true;
              try {
                fs.copyFileSync(String(msAuthPath), cwdAuthPath);
                debug.msAuthCopy.ok = true;
                env.MSAUTH_PATH = cwdAuthPath;
                debug.msAuthPathUsed = cwdAuthPath;
              } catch (e) {
                debug.msAuthCopy.ok = false;
                debug.msAuthCopy.error = e?.message || String(e);
              }
            } else {
              // Already in place.
              debug.msAuthCopy.ok = true;
              env.MSAUTH_PATH = cwdAuthPath;
              debug.msAuthPathUsed = cwdAuthPath;
            }
          } else {
            debug.msAuthCopy.ok = false;
            debug.msAuthCopy.error = 'source file missing';
          }
        }
      } catch (e) {
        debug.msAuthCopy.ok = false;
        debug.msAuthCopy.error = e?.message || String(e);
      }
    }

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
      cwd,
      shell: false,
      env,
    });

    child.on('error', (err) => {
      resolve({ code: -3, output: `Failed to start Playwright: ${err?.message || err}`, timedOut: false, debug });
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
      resolve({ code: code ?? (timedOut ? -1 : -2), output, timedOut, debug });
    });
  });
}

module.exports = { runCreateBridgeMsAuth };
