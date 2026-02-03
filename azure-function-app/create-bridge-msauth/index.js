const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { ensureMSAuthFile } = require('../shared/msAuth');

function readQuery(req, key) {
  // Azure Functions may populate req.query or req.queries
  return (req.query && req.query[key]) || (req.queries && req.queries[key]);
}

function runPlaywright({ repoRoot, incidentId, browserName, headed, timeoutMs, msAuthPath }) {
  return new Promise((resolve) => {
    const runningOnService = Boolean(process.env.PLAYWRIGHT_SERVICE_URL);
    const configArg = runningOnService ? [`--config=${path.join(repoRoot, 'playwright.service.config.cjs')}`] : [];
    const args = ['test', 'tests/create-bridge.spec.js', ...configArg, '--workers=1'];

    if (!runningOnService && headed) args.push('--headed');

    const playwrightCliJsCandidates = [
      path.join(repoRoot, 'node_modules', 'playwright', 'cli.js'),
      path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js'),
    ];

    const playwrightCliJs = playwrightCliJsCandidates.find((p) => fs.existsSync(p));

    const playwrightCliBin =
      process.platform === 'win32'
        ? path.join(repoRoot, 'node_modules', '.bin', 'playwright.cmd')
        : path.join(repoRoot, 'node_modules', '.bin', 'playwright');

    if (!playwrightCliJs && !fs.existsSync(playwrightCliBin)) {
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
      try {
        // eslint-disable-next-line no-console
        console.log('[create-bridge-msauth] spawn:', { exe, exeArgs, cwd: repoRoot, execPath: process.execPath });
      } catch {
        /* ignore */
      }
    }

    const useWindowsVerbatimArguments = isWin && /cmd\.exe$/i.test(String(exe));

    const child = spawn(exe, exeArgs, {
      cwd: repoRoot,
      shell: false,
      windowsVerbatimArguments: useWindowsVerbatimArguments,
      env,
    });

    child.on('error', (err) => {
      resolve({
        code: -3,
        output: `Failed to start Playwright: ${err?.message || err}`,
        timedOut: false,
        debug: debugInfo,
      });
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
      resolve({ code: code ?? (timedOut ? -1 : -2), output, timedOut, debug: debugInfo });
    });
  });
}


module.exports = async function (context, req) {
  const t0 = Date.now();

  const logStep = (name, details) => {
    const ms = Date.now() - t0;
    const detailText = details ? ` | ${details}` : '';
    context.log(`[create-bridge-msauth] +${ms}ms ${name}${detailText}`);
  };

  const safeJson = (value) => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };

  const safeUrlForLog = (urlStr) => {
    try {
      const u = new URL(String(urlStr));
      return `${u.origin}${u.pathname}`;
    } catch {
      return null;
    }
  };

  logStep('request_received', `invocationId=${context.invocationId}`);

  const incidentId =
    readQuery(req, 'incidentId') ||
    readQuery(req, 'incidentID') ||
    readQuery(req, 'incident') ||
    readQuery(req, 'id');

  if (!incidentId) {
    logStep('missing_incidentId');
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: {
        ok: false,
        error: 'Missing required query parameter: incidentId',
        example: '/api/create-bridge-msauth?incidentId=155071351',
      },
    };
  }

  const repoRoot = path.resolve(__dirname, '..');
  let authFile = path.resolve(repoRoot, 'MSAuth.json');

  const runningOnService = Boolean(process.env.PLAYWRIGHT_SERVICE_URL);
  const runningInAzure = Boolean(String(process.env.WEBSITE_INSTANCE_ID || '').trim());
  logStep(
    'resolved_paths',
    `repoRoot=${repoRoot} | authFile=${authFile} | runningOnService=${runningOnService}`,
  );

  // Local dev convenience: allow using an MSAuth.json outside the Function App folder.
  // - If MSAUTH_PATH is set and points to an existing file, use it.
  // - Else if MSAUTH_FALLBACK_PATH is set and exists, use it.
  // - Else if running locally (no Workspaces) and repo-root MSAuth.json is missing,
  //   fall back to ../MSAuth.json (workspace root) if present.
  const envMsAuthPath = String(process.env.MSAUTH_PATH || '').trim();
  const envFallbackPath = String(process.env.MSAUTH_FALLBACK_PATH || '').trim();
  const autoFallbackPath = path.resolve(repoRoot, '..', 'MSAuth.json');

  const firstExisting = [envMsAuthPath, envFallbackPath].filter(Boolean).find((p) => fs.existsSync(p));
  if (firstExisting && firstExisting !== authFile) {
    authFile = path.resolve(firstExisting);
    logStep('msauth_using_env_path', `path=${authFile}`);
  } else if (!runningOnService && !fs.existsSync(authFile) && fs.existsSync(autoFallbackPath)) {
    authFile = autoFallbackPath;
    logStep('msauth_using_auto_fallback', `path=${authFile}`);
  }

  // Cloud behavior: always refresh MSAuth.json from the configured source (Blob/KeyVault).
  // This avoids reusing stale auth state between invocations.
  if ((runningInAzure || runningOnService) && !envMsAuthPath) {
    logStep('msauth_force_refresh', `azure=${runningInAzure} workspaces=${runningOnService}`);
    try {
      const fetchedInfo = await ensureMSAuthFile(repoRoot, {
        strict: true,
        returnInfo: true,
        log: (msg) => logStep('msauth_fetch', msg),
      });
      if (fetchedInfo?.path) {
        authFile = fetchedInfo.path;
        logStep('msauth_refreshed', safeJson({ path: fetchedInfo.path, source: fetchedInfo.source, meta: fetchedInfo.meta }));
      }
    } catch (e) {
      logStep('msauth_fetch_failed', safeJson({ message: e?.message || String(e) }));
      return {
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: { ok: false, error: `Failed to refresh MSAuth.json: ${e?.message || e}` },
      };
    }
  }

  // If the auth file isn't present in the Function App root, try to fetch it.
  // This supports cloud deployments where MSAuth.json is stored in Blob or Key Vault.
  if (!fs.existsSync(authFile)) {
    logStep('msauth_missing_local', 'attempting_fetch');
    try {
      const fetchedPath = await ensureMSAuthFile(repoRoot, {
        strict: true,
        log: (msg) => logStep('msauth_fetch', msg),
      });
      if (fetchedPath) {
        logStep('msauth_fetched', `path=${fetchedPath}`);
        authFile = fetchedPath;
      }
    } catch (e) {
      logStep('msauth_fetch_failed', safeJson({ message: e?.message || String(e) }));
      return {
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: { ok: false, error: `Failed to fetch MSAuth.json: ${e?.message || e}` },
      };
    }
  }

  // Validate MSAuth.json (existence + basic schema) without logging any secret contents.
  if (fs.existsSync(authFile)) {
    try {
      const stat = fs.statSync(authFile);
      logStep('msauth_exists', `path=${authFile} | bytes=${stat.size}`);
      const raw = fs.readFileSync(authFile, 'utf8');
      const parsed = JSON.parse(raw);
      const cookiesCount = Array.isArray(parsed?.cookies) ? parsed.cookies.length : null;
      const originsCount = Array.isArray(parsed?.origins) ? parsed.origins.length : null;
      const keys = parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 10) : null;
      logStep('msauth_valid_json', safeJson({ cookiesCount, originsCount, keysPreview: keys }));
    } catch (e) {
      logStep('msauth_invalid', safeJson({ path: authFile, message: e?.message || String(e) }));
      return {
        status: 412,
        headers: { 'content-type': 'application/json' },
        body: {
          ok: false,
          error: 'MSAuth.json exists but is not a valid Playwright storageState JSON.',
          expectedPath: authFile,
          details: e?.message || String(e),
        },
      };
    }
  }

  if (!fs.existsSync(authFile)) {
    logStep('msauth_still_missing', `expectedPath=${authFile}`);
    return {
      status: 412,
      headers: { 'content-type': 'application/json' },
      body: {
        ok: false,
        error: 'MSAuth.json not found in Function App root.',
        expectedPath: authFile,
        hint: [
          'Provide MSAuth.json via Blob Storage or Key Vault so the Function can download it at runtime.',
          'Fastest option: set MSAUTH_BLOB_URL to a (public or SAS) URL for the blob.',
          'Blob settings: MSAUTH_BLOB_CONTAINER, MSAUTH_BLOB_NAME (and optionally MSAUTH_BLOB_CONNECTION or MSAUTH_BLOB_ACCOUNT_URL).',
          'Key Vault settings: KEYVAULT_URL, MSAUTH_SECRET_NAME.',
        ].join(' '),
        debug: {
          hasPlaywrightServiceUrl: Boolean(process.env.PLAYWRIGHT_SERVICE_URL),
          hasAzureWebJobsStorage: Boolean(process.env.AzureWebJobsStorage),
          msAuthBlobUrl: safeUrlForLog(process.env.MSAUTH_BLOB_URL),
          msAuthBlobContainer: process.env.MSAUTH_BLOB_CONTAINER || null,
          msAuthBlobName: process.env.MSAUTH_BLOB_NAME || null,
          hasMsAuthBlobConnection: Boolean(process.env.MSAUTH_BLOB_CONNECTION),
          msAuthBlobAccountUrl: process.env.MSAUTH_BLOB_ACCOUNT_URL || null,
          keyVaultUrl: process.env.KEYVAULT_URL || null,
          msAuthSecretName: process.env.MSAUTH_SECRET_NAME || null,
        },
      },
    };
  }

  const browserName = String(process.env.BROWSER || 'edge').trim() || 'edge';
  const headed = process.env.PLAYWRIGHT_SERVICE_URL ? false : String(process.env.HEADED || '1').trim() !== '0';
  const timeoutMs = 5 * 60 * 1000;

  logStep(
    'run_config',
    safeJson({ incidentId: String(incidentId), browserName, headed, timeoutMs, runningOnService }),
  );

  logStep('starting_playwright');

  const result = await runPlaywright({
    repoRoot,
    incidentId,
    browserName,
    headed,
    timeoutMs,
    msAuthPath: authFile,
  });

  logStep('playwright_finished', safeJson({ exitCode: result.code, timedOut: result.timedOut }));

  const ok = result.code === 0;

  if (!ok) {
    const snippet = String(result.output || '').slice(0, 5000);
    logStep('playwright_failed', `exitCode=${result.code} | timedOut=${result.timedOut}`);
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
