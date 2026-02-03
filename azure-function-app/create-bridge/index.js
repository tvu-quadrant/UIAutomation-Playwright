const { spawn } = require('child_process');
const path = require('path');
const { ensureMSAuthFile } = require('../shared/msAuth');

function readQuery(req, key) {
  // Azure Functions may populate req.query or req.queries
  return (req.query && req.query[key]) || (req.queries && req.queries[key]);
}

function runPlaywright({ repoRoot, incidentId, browserName, headed, timeoutMs, msAuthPath }) {
  return new Promise((resolve) => {
    const functionRoot = repoRoot;
    const runningOnService = Boolean(process.env.PLAYWRIGHT_SERVICE_URL);

    const args = runningOnService
      ? ['test', 'tests/create-bridge.spec.js', `--config=${path.join(functionRoot, 'playwright.service.config.cjs')}`, '--workers=1']
      : ['test', 'tests/create-bridge-manual-auth.spec.js', '--workers=1'];

    // Headed mode is not appropriate for cloud runners; force headless when using Workspaces.
    if (!runningOnService && headed) args.push('--headed');

    const playwrightCliJsCandidates = [
      path.join(functionRoot, 'node_modules', 'playwright', 'cli.js'),
      path.join(functionRoot, 'node_modules', '@playwright', 'test', 'cli.js'),
    ];

    const playwrightCliJs = playwrightCliJsCandidates.find((p) => require('fs').existsSync(p));

    const playwrightCliBin =
      process.platform === 'win32'
        ? path.join(functionRoot, 'node_modules', '.bin', 'playwright.cmd')
        : path.join(functionRoot, 'node_modules', '.bin', 'playwright');

    if (!playwrightCliJs && !require('fs').existsSync(playwrightCliBin)) {
      resolve({
        code: -4,
        timedOut: false,
        output: [
          'Playwright CLI not found.',
          playwrightCliJsCandidates.map((p) => `Tried: ${p}`).join('\n'),
          `Expected at: ${playwrightCliBin}`,
          'Run `npm install` in the repo root first.',
        ].join('\n'),
      });
      return;
    }

    const env = {
      ...process.env,
      INCIDENT_NUMBER: String(incidentId),
      BROWSER: browserName,
      ...(msAuthPath ? { MSAUTH_PATH: String(msAuthPath) } : {}),
    };

    // Always force headless on cloud runs.
    if (runningOnService) {
      env.HEADED = '0';
      env.PWHEADLESS = '1';
    }

    // Some environments inject NODE_OPTIONS (e.g. --require) that can break child Node processes.
    // Playwright is launched in a separate process; keep it isolated from host-level Node hooks.
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;

    const quoteForCmd = (value) => {
      const s = String(value);
      if (s.length === 0) return '""';
      // Minimal quoting: wrap if spaces/special chars; escape embedded quotes.
      if (!/[\s"&()\[\]{}^=;!'+,`~]/.test(s)) return s;
      return '"' + s.replace(/"/g, '\\"') + '"';
    };

    const isWin = process.platform === 'win32';
    // Prefer Node + cli.js to avoid Windows `.cmd` quoting edge-cases entirely.
    let exe;
    let exeArgs;
    if (playwrightCliJs) {
      exe = process.execPath;
      exeArgs = [playwrightCliJs, ...args];
    } else if (isWin) {
      exe = process.env.ComSpec || 'cmd.exe';
      // For cmd.exe, pass a single command-line string after /c so paths with spaces work.
      const cmdLine = [quoteForCmd(playwrightCliBin), ...args.map(quoteForCmd)].join(' ');
      exeArgs = ['/d', '/s', '/c', cmdLine];
    } else {
      exe = playwrightCliBin;
      exeArgs = args;
    }

    const debugInfo =
      String(process.env.DEBUG_PLAYWRIGHT_SPAWN || '').trim() === '1'
        ? {
            exe,
            exeArgs,
            cwd: repoRoot,
            execPath: process.execPath,
            nodeOptionsParent: process.env.NODE_OPTIONS,
            nodePathParent: process.env.NODE_PATH,
            nodeOptionsChild: env.NODE_OPTIONS,
            nodePathChild: env.NODE_PATH,
          }
        : undefined;

    const debugSpawn = String(process.env.DEBUG_PLAYWRIGHT_SPAWN || '').trim() === '1';
    if (debugSpawn) {
      // Avoid logging the entire environment; just the command that will be executed.
      try {
        // eslint-disable-next-line no-console
        console.log('[create-bridge] spawn:', { exe, exeArgs, cwd: repoRoot, execPath: process.execPath });
      } catch {
        /* ignore */
      }
    }

    // On Windows, verbatim argument mode can cause subtle quoting issues when the executable path
    // contains spaces (e.g. "C:\\Program Files\\nodejs\\node.exe"). Only use verbatim mode
    // when spawning cmd.exe with a single /c command-line string.
    const useWindowsVerbatimArguments = isWin && /cmd\.exe$/i.test(String(exe));

    const child = spawn(exe, exeArgs, {
      cwd: functionRoot,
      shell: false,
      windowsVerbatimArguments: useWindowsVerbatimArguments,
      env,
    });

    child.on('error', (err) => {
      resolve({ code: -3, output: `Failed to start Playwright: ${err?.message || err}`, timedOut: false, debug: debugInfo });
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
      resolve({ code: code ?? (timedOut ? -1 : -2), output, timedOut, debug: debugInfo });
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

  const repoRoot = path.resolve(__dirname, '..');

  const browserName = String(process.env.BROWSER || 'chrome').trim() || 'chrome';
  const headed = process.env.PLAYWRIGHT_SERVICE_URL ? false : String(process.env.HEADED || '1').trim() !== '0';
  const timeoutMs = 2 * 60 * 1000;

  // If running with Playwright Workspaces, ensure MSAuth.json exists (prefer Key Vault secret).
  let msAuthPath;
  if (process.env.PLAYWRIGHT_SERVICE_URL) {
    try {
      msAuthPath = await ensureMSAuthFile(repoRoot, { strict: true, log: (msg) => context.log(`[msauth] ${msg}`) });
    } catch (e) {
      return {
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: { ok: false, error: `Failed to fetch MSAuth from Key Vault: ${e?.message || e}` },
      };
    }
  }

  context.log(`Triggering Playwright create-bridge for incidentId=${incidentId}`);
  context.log(`Repo root: ${repoRoot}`);
  context.log(`Browser: ${browserName} (headed=${headed})`);

  const result = await runPlaywright({
    repoRoot,
    incidentId,
    browserName,
    headed,
    timeoutMs,
    msAuthPath,
  });

  const ok = result.code === 0;

  if (!ok) {
    const snippet = String(result.output || '').slice(0, 5000);
    context.log(`Playwright failed (exitCode=${result.code}, timedOut=${result.timedOut}). Output (truncated):`);
    context.log(snippet);
  }

  const body = {
    ok,
    incidentId: String(incidentId),
    exitCode: result.code,
    timedOut: result.timedOut,
    output: result.output,
  };

  if (result.debug) body.debug = result.debug;

  return {
    status: ok ? 200 : 500,
    headers: { 'content-type': 'application/json' },
    body,
  };
};
