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

- `http://localhost:7071/api/create-bridge?incidentId=155071351`

This will run `tests/create-bridge-manual-auth.spec.js` with:

- `INCIDENT_NUMBER=<incidentId>`
- `BROWSER` from `azure-function-app/local.settings.json` (defaults to `chrome`)

## Entra login redirect behavior

In Azure, you can enable **Authentication** for the Function App (Microsoft Entra ID). When enabled, clicking the function URL will first redirect you to Entra sign-in, and after sign-in the function will execute.

Locally (`func start`), that automatic Entra redirect is not provided by default.
