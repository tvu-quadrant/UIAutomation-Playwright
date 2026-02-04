# PW Trigger Flow (Landing ➜ Azure Functions ➜ Playwright Workspaces)

This doc summarizes what happens from clicking **Create bridge** on the landing page through to a Playwright test running (cloud browsers via Azure Playwright Workspaces) and where to look for status + HTML report.

## 1) Click “Create bridge” (Landing page)

- Entry point: `GET /api/landing`
- Implementation: [azure-function-app/landing/index.js](azure-function-app/landing/index.js)

When you click a card’s **Create bridge** button:

- The browser opens a new tab to:
  - `https://<functionapp>.azurewebsites.net/api/create-bridge-msauth-async?incidentId=<INCIDENT_ID>`
- The landing page builds that URL from:
  - `CREATE_BRIDGE_BASE_URL` (if set), else the request host headers (`x-forwarded-host`/`host`).
- The endpoint name can be overridden by:
  - `CREATE_BRIDGE_ENDPOINT` (defaults to `create-bridge-msauth-async`).

## 2) HTTP Trigger: enqueue an async run

- Endpoint: `POST /api/create-bridge-msauth-async?incidentId=...`
- Implementation: [azure-function-app/create-bridge-msauth-async/index.js](azure-function-app/create-bridge-msauth-async/index.js)

What it does:

- Validates `incidentId`.
- Creates a `runId`.
- Writes an initial run-status record (state `queued`) to Blob Storage.
- Enqueues a message to the queue for the worker:
  - Message includes `runId` and `incidentId`.
- Returns JSON immediately so the HTTP request does not time out.

Typical response:

```json
{ "runId": "<uuid>", "incidentId": "154896693", "state": "queued" }
```

## 3) Poll status: run-status API

- Endpoint: `GET /api/run-status?runId=<runId>&includeLogs=0|1`
- Implementation: [azure-function-app/run-status/index.js](azure-function-app/run-status/index.js) and [azure-function-app/shared/runStatus.js](azure-function-app/shared/runStatus.js)

What it does:

- Reads the run’s status JSON from Blob Storage (using `AzureWebJobsStorage`).
- Optionally includes a log/event stream when `includeLogs=1`.

This is the primary way to track progress from outside the worker.

## 4) Queue Trigger: worker executes Playwright

- Trigger: queue message from step (2)
- Implementation: [azure-function-app/create-bridge-msauth-worker/index.js](azure-function-app/create-bridge-msauth-worker/index.js)

High-level worker steps:

1. **Mark run as running** in run-status.
2. **Ensure MSAuth storageState exists** (downloads/validates `MSAuth.json` into a writable path such as `C:\home\data` on Azure).
3. **Run Playwright** (spawns Playwright test execution).
4. **Upload HTML report** to this project’s Blob Storage container.
5. **Mark run as succeeded/failed** with exit code and attach report URL.

### MSAuth.json handling (storageState)

- The worker ensures a valid `MSAuth.json` exists at runtime (cloud-safe path).
- This avoids relying on local files under `wwwroot` (which can be read-only in run-from-package).

Related helpers live under:
- [azure-function-app/shared/msAuth.js](azure-function-app/shared/msAuth.js)

## 5) Playwright execution (cloud browsers)

The worker launches Playwright in “Workspaces” mode:

- Uses Azure Playwright Workspaces connectivity (`PLAYWRIGHT_SERVICE_URL`).
- Uses service config:
  - [azure-function-app/playwright.service.config.cjs](azure-function-app/playwright.service.config.cjs)

Key characteristics:

- Tests are executed from:
  - [azure-function-app/tests](azure-function-app/tests)
- Primary flow test:
  - [azure-function-app/tests/create-bridge.spec.js](azure-function-app/tests/create-bridge.spec.js)
- UI helper logic:
  - [azure-function-app/tests/helpers/findCreateBridge.js](azure-function-app/tests/helpers/findCreateBridge.js)

### “Trigger test in details” (what happens inside the test)

The test’s core flow is:

1. Navigate to IcM portal overview page.
2. Search for the provided `incidentId`.
3. Open incident details.
4. Open **Create bridge** (direct button or via **More actions** fallback).
5. Select the **Engineering** option (Fluent UI radio).
6. Click the correct **Save** button (the enabled primary Save in the dialog).
7. Wait for a success message.

This is instrumented with log steps (`step 1/7 … step 7/7`) that appear in run-status output.

## 6) HTML report upload (project-owned Blob Storage)

Because Playwright Workspaces report storage may not exist / may be disabled, the worker uploads reports to this project’s own storage account:

- Helper: [azure-function-app/shared/uploadPlaywrightReport.js](azure-function-app/shared/uploadPlaywrightReport.js)
- Container (default): `playwright-reports`
- Blob prefix: `reports/<runId>/...`
- Report entry point: `reports/<runId>/index.html`

The worker writes this into run-status as `reportUpload.indexUrl`.

## 7) End-to-end timeline (condensed)

1. User clicks **Create bridge** on landing page
2. Browser opens `/api/create-bridge-msauth-async?incidentId=...`
3. HTTP function enqueues queue message + returns `runId`
4. Client polls `/api/run-status?runId=...`
5. Queue worker runs Playwright Workspaces test
6. Worker uploads HTML report to Blob Storage
7. run-status becomes `succeeded` (or `failed`) and includes `reportUpload.indexUrl`

## 8) Operational notes

- **Reports “public” access** depends on the Storage Account setting “Allow blob public access” and app settings such as `REPORTS_PUBLIC_ACCESS`. If public access is disallowed, `indexUrl` will still exist but may require credentials/SAS.
- **Writable paths on Azure**: reports/artifacts should be written under `C:\home\data` (or temp) rather than `wwwroot`.

## 9) Quick URLs (examples)

- Landing:
  - `https://uiauto-pw-func-254394.azurewebsites.net/api/landing`
- Enqueue run:
  - `https://uiauto-pw-func-254394.azurewebsites.net/api/create-bridge-msauth-async?incidentId=154896693`
- Poll:
  - `https://uiauto-pw-func-254394.azurewebsites.net/api/run-status?runId=<runId>&includeLogs=1`
