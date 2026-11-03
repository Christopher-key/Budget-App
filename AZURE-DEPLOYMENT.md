# Deploy the budget website and its own account login

Users create a username and password **inside the budget app**. They do not need
Microsoft, Azure, or Meta accounts. Azure is the hosting provider behind the app.
The repository now contains app-account and encrypted-sync code; publishing the
website alone does not create its API or database.

## What is still needed from the app owner

1. Keep your existing Azure Static Web App and GitHub connection.
2. In your Azure subscription, choose an existing resource group and a region for
   the backend. Your Azure account is for managing hosting, not for app users.
3. Follow [the backend deployment steps](infra/README.md) to provision the Functions
   API, private runtime/package storage, and Cosmos database; publish the API ZIP.
   These resources may incur charges. Nothing creates them automatically on push.
4. Set the one public website variable below, then rerun the website workflow.
5. Test account creation, a second browser, and deletion with invented records.

No Entra app registration, OAuth redirect URI, Microsoft sign-in setup, Graph
permission, or user-facing Azure login is needed. The previous documentation
link was a developer setup placeholder, not a working account login.

## Connect the website to the API

Open **GitHub → Christopher-key/Budget-App → Settings → Secrets and variables →
Actions → Variables → New repository variable** and add:

| Variable | Value |
| --- | --- |
| `VITE_API_BASE_URL` | Your deployed API origin, for example `https://YOUR-API.azurewebsites.net`, without `/api` or a trailing slash |

This address is public configuration, not a credential. Never put server keys,
passwords, account proofs, financial records, or deployment tokens in a `VITE_`
variable. The old `VITE_AZURE_CLIENT_ID`, `VITE_AZURE_AUTHORITY`, and
`VITE_AZURE_SCOPE` variables are no longer used and can be removed.

Open **Actions → Azure Static Web Apps CI/CD → Run workflow**. When the run
succeeds, open your website using **Azure Portal → Static Web Apps → your app →
Overview → URL**, or the workflow's **Website address** summary.

The workflow preserves your existing resource-specific deployment-token secret
and deploys only `web/dist`. The separate **Cloud application checks** workflow
tests the backend and produces a `budget-api-package` artifact; it does not deploy
paid resources or grant GitHub access to your database. Without an API address,
the website explains that the owner needs to finish setup; it does not send users
to Microsoft documentation or provide a fake account.

## Account security and recovery

- The password stays in the browser. A deliberately slow password derivation
  produces separate login and encryption keys. The API stores only a salted,
  slow-hashed, server-peppered login verifier, not the password or raw login proof.
- Budgets are encrypted in the browser using AES-256-GCM before upload. The
  random budget key is stored on the server only in password-encrypted form.
- Account sessions, decrypted records, and usable encryption keys stay in page
  memory. Reloading or signing out requires another account login. No persistent
  "remember me" token or financial browser cache is added.
- The four-digit app passcode is a second gate after account authentication. It
  does not replace the strong account password or encrypt the cloud budget key.
- The third consecutive wrong app passcode erases active account credentials,
  wrapped keys, encrypted budgets, and session grants without confirmation.
  Wrong public account passwords are rate-limited; they cannot erase an account.
- There is no email collection, password-reset mailbox, or server key recovery.
  A forgotten account password cannot recover encrypted budget data. Preserve
  your password securely outside this app if you need reliable future access.

See [security and privacy details](SECURITY-AND-PRIVACY.md) for access boundaries,
provider backups, metadata, exported copies, and the limits of excluding AI.

The existing native SwiftUI app is unchanged and remains local-only. The web app
works in Safari on iPhone and on a computer, but this release does not silently
sync the separate native app's records. A native encrypted-sync bridge remains a
separate change.

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
./web/node_modules/.bin/tsx --test Verification/cloud-integration.ts
./infra/package-api.sh /tmp/budget-api-test.zip
```

Use invented records only in test fixtures, screenshots, build artifacts, and
support requests. Never commit a private deployment parameter file.
