# Azure Function: trigger Playwright

This folder contains a minimal Azure Functions HTTP trigger you can run locally.

## Prereqs

- Azure Functions Core Tools (`func`)
- Node.js
- NPM dependencies installed in this folder (`azure-function-app`) via `npm install`

Notes:
- For Playwright Workspaces (cloud browsers), you do **not** need to install local browser binaries.
- To avoid downloading browsers during install, set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`.

## Run locally

From the repo root:

```powershell
cd azure-function-app
npm install
func start
```

Then open:

- `http://localhost:7075/api/create-bridge?incidentId=155071351`
- `http://localhost:7075/api/create-bridge-msauth?incidentId=155071351`
- `http://localhost:7075/api/create-bridge-workspace?incidentId=155071351`
- `http://localhost:7075/api/msauth-preflight`

Or open the landing page:

- `http://localhost:7075/api/`
	- Shows a mock incident grid with "Create bridge" links.
	- Set `CREATE_BRIDGE_BASE_URL` if your host/port differs (e.g. `http://localhost:7075`).

This will run `tests/create-bridge-manual-auth.spec.js` with:

- `INCIDENT_NUMBER=<incidentId>`
- `BROWSER` from `azure-function-app/local.settings.json` (defaults to `chrome`)

The MSAuth variant will run `tests/create-bridge.spec.js` (expects `MSAuth.json` in the repo root).

The **workspace** variant will run `tests/create-bridge.spec.js` using Azure Playwright Workspaces (cloud browsers).
It requires:
- `PLAYWRIGHT_SERVICE_URL`
- Azure credentials (locally: `az login`; in Azure: managed identity)
- `MSAuth.json` (preferably loaded from Key Vault; see below)

You can also verify MSAuth configuration/download without running Playwright:

- `GET /api/msauth-preflight`
	- By default it attempts to fetch `MSAuth.json` (Key Vault / `MSAUTH_BLOB_URL` / blob settings) and validates JSON shape.
	- Use `?fetch=0` to only report configuration (no download).

## Entra login redirect behavior

In Azure, you can enable **Authentication** for the Function App (Microsoft Entra ID). When enabled, clicking the function URL will first redirect you to Entra sign-in, and after sign-in the function will execute.

Locally (`func start`), that automatic Entra redirect is not provided by default.

---

# Step-by-step: run in Azure Playwright Workspaces (cloud browsers)

## 1) Create a Playwright Workspace

In Azure Portal:
- Create resource → **Playwright Workspaces**
- Pick region (this determines the browser endpoint URL)

From the Workspace → **Get Started**, copy the Browser Endpoint URL.

## 2) Set `PLAYWRIGHT_SERVICE_URL`

This repo uses the standard env var:
- `PLAYWRIGHT_SERVICE_URL=<your workspace browser endpoint>`

Local (PowerShell):
```powershell
$env:PLAYWRIGHT_SERVICE_URL = "https://<region>.api.playwright.microsoft.com/accounts/<...>/browsers"
```

Azure (Function App):
- Function App → **Configuration** → **Application settings** → add `PLAYWRIGHT_SERVICE_URL`

## 3) Choose authentication method

### Option A (recommended): Function App Managed Identity
1. Function App → **Identity** → System assigned → **On**
2. On the Playwright Workspace resource → **Access control (IAM)** → add a role assignment for that managed identity
	- If you’re unsure which built-in role to choose, start with **Contributor** on the workspace resource (tighten later).

### Option B: Local dev auth
```powershell
az login
```

## 4) Provide `MSAuth.json` securely (Key Vault)

The test `tests/create-bridge.spec.js` expects a Playwright storageState JSON.

Recommended approach for Azure:
1. Create an Azure Key Vault
2. Add a secret whose *value is the full MSAuth.json content* (JSON text)
3. Give the Function App managed identity **Get** permission for secrets
4. Configure Function App settings:
	- `KEYVAULT_URL=https://<your-kv-name>.vault.azure.net/`
	- `MSAUTH_SECRET_NAME=<secret-name>`

The endpoint `GET /api/create-bridge-workspace` will fetch the secret and write `MSAuth.json` at runtime.

## 4b) Alternative: put `MSAuth.json` in Azure Storage (Blob)

If you prefer “storage” instead of Key Vault, the Function can download `MSAuth.json` from a blob at runtime.

Configure these Function App settings:
- `MSAUTH_BLOB_CONTAINER` (default: `playwright`)
- `MSAUTH_BLOB_NAME` (default: `MSAuth.json`)

And one of:
- `MSAUTH_BLOB_CONNECTION` (Storage connection string), OR
- `MSAUTH_BLOB_ACCOUNT_URL` (example: `https://<account>.blob.core.windows.net/`) with managed identity RBAC, OR
- nothing extra (it will fall back to `AzureWebJobsStorage` connection string if present)

Upload example (uses the Function App’s storage account):
1. Azure portal → Function App → **Configuration** → find `AzureWebJobsStorage` (points to a storage account)
2. Azure portal → that Storage Account → **Containers** → create container `playwright`
3. Upload your local `MSAuth.json` as blob name `MSAuth.json`

Notes:
- Storing auth state in Storage is convenient, but Key Vault is usually the safer default.

## 5) Deploy the Azure Function

Prereqs:
- Azure CLI
- Azure Functions Core Tools

Typical flow (from `azure-function-app` folder):
```powershell
func azure functionapp publish <your-function-app-name>
```

Important:
- Set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` during build/deploy to keep packages small.
- Use a plan that supports your run duration (Consumption can time out; Premium is safer for long UI tests).

## 6) Trigger it

Call:
- `https://<yourapp>.azurewebsites.net/api/create-bridge-workspace?incidentId=155071351`

If you enable Function App Authentication (Entra ID), you’ll get the pre-execution login redirect.
