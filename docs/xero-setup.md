# Xero setup for Lemon Clean — owner instructions

## Current status - 28 November 2026

The separate TEST owner account and Demo Company connection are established. The owner confirmed connection checks on computer and actual iPhone. A check after the original access-token lifetime passed without signing in again; remote disconnect survived reload, and reconnect plus organisation selection/check succeeded. These observations supersede the historical pending statements below.

The customer/contact increment adds `accounting.contacts` to consent, retaining `offline_access` and `accounting.settings.read`. Existing grants still support connection checks and renewal. After CI and TEST deployment, reconnect to Demo Company only for contact permission. Contact switches start paused/off; reconnect never enables sync. New-stage deployed acceptance remains required. Invoice/payment/quote writes remain unavailable. Integration pricing basis and calculator do not change existing CRM invoice entry or totals; that work belongs to the financial stage. Imported Xero contacts trigger a persistent company AI privacy restriction. No production or live-Xero changes are authorised.

The remainder records the earlier connection release and setup process.

The CI-passing connection code is deployed only in an isolated **TEST** environment. Public access is temporarily blocked for first-owner setup. Do not connect your real Xero organisation, change live Railway variables, or disconnect Jobber.

Update 28 November 2026: the owner approved TEST preparation, and the Xero candidate passed full GitHub CI. All five Lemon Clean TEST services are healthy; the exact test callback is supplied in the owner's private handoff document. A TEST-only Railway edge rule must keep public access blocked until the owner is ready to create its first account: the first visitor to a fresh instance can claim ownership. No Xero client credentials have been entered or real provider consent performed. Read `xero-test-environment.md` before unlocking setup.

## Redirect address

The existing Railway custom domain was verified read-only on 27 November 2026. The eventual production redirect URI is:

```text
https://crm.lemonclean.co.nz/api/apps/xero/callback
```

This production address becomes usable only after separately approved code is deployed and the server's `APP_URL` uses its origin and `XERO_REDIRECT_URI` uses this complete callback. TEST uses its OWN domain followed by `/api/apps/xero/callback`; use the exact test callback from the owner's handoff. Do not point a test app's callback at production. You can register multiple permitted redirect URIs when appropriate; separate test/production developer apps are preferable.

## Create the developer app (manual, no connection yet)

1. Sign in to [Xero Developer](https://developer.xero.com/) and open **My Apps**.
2. Create a **Web App** using standard OAuth 2.0. Name it **Lemon CRM Test**. Do not choose a paid Custom Connection for this plan.
3. Enter the test application's real website and exact test redirect URI after its domain is approved. Use the production URI above only for the eventual production developer app. Do not invent a domain or deploy anything just to complete the form.
4. Use the free **Starter developer tier** if it meets the account's current requirements. This is different from a Xero accounting subscription. Recheck the portal's terms/limits; the plan records the current documented limits.
5. For this connection-only increment request `offline_access` and `accounting.settings.read`. The application constructs the consent request. Do not add deprecated `accounting.transactions` or financial write scopes for this stage.
6. Generate the Client Secret. Keep both it and the Client ID private. Do not paste them into this chat, GitHub, AGENTS.md, a screenshot or an issue.

## Enter credentials securely — only after test deployment approval

1. Open Railway and select the separate **TEST** project/environment. Confirm the name carefully. Do not select the current production environment for development.
2. Open the **application service** (not db, auth, storage or rest), then **Variables**.
3. Enter these variable names and their corresponding values privately:

| Variable | Value |
| --- | --- |
| `XERO_CLIENT_ID` | Client ID from the test Xero Web App |
| `XERO_CLIENT_SECRET` | Client Secret from the test Xero Web App |
| `XERO_REDIRECT_URI` | Exact test HTTPS address followed by `/api/apps/xero/callback` |
| `XERO_ENABLED` | `true` when the reviewed test code/config is ready |
| `XERO_ALLOW_LIVE_CONNECTION` | `false` |

4. Confirm `APP_URL` uses the same test origin. Keep the existing test encryption configuration stable. Do not rotate production keys or copy them into TEST.
5. Variable changes may redeploy. Review staged changes and obtain the agreed test-deployment approval before applying them. A code push/PR is not permission to deploy production.
6. In the test app, sign in as owner and open **Apps → Xero**. It shows only whether server credentials are set; it does not reveal the values.
7. Choose **Demo** mode, click **Connect to Xero**, and authorise **Xero Demo Company only**. Return to the app, choose the Demo Company and click **Check connection**.
8. Verify the selected organisation is marked Demo and the last successful check updates. All record synchronisation remains paused. There is no Sync Now financial operation in this version.

If your secret is entered incorrectly, replace it in Railway Variables. Do not send it to Codex for checking. If it has appeared publicly, treat it as exposed and rotate/revoke it through the provider's supported controls; deleting the visible text alone is not enough.

## What the controls mean

- **Read only:** connection/organisation checks only in this version. It does not import financial records.
- **Demo:** checks require a provider-confirmed Demo Company. Naming a real organisation “Demo” does not qualify.
- **Live:** unavailable. The server rejects attempts to enable it or unpause financial sync.
- **Reconnect:** repeats consent, then requires explicit organisation selection. It does not start sync.
- **Disconnect:** removes the selected Xero connection and forgets local credentials; no ledger records change. If nothing was selected, only the local pending grant is forgotten.
- **Forget locally:** clears local access even if the provider is unavailable. Xero may still list the app under Connected apps; remove it there manually if needed. Other organisations are not revoked automatically.

Before any later live-sync pilot, disable Xero automatic invoice reminders and review scheduled/repeating invoice sends and other sending apps. Lemon CRM will handle customer delivery. The integration does not disable existing Xero reminders automatically. Do not change those live settings during the present development task.

Testing this screen on a real iPhone and consenting to the Demo Company remain manual acceptance steps after a test deployment. Automated mocks do not prove the provider portal, account consent or Safari flow works end to end.
