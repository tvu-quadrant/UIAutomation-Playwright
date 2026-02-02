# Azure Function: trigger Playwright

This folder contains a minimal Azure Functions HTTP trigger you can run locally.

## Prereqs

- Azure Functions Core Tools (`func`)
- Node.js
- Playwright deps installed in the repo root (`npm install` and `npx playwright install`)

## Run locally

From the repo root:

```powershell
cd azure-function-app
func start
```

Then open:

- `http://localhost:7075/api/create-bridge?incidentId=155071351`
- `http://localhost:7075/api/create-bridge-msauth?incidentId=155071351`

Or open the landing page:

- `http://localhost:7075/api/`
	- Shows a mock incident grid with "Create bridge" links.
	- Set `CREATE_BRIDGE_BASE_URL` if your host/port differs (e.g. `http://localhost:7075`).

This will run `tests/create-bridge-manual-auth.spec.js` with:

- `INCIDENT_NUMBER=<incidentId>`
- `BROWSER` from `azure-function-app/local.settings.json` (defaults to `chrome`)

The MSAuth variant will run `tests/create-bridge.spec.js` (expects `MSAuth.json` in the repo root).

## Entra login redirect behavior

In Azure, you can enable **Authentication** for the Function App (Microsoft Entra ID). When enabled, clicking the function URL will first redirect you to Entra sign-in, and after sign-in the function will execute.

Locally (`func start`), that automatic Entra redirect is not provided by default.
