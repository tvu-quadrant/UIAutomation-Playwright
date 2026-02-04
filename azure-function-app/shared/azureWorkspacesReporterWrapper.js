const fs = require('fs');
const path = require('path');
const os = require('os');

function defaultReportDir() {
  const home = String(process.env.HOME || '').trim() || os.tmpdir();
  return path.join(home, 'data', 'playwright-report');
}

function resolveHtmlReportDirFromConfig(maybeConfig) {
  try {
    if (!maybeConfig || !Array.isArray(maybeConfig.reporter)) return null;
    const html = maybeConfig.reporter.find((r) => (Array.isArray(r) ? r[0] : r) === 'html');
    if (!html || !Array.isArray(html)) return null;
    const opts = html[1];
    if (!opts || typeof opts !== 'object') return null;
    const outputFolder = opts.outputFolder || opts.outputDir;
    if (!outputFolder) return null;
    return path.resolve(String(outputFolder));
  } catch {
    return null;
  }
}

async function waitForHtmlReport(reportDir) {
  const waitMs = Number(process.env.AZURE_PW_REPORT_WAIT_MS || 15000);
  const pollMs = Number(process.env.AZURE_PW_REPORT_POLL_MS || 250);
  const deadline = Date.now() + (Number.isFinite(waitMs) ? waitMs : 15000);
  const indexPath = path.join(reportDir, 'index.html');

  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(reportDir) && fs.existsSync(indexPath)) return;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

const AzureReporterModule = require('@azure/playwright/reporter');
const AzureReporter = AzureReporterModule?.default || AzureReporterModule;

class AzureWorkspacesReporterWrapper {
  constructor(options) {
    this._inner = new AzureReporter(options);
    this._reportDir = null;
  }

  async onBegin(...args) {
    this._reportDir = resolveHtmlReportDirFromConfig(args?.[0]) || defaultReportDir();
    try {
      console.log(`[azure-wrapper] enabled reportDir=${this._reportDir}`);
    } catch {
      // ignore
    }
    if (this._inner.onBegin) return await this._inner.onBegin(...args);
  }

  async onEnd(...args) {
    const reportDir = this._reportDir || defaultReportDir();
    try {
      const indexPath = path.join(reportDir, 'index.html');
      console.log(
        `[azure-wrapper] onEnd waitForReport dirExists=${fs.existsSync(reportDir)} indexExists=${fs.existsSync(indexPath)} dir=${reportDir}`
      );
    } catch {
      // ignore
    }
    await waitForHtmlReport(reportDir);
    if (this._inner.onEnd) return await this._inner.onEnd(...args);
  }

  async onExit(...args) {
    if (this._inner.onExit) return await this._inner.onExit(...args);
  }

  onConfigure(...args) {
    if (this._inner.onConfigure) return this._inner.onConfigure(...args);
  }

  onTestBegin(...args) {
    if (this._inner.onTestBegin) return this._inner.onTestBegin(...args);
  }

  onTestEnd(...args) {
    if (this._inner.onTestEnd) return this._inner.onTestEnd(...args);
  }

  onStdOut(...args) {
    if (this._inner.onStdOut) return this._inner.onStdOut(...args);
  }

  onStdErr(...args) {
    if (this._inner.onStdErr) return this._inner.onStdErr(...args);
  }

  onError(...args) {
    if (this._inner.onError) return this._inner.onError(...args);
  }

  printsToStdio(...args) {
    if (this._inner.printsToStdio) return this._inner.printsToStdio(...args);
    return true;
  }
}

module.exports = AzureWorkspacesReporterWrapper;
