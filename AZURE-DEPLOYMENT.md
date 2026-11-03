# View the website on your existing Azure Static Web App

Your existing Azure/GitHub link is preserved. Its workflow now installs and builds
the React app in `web/`, verifies it, and uploads **web/dist**. It no longer tries
to deploy the Swift source as a website.

## View it first

1. On GitHub, open **Actions → Azure Static Web Apps CI/CD**.
2. Open the latest run and wait for **Verify and deploy website** to finish.
3. Open the address in its **Website address** summary, or use **Azure Portal →
   your Static Web App → Overview → URL**.

You do not need to enter passwords or secrets into source files. The workflow
uses the existing resource-specific Azure deployment token in GitHub Secrets.
It does not create new Azure resources or deploy the API/database automatically.

Without the four public settings below, the website deliberately displays an
Azure connection/setup screen. That is a viewable, successfully deployed site;
sign-in and cloud budgets remain unavailable until their backend is configured.
There is no anonymous access to financial records or fake production account.

## Enable sign-in and synced budgets afterward

In **GitHub repository → Settings → Secrets and variables → Actions → Variables**,
add all four public values, then run the website workflow again:

| Variable | Value |
| --- | --- |
| `VITE_AZURE_CLIENT_ID` | Public application ID registered for the browser SPA |
| `VITE_AZURE_AUTHORITY` | Exact Microsoft tenant authority, such as `https://login.microsoftonline.com/TENANT_ID` |
| `VITE_AZURE_SCOPE` | `api://API_APPLICATION_ID/Budget.Access` |
| `VITE_API_BASE_URL` | HTTPS Functions origin, such as `https://YOUR-API.azurewebsites.net`; **no `/api` suffix** |

These are identifiers and URLs, not client secrets. Configure either all four or
none. The website uses authorization-code PKCE and requests only its own delegated
API scope. It does not request Graph, Mail, Files, or persistent refresh access.

The separately deployed Functions API and Cosmos database must exist before
sign-in/sync can work. [infra/README.md](infra/README.md) explains public app
registrations, least-privilege identities, deployment packages, costs, and an
explicit what-if/deploy process. Review that configuration before creating paid
resources. The existing Static Web App is sufficient to view the setup screen now.

## Privacy and deletion behavior in the web app

- Strong Microsoft sign-in is required before the app-passcode gate.
- The server counts consecutive wrong app passcodes across sessions. The third
  triggers account-budget deletion without a confirmation prompt. Microsoft
  account password failures are separate and are not available to this app.
- Budget data, access tokens, and unlock grants remain in browser memory; financial
  data is not persisted in localStorage, IndexedDB, or a service-worker cache.
- Financial requests are marked no-store. On locking, account erasure, or a changed
  deletion epoch, the client clears financial memory and stops stale uploads.
- The API removes the active ledger and retains a minimal pseudonymous deletion
  marker to prevent stale clients restoring it. Azure backups and external Excel
  copies are not instantly erased; retention limits are described in the infra notes.

The native iPhone cloud-sync bridge is a separate follow-up. This web release does
not silently connect the existing local-only Swift app to Azure, and its current
local passcode policy is unchanged. Account-wide deletion applies to connected
web sessions; do not treat an unlinked iPhone as a connected cloud device.

## Local verification

```sh
npm ci --prefix shared
npm run build --prefix shared
npm test --prefix shared
npm ci --prefix api
npm test --prefix api
npm ci --prefix web
npm test --prefix web
npm run build --prefix web
```

The cloud check workflow runs these checks with synthetic records. They cover
financial calculations, generated Excel packages, JWT authorization, shared
passcode failures, deletion races, account isolation, and browser session clearing.
No real financial records or credentials belong in this repository.
