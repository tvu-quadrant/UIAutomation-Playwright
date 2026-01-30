const { spawn } = require('child_process');
const path = require('path');

function readQuery(req, key) {
  // Azure Functions may populate req.query or req.queries
  return (req.query && req.query[key]) || (req.queries && req.queries[key]);
}

function runPlaywright({ repoRoot, incidentId, browserName, headed, timeoutMs }) {
  return new Promise((resolve) => {
    const args = ['test', 'tests/create-bridge-manual-auth.spec.js', '--workers=1'];

    if (headed) args.push('--headed');

    const playwrightCli =
      process.platform === 'win32'
        ? path.join(repoRoot, 'node_modules', '.bin', 'playwright.cmd')
        : path.join(repoRoot, 'node_modules', '.bin', 'playwright');

    if (!require('fs').existsSync(playwrightCli)) {
      resolve({
        code: -4,
        timedOut: false,
        output: [
          'Playwright CLI not found.',
          `Expected at: ${playwrightCli}`,
          'Run `npm install` in the repo root first.',
        ].join('\n'),
      });
      return;
    }

    const env = {
      ...process.env,
      INCIDENT_NUMBER: String(incidentId),
      BROWSER: browserName,
    };

    const isWin = process.platform === 'win32';
    const exe = isWin ? (process.env.ComSpec || 'cmd.exe') : playwrightCli;
    const exeArgs = isWin ? ['/d', '/s', '/c', playwrightCli, ...args] : args;

    const child = spawn(exe, exeArgs, {
      cwd: repoRoot,
      shell: false,
      windowsVerbatimArguments: isWin,
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
      try { child.kill(); } catch { /* ignore */ }
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? (timedOut ? -1 : -2), output, timedOut });
    });
  });
}

module.exports = async function (context, req) {
  const incidentId = readQuery(req, 'incidentId') || readQuery(req, 'incidentID') || readQuery(req, 'incident') || readQuery(req, 'id');

  if (!incidentId) {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: {
        ok: false,
        error: 'Missing required query parameter: incidentId',
        example: '/api/create-bridge?incidentId=155071351'
      },
    };
  }

  const repoRoot = path.resolve(__dirname, '..', '..');

  const browserName = String(process.env.BROWSER || 'chrome').trim() || 'chrome';
  const headed = String(process.env.HEADED || '1').trim() !== '0';
  const timeoutMs = Number(process.env.FUNCTION_TIMEOUT_MS || 20 * 60 * 1000);

  context.log(`Triggering Playwright create-bridge for incidentId=${incidentId}`);
  context.log(`Repo root: ${repoRoot}`);
  context.log(`Browser: ${browserName} (headed=${headed})`);

  const result = await runPlaywright({
    repoRoot,
    incidentId,
    browserName,
    headed,
    timeoutMs,
  });

  const ok = result.code === 0;

  if (!ok) {
    const snippet = String(result.output || '').slice(0, 5000);
    context.log(`Playwright failed (exitCode=${result.code}, timedOut=${result.timedOut}). Output (truncated):`);
    context.log(snippet);
  }

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
