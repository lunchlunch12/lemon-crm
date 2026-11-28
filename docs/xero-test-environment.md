# Isolated Xero TEST preparation

Updated 28 November 2026. Owner approval covers a separate test deployment using synthetic data and Xero Demo Company. It does not permit live Xero access or production deployment.

## Production protection

Production automatic deployment from GitHub was disabled in Railway. The UI no longer has a connected trigger branch, and the connector's source configuration no longer contains `branch`. The existing production deployment remained unchanged and its public health endpoint returned HTTP 200. Do not reconnect the branch or enable automatic production releases during testing.

Workflow safety PR #2 was merged only after both push and PR CI checks passed. Main now contains its upstream-only mirroring, PR-closer and release guards, plus fork CI corrections. The Xero branch was updated through GitHub's conflict editor, preserving its secret scan. Xero PR #1 remains draft.

## TEST resources and isolation

- Separate private Railway project **Lemon Clean TEST**, environment **test**. It is not a production clone or a restored backup.
- Separate db, auth, rest, storage and application services, with new database and file volumes. Template-generated JWT and database secrets stay in Railway; no production credentials or records were copied or read.
- Application source pinned to CI-passing commit `dfbdc7c4f4643340dcab27ba686cddc32a0e4980`. Future branch pushes must not silently replace this tested application.
- Database built from the fork's original reviewed base, pinned to `36987955d11f063b24ab65d92211474d0107242a`, root `deploy/postgres`; the application applies its tested migrations only to TEST.
- App and DB resource limits: one vCPU/1 GB each; auth/rest/storage: half vCPU/0.5 GB each. These are resource ceilings, not a fixed bill or a guarantee of sufficient capacity under load. Hosting is usage-billed.
- Scheduled work off (`CREWTAVO_SCHEDULER=off`), `XERO_ENABLED=false`, `XERO_ALLOW_LIVE_CONNECTION=false`. TEST assistant OAuth registration disabled. No Resend, mailbox, Stripe, Twilio, Google, Jobber, live accounting or Railway control credentials are configured.
- A scheduler switch alone does not block every manual external action. Keep all destinations fictional and never add live provider credentials to this environment.

## First-owner and credential boundary

The inherited setup API gives the first visitor ownership. All five TEST services are now running, but a TEST-only Railway edge rule named **TEST setup locked until owner is ready** blocks `Path matches /*` with HTTP 403. Root, `/api/setup` and the Xero config path were verified blocked after the public domain's normal port 8080 routing was restored. Keep this rule enabled until the owner is present for account setup; do not leave a public unclaimed setup page running unattended. If this rule cannot be verified, stop the application or remove its public route. The owner must enter their own new TEST password and save recovery keys privately. An agent must not read those keys or enter a new authentication credential in the browser.

When the owner confirms readiness, remove/disable only this TEST setup rule, open the TEST app and hand over password/recovery-key entry immediately. The owner creates a business named **Lemon Clean TEST** and uses fictional clients at `example.test` addresses. Do not connect their real mailbox, payments or business records. Then create a separate standard OAuth Xero Web App using the exact TEST callback supplied privately, enter its Client ID and Secret directly into the TEST application service's protected Variables screen, and consent to **Xero Demo Company only**.

Keep Live mode blocked, all financial sync paused and the Xero PR in draft. Check owner/non-owner access, Demo selection, connection health, refresh/reconnect/disconnect, desktop and real iPhone Safari. Record actual acceptance results; mocked tests and generic browser CI do not prove real-provider consent works.

## Provisioning observation

Railway's service-update connector rejected settings for services that existed only in the staged template. Dashboard edits to those staged service settings did not persist in the effective config. The documented Alt+Deploy save-only action also initiated TEST builds in this session. Both initial source builds were aborted before use, then the settings were applied to the created services and verified through the connector. No production service was changed by this TEST operation. Do not assume a staged UI value or modifier key is proof of a saved configuration/no deployment.

The latest private owner handoff records current backend status, domain, pending actions and deployment IDs. Review that status rather than assuming an application is running because its Railway resources exist.

Railway reports successful deployments and one running replica for each of the five services. The application passed Railway's startup healthcheck, and TEST startup logs explicitly confirm `20261127000100_xero_connection_leases.sql` applied. Public HTTP 403 is intentional until first-owner setup. This proves deployment/startup and access protection, not real Xero consent or iPhone acceptance.
