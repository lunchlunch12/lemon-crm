# Lemon Clean CRM: repository review, development plan and roadmap

Prepared 25 November 2026. Status: **planning only; no Railway changes or live integration calls**.

## 1. What was inspected and what remains unknown

Repository: `lunchlunch12/lemon-crm`, a confirmed GitHub fork of `jviars/crewtavo`. Inspected commit: `36987955d11f063b24ab65d92211474d0107242a`, matching upstream tag `v0.5.5`. Fork `main` and fetched upstream `main` were identical at inspection (zero commits ahead/behind).

The complete tracked file tree was inventoried: 2,197 files, including 324 database migrations and 215 files in `supabase/tests`. The review covered the repository structure and deployment, startup, migration/restore, encryption, OAuth/MCP, integration, branding, mobile/offline and CI paths, with searches across application and database code. It is an architecture and deployment-safety review, not a line-by-line correctness/security audit of every file or a completed runtime test.

No packages were installed, app started, database contacted, migration run or application test executed during this documentation task. Existing tests and commands were inspected. They must pass in the isolated development setup before deployment is approved.

| State | Evidence |
| --- | --- |
| Confirmed | GitHub fork is accessible; default branch is `main`; upstream relationship and starting commit verified |
| Reported by owner | Original Crewtavo runs on Railway; ChatGPT is successfully connected |
| Not inspected | Railway project, services, deployed image/commit, variables, backups, database contents, storage mode, domain, auto-update settings and live integration configuration |
| Not created | Railway test environment, Codex reusable environment, branch protections, production cutover, rebrand or Xero integration |

The current public GitHub repository is suitable for code and documentation. Customer records, database backups, keys and business-private exports must never be committed there.

## 2. Recommendation in everyday terms

Keep the working business system in place. Build a separate practice system, prove changes there, then replace only the program running in the live app service. Keep the live database, sign-in service, files, web address and secrets where they are.

This avoids moving the business to an empty new installation and gives the best chance of preserving the existing ChatGPT connection. It still needs a version comparison and rehearsal: the fork's newest code may be newer than the live version.

Three different things are involved:

| Thing | What it does | Proposed approach |
| --- | --- | --- |
| GitHub repository | Stores code and its change history | Fork remains the source for Lemon Clean changes |
| Codex development environment | A workbench for editing code and running checks | Local computer or cloud; synthetic data, no production secrets |
| Railway production/test systems | Run the app people use | Keep live services; create an independent test stack |

```text
Original Crewtavo ── reviewed update branch ─┐
                                          v
Feature branch -> pull request -> checks -> test Railway -> review
                                                        |
                                  merge to main; retest resulting commit
                                                        |
                                           owner approves live release
                                                        |
                                 existing live app runs tested fork code
                                 existing live database/Auth/files retained
```

A branch is a separate draft of the code. A pull request is the review page showing the proposed changes. Staging means the practice version. Production means the real business system.

## 3. Repository map and findings

### How the app runs

This is one repository with three npm workspaces: React/Vite browser app in `apps/web`, Hono API in `apps/api`, and shared rules in `packages/core`. The production Dockerfile uses Node 22, builds `dist/server`, and includes PostgreSQL 17 backup/restore tools. The Node server serves the app and `/api`, runs background tasks, serves `/mcp`, and forwards requests to its own Auth/REST/Storage services.

The supplied Railway stack has five services:

| Service | Stores or handles | Preserve during first production switch |
| --- | --- | --- |
| `crewtavo` | Web app, API, connector, migration runner, scheduled work | Service identity, domain, variables and private references; change code source only |
| `db` | PostgreSQL: clients, jobs, quotes, invoices, settings, users and grants | Existing service, image compatibility, credentials and attached data volume |
| `auth` | Supabase sign-ins/OAuth | Existing service/configuration and database-backed users/grants |
| `rest` | Database access enforcing row permissions | Existing service/configuration |
| `storage` | Photos/documents/receipts and backup files | Existing volume or bucket and storage configuration |

This table describes repository defaults, not verified live service names. Do not rename Railway services during the initial switch: variable references may use their names.

### Findings that affect the rollout

| Priority | Finding and source | Required response |
| --- | --- | --- |
| Before any live deployment | `server.ts` runs `scripts/migrate.mjs` at startup when a database URL is supplied | Compare deployed baseline, rehearse its upgrade; review all pending migrations |
| Before recovery/cutover | `lib/crypto.ts` derives encryption/signing keys from explicit `ENCRYPTION_KEY`, or Supabase service key derived from `JWT_SECRET` in stack mode | Keep exact values and derivation mode; preserve absent/present state, not merely variable names |
| Before test data copies | `notify.ts` prefers the company's connected mailbox; tokens are also in database `integration_secrets` | Empty environment variables and Mailpit alone do not make a copied database safe |
| Before production changes | `services/backups.ts` dumps business/auth/storage metadata, not actual uploaded file bytes or runtime secrets | Protect database + file storage + secrets separately; prove recovery |
| Before PR-based development | CI's Authorship step accepts `jviars`/GitHub identities; PR closer rejects non-owner authors | Adapt fork policies while retaining all useful tests |
| Before enabling workflows | GitLab mirror hard-codes `gitlab.com:jviars/crewtavo` | Disable/remove in fork; never add its deploy key |
| Before test infrastructure deployment | `.railway/railway.ts` hard-codes upstream repository | Prepare a fork/test-specific configuration; never run its apply command against live project |
| Before upgrade checks | `scripts/test-upgrade.sh` needs a release tag or explicit baseline; fork initially had no local tags | Fetch upstream tags into CI/local checkout without pushing them to fork or triggering releases |
| Before Xero | Provider registry/accounting code supports QuickBooks and Zoho; no Xero implementation was found | New adapter, database enqueue logic, UI and inbound sync design needed |
| Before branding | Name/logo appear in shell, HTML, manifest, notification text, MCP and many screens; internal strings also identify stored data/crypto | Target visible branding; preserve internal compatibility identifiers |

Existing tests cover core/API/web logic, database workflows and permissions, upgrades, whole-instance startup and Playwright browser/business flows. They provide a useful base; a workflow file alone does not prove checks pass for this fork. The README also says existing QuickBooks/Zoho sync has not been tested against live accounts.

### What must survive

- Business records/settings, users/passwords, roles, audit history and app connections live in Postgres, across more than just the public business tables.
- Photos and files live separately on storage volume/bucket. Their database entries alone cannot recover the bytes.
- JWT, database password, optional encryption key and provider credentials/configuration are essential operational state.
- ChatGPT uses the app's `/mcp` endpoint and Supabase OAuth sign-in. Preserve the current origin, `APP_URL`, `/mcp` and `/auth/v1` paths, Auth configuration, registrations/grants and secrets. See `mcp.ts`, `lib/authMetadata.ts`, `lib/stack.ts` and `lib/assistants.ts`.
- The app's own ChatGPT AI subscription/key option is a different connection from ChatGPT calling the CRM through MCP; do not confuse the two.
- Existing client links, cookies and browser offline queues should keep working. Avoid a global search/replace or an unrelated domain/service rename.

Connection continuity must be tested with the existing ChatGPT connection. Do not disconnect/reconnect it pre-emptively. A new test system gets a separately named test connector, if needed, with its own sign-in and read-only permission initially.

## 4. First manual task: read-only live inventory

These steps only inspect the working installation. Do not save settings, reveal keys in screenshots or press Deploy, Update, Sync, Restore or Delete.

1. Open Railway in your computer browser and open the project running the working CRM.
2. Check the environment name at the top. Record the project/environment names privately.
3. Open the app service, then **Settings**. Note its **Service Source**: image name/tag or GitHub repository/branch; root directory; build/start overrides; public domain and target port; healthcheck; replica count; auto-update/autodeploy status.
4. Open its latest successful deployment. Record the image digest/version or commit and deployment date. If a version is shown at `https://YOUR-EXISTING-DOMAIN/api/health`, record it. A healthy response is a basic readiness signal, not a full connection/data test.
5. Open each other service and record its source/version, private references and attached volume/mount path. Confirm whether Storage uses a volume or bucket. Do not detach anything.
6. In **Variables**, note the NAMES and whether each is set or references another service. Record the presence/absence of `ENCRYPTION_KEY` and the existing `APP_URL`; do not paste secret values into chat or GitHub. A later backup step will save values privately in a password manager.
7. Inspect the database and storage services' **Backups** tabs and the app's **Settings → Your data**. Record the last successful backup dates and any warnings. Do not trigger or restore anything during this inventory.
8. Record the existing ChatGPT connector URL and installed live integrations by name, plus whether notifications, scheduled automations and payments are active. Do not authorise, disconnect or send test messages.
9. Share only non-secret service names, source/version, domain if appropriate, storage mode and backup status for review. If a setting differs from this plan, adapt the plan before changes.

No live deployment can be declared ready until this inventory is checked. Unknowns include actual schema baseline, file backup coverage, provider callbacks and which services may auto-update independently.

## 5. Future setup: independent test system

**Do this in the next implementation phase, after the owner approves creating test resources and their cost. It is not part of the current execution.**

Prefer a separate Railway project called **Lemon Clean TEST**. It is easier for a nontechnical owner to distinguish and reduces mistaken cross-environment references. An isolated environment in the same project can also work, but duplicating production copies variables/configuration that must be checked before deployment. Neither method is a backup or automatically provides a safe copy of business data.

Suggested setup sequence:

1. First adapt fork CI, PR handling and the upstream-only mirror in a separate reviewed PR. Configure required checks/protection for `main` as available to the GitHub account. Do not weaken actual tests to make a green badge.
2. Prepare a test-only five-service configuration based on `docker-compose.yml`, `.railway/railway.ts` and `deploy/README.md`, targeting `lunchlunch12/lemon-crm`. Have Codex review the exact staged configuration before applying it.
3. In Railway create a **new** project named **Lemon Clean TEST**. Verify the name before applying the test configuration. Do not use Sync from the production project and do not link a CLI session to live resources.
4. Give its database and storage their own volumes. Generate new test `POSTGRES_PASSWORD` and `JWT_SECRET`; all services in this test stack must agree on their references. Use a new test encryption key if explicitly configured. Set its `APP_URL` and Auth site/redirect settings to its own test domain.
5. For the app choose the fork, the reviewed candidate branch and the root `Dockerfile`; keep repository root as build context, port `8080`, healthcheck `/api/health`, timeout `600`, and draining grace `30` seconds as the repository's baseline. Keep one replica. Initially set `CREWTAVO_SCHEDULER=off` and leave external integrations disconnected.
6. Before approving staged changes, verify every database/Auth/REST/Storage URL and bucket reference belongs to TEST. No production credentials, mailbox, payment keys, Railway control token, webhook forwards or assistant grants should be present.
7. Deploy TEST only. Create a test owner and fake customers, using addresses such as `customer@example.test`. Use a clear TEST label in the company name. Configure a mail catcher or stub transport when needed; do not add real customer destinations.
8. Check login, records, uploads, quote/invoice preview, schedule and permissions. Turn on background tasks in TEST only when all integrations are inert or use test accounts and the queued work has been reviewed.
9. Test on the computer and on iPhone Safari using this test URL. Verify the live app still has its original data/address/connection.

Test resources consume hosting/build/storage usage. Obtain a current Railway estimate based on the inspected plan and service sizes before creating them; no monthly dollar figure has been established here. A five-service staging stack can be paused between development periods when appropriate, but preserve its volumes. Codex usage, Railway hosting, and third-party API/test-account charges are separate.

## 6. Backups and recovery rehearsal

Before a production switch, save a current database dump off Railway, separately protect file storage, save required secrets privately, and demonstrate recovery into a quarantined new system. Check the app version's actual backup support first.

The app's built-in dump covers `public`, `private`, `hooks`, `supabase_migrations`, `auth`, and storage metadata. It is normally stored in the same instance's Storage, so that alone is not an off-site backup. `scripts/restore.mjs` is destructive to its target schemas, and `--replace` overrides its existing-business guard. Do not provide a production URL to it. Restore only to the verified empty rehearsal target.

Recovery rehearsal is separate from normal staging:

1. Schedule a quiet period and agree what can be briefly paused for a consistent database/files backup. Capture the exact running version/image as well as database migration state.
2. Once authorised, download a fresh app database backup under **Settings → Your data**. Protect the file outside the repository. Save the exact secrets privately; note whether the explicit encryption key was absent.
3. Back up file bytes using the actual Storage backend's supported process. Record object/volume identifiers, manifest/counts and representative file checksums. Verify recent photos/documents are covered. Railway volume backups have restore-location restrictions; choose a separate supported export/copy procedure for rehearsal where needed. Never attach the live volume to TEST.
4. Prepare a separate recovery target with verified outbound network blocking, no public ingress/webhooks and no application worker/scheduler. Restore the database and copies of files there using a version-specific reviewed runbook. Do not simply follow upstream's generic restore/start instructions on a live-connected clone.
5. While quarantined, remove copied provider tokens/configuration and production hosting controls, disable automations/autopay, neutralise queued sends/sync/charges, and remove push subscriptions and real destinations. Do not call provider revoke endpoints for copied production tokens. Preserve raw recovery evidence securely and use a sanitised copy for development.
6. Where a fidelity recovery test temporarily needs original encryption material, keep it only in the protected rehearsal, verify local decryption/auth without provider calls, then discard the rehearsal secrets with that environment. Normal TEST must use fresh keys and synthetic/sanitised data.
7. Compare key table counts, sample business records, users/roles/settings and file contents; rehearse pending migrations. Record actual recovery duration and results. Document code-only rollback compatibility or a full restore/forward-fix plan.

Setting `CREWTAVO_SCHEDULER=off` does not stop all outgoing actions. A real quarantine must block traffic and account for direct actions and database-held credentials. There is no complete staging kill switch verified in this repository.

## 7. Daily development and release process

Keep one long-lived business branch, `main`, and short feature branches. Production deployment is manual initially. The test service can follow a chosen feature branch while it is reviewed, then return to `main`. A separate permanent `staging` branch is optional later; it is not required now.

1. Describe one change and its pass/fail examples in plain language.
2. Codex creates a feature branch and a PR, works with fake data and runs the relevant checks.
3. Deploy the candidate to TEST only. Open the test URL on iPhone and computer; check the requested change and the existing quote → job → visit → invoice flow it touches.
4. Review the PR and checks. When authorised, merge into `main`. Retest the resulting `main` commit in TEST, including any merge differences.
5. Record that exact commit (and image digest if using a release image) and the current production baseline. A moving branch is not an immutable release: freeze additional merges during promotion, or use a pinned image built from the tested commit.
6. Show the owner the tested result, database changes, backup status and rollback/recovery plan. Obtain explicit approval for the live deployment.
7. Deploy the tested version manually; verify records, files, login, role restrictions, client links and the existing ChatGPT connection. Observe errors, scheduled tasks, sends and provider sync after the change without creating real financial/customer effects merely as a test.

Useful checks from `package.json`:

```bash
npm ci
npm run typecheck
npm test
npm run build:server
npm run test:db
npm run test:upgrade -- <verified-baseline-tag-or-commit>
```

The database checks need Docker and Bash (Linux CI or WSL). `test:e2e` and `test:browser` need the local Supabase/API stack and seeded demo data; use the existing CI setup rather than production URLs. The supplied demo is a paving business; it is useful for baseline checks, then add Lemon Clean-specific fixtures. Database types can be regenerated with `npm run db:types` after schema changes.

Adapt CI to run for every branch used by staging, not just `main`, if enabling automatic test deployments. Railway's **Wait for CI** can be an extra gate once the workflow triggers are correct. It does not replace required passing checks and explicit production release selection. Do not rely on it as database rollback protection.

## 8. Future production cutover: gated runbook

**Do not execute this yet.** Exact source-switch controls must be confirmed against the live inventory. The goal is changing only the existing app's source, not replacing the project.

1. Confirm the actual deployed version and migration history. Test that exact baseline's upgrade to the candidate, including existing records, in quarantine/TEST. Do not assume `v0.5.5` equals live.
2. Complete the backup/restore rehearsal, file checks and secret preservation above. Save the old app source/image digest and configuration privately. Agree the maintenance window and acceptable recovery time.
3. Address automatic upstream image updates in a separately approved step before promotion, including the database image and supporting service versions. Otherwise the live baseline can move during preparation. Pin known compatible versions; do not upgrade Postgres majors during this switch.
4. In Railway verify the original project/environment and open the existing **app** service. Under **Settings → Service Source**, select the fork (`Connect Repo` where offered) and the reviewed branch, retaining repository root/Dockerfile and all existing variables/domain/network references. Disable production GitHub autodeploy before the first applied source-change deployment; inspect staged changes before committing them. If the UI would deploy immediately, stop and use the reviewed pinned-image/manual path instead.
5. Require the exact tested commit/image. Root Dockerfile already builds both web and API. Do not set the source to `apps/web` alone, recreate the database, apply the full IaC definition, change encryption keys or move the domain.
6. Confirm port/healthcheck/grace settings against the existing inventory. Review staged changes: only intended app-source/deploy settings should change. Obtain final approval for these concrete changes, then deploy.
7. Watch startup/migration logs without exposing secrets. Confirm the new version is serving, then perform the acceptance checks below. A healthy deployment alone does not certify preserved records or OAuth.
8. Keep the old release available. If a problem occurs, decide whether the old code is compatible with the now-current schema. Use a tested code rollback only in that case; otherwise use the agreed forward fix or coordinated restore. A restore loses post-backup changes and may require payment/sync reconciliation, so never perform one automatically.

Acceptance: same clients/jobs/quotes/invoices/settings/users and permissions; expected recent photos/files; existing client links; current browser sign-ins as applicable; ChatGPT can perform an authorised read with its existing connection; no unexpected sends/charges/syncs; scheduler and backups work; no duplicate workers. Avoid a new live scheduler running beside an old one for longer than the designed deployment overlap.

## 9. Lemon Clean rebrand and business features

Rebrand after the fork baseline is working in TEST. Keep it in a separate PR from schema changes and cutover.

- Use **Lemon Clean** as the visible name, approved lemon logo/colours, and a clear TEST mark on the practice system.
- Cover sidebar/sign-in/setup, page title and metadata, home-screen manifest/icons, notifications, PDFs/emails, Client Hub/booking forms, MCP display title, and help/product copy. Inspect accessible contrast and both light/dark modes on iPhone and desktop.
- Keep `LICENSE`, `NOTICE`, copyright and third-party acknowledgements. Mark the product as modified and based on Crewtavo. NOTICE reserves the original name/logo for upstream releases; retain attribution without presenting this as official Crewtavo. Review source links so deployed modified source remains available as required by the project's licence.
- Keep internal package names, service names, crypto derivation constants, storage paths, cookies and offline/cache identifiers stable unless there is an explicit tested migration for them. Changing an encryption label for cosmetic reasons can make saved tokens unreadable.
- Configure NZD (already offered in core money code), Pacific/Auckland, NZ phone/address formats and date/unit conventions. Confirm existing invoice numbering, tax/GST settings and rounding with the owner before changes; do not rewrite historical invoices.
- Build around window/exterior cleaning: services and repeat intervals, property/access notes, weather holds, before/after photos, quote follow-up, recurring visits and job profitability. The existing generic Cleaning & Janitorial preset focuses on house cleaning and is not automatically Lemon Clean's service menu.

## 10. Two-way Xero roadmap

No Xero adapter was found. Existing accounting machinery (`integrations/accounting.ts`, `registry.ts`, `tokens.ts`, outbox, `sync_links` and database enqueue triggers) provides useful patterns. Several triggers explicitly select QuickBooks/Zoho, so adding a button alone would not enable Xero.

Suggested stages, each with its own review:

| Stage | Outcome | Gate before progressing |
| --- | --- | --- |
| Design | Choose field owners and map customers, invoices, payments, credits, accounts and tax codes | Owner approves which side may change each field and how conflicts appear |
| Connect/read | OAuth sign-in to a Xero demo organisation; show connection and reconciliation preview | Tenant isolation, encrypted tokens, refresh/reconnect failures tested |
| Controlled export | Preview contacts/draft invoices, then explicit export | Repeated export creates no duplicates; partial failure and retry tested |
| Inbound updates | Bring back invoice/payment status and approved edits | Signed webhook handling plus reconciliation/polling; replay/order/loop tests |
| Limited live pilot | Small approved set of records with sync audit screen and pause/retry controls | Human verifies totals, balances and reconciliation; no double-counted Stripe/Xero payments |
| Broader two-way sync | Only agreed fields sync both ways | Conflict/credit/void/refund/delete policy and operational recovery proven |

Initial proposal to confirm: CRM owns service delivery and operational notes; Xero owns posted accounting/reconciliation. Issued invoices and reconciled payments need explicit conflict handling. Do not use automatic last-write-wins for money.

Engineering requirements: encrypted OAuth tokens and atomic refresh coordination, organisation/tenant scoping on every mapping, stable external IDs, duplicate prevention on retries, an outbox/inbox, bounded backoff/rate limits, webhook signature validation and replay handling, loop prevention, audit trails, a failed-sync queue and periodic reconciliation. Validate actual Xero endpoints/scopes/limits and developer-plan costs from official docs at implementation time. No live Xero credentials or connection are needed to write the initial specification.

## 11. Work from iPhone and computer

Use a reusable Codex Cloud environment for work that should continue when the computer is asleep. On computer, open **Work in → Cloud → Select environment → Create environment**, select this fork, request Node 22 and `npm ci`, review the setup and publish it as **Lemon Clean Development**. Verify Docker-based checks are actually supported; otherwise run them in GitHub Linux CI. Supply no production secrets. These steps are documented options; this account's environment/mobile setup has not been tested.

On iPhone, open Codex in the ChatGPT app, select the cloud environment and ask for a focused change and PR. Review progress/diffs there; test the Railway TEST URL in Safari. If the cloud option is unavailable, use the web/desktop setup and inspect account/workspace availability rather than assuming the feature exists.

Alternatively, pair the desktop under **Settings → Connections → Control this Mac or PC**, scan its QR code and use the same account/workspace on iPhone. That route needs the PC awake and online. Availability varies by rollout/settings.

Use GitHub branches/PRs to share code between devices. A cloud coding environment is not the Railway test app, and GitHub connection alone does not create either. Commit work before moving between environments; local files are not automatically present on another machine.

Suggested request from either device:

> In lunchlunch12/lemon-crm, read AGENTS.md and implement [one feature] on a feature branch. Use synthetic data, run relevant checks and open a PR. Do not merge, deploy production, access live credentials or change live integrations. Give me a test URL only if staging deployment has been authorised.

## 12. Ordered milestones and completion criteria

| Order | Milestone | Completion evidence |
| --- | --- | --- |
| 0 | Repository review and documented plan | This report and root AGENTS.md; documentation-only PR, unmerged |
| 1 | Live inventory and recovery preparation | Verified version/config list, database/files/secrets protection and successful isolated restore |
| 2 | Fork development foundation | Adapted workflows, passing baseline CI, branch review rules and repeatable development setup |
| 3 | Independent Railway TEST | Five isolated services, fake data, no live effects; iPhone/desktop smoke checks |
| 4 | Fork production source switch | Tested baseline upgrade, approved cutover, preserved data/files/ChatGPT connection verified |
| 5 | Lemon Clean branding and workflow fit | Reviewed brand assets, NZ settings and window/exterior-cleaning acceptance tests |
| 6 | Xero staged implementation | Design → demo read/preview → controlled export → inbound → approved pilot |
| Ongoing | Upstream maintenance | Recorded upstream base, reviewed update PR, migration/CI/brand checks, TEST acceptance |

No dates or effort promises are set until the live inventory and development baseline are known. Start with reliability and business-critical workflows before adding broad features.

## 13. Keep receiving upstream improvements

Retain Git history and a remote named `upstream` for the original repository. Fetch updates, create a dedicated `upstream/<version-or-date>` review branch from the customised main, merge the desired upstream release there and review conflicts. Fetching does not change production. Never force-reset the fork or overwrite customised main with upstream.

Review migrations and ordering/collisions, crypto/auth contracts, provider credentials, workflow policies (including the authorship/mirror/PR closer), branding and dependencies. Import the desired changes into a PR, run CI and the production-baseline upgrade rehearsal, test, then release through the same gate as a new feature. Keep a small log of Lemon Clean customisation points and the last integrated upstream commit.

For developers, read-only preparation begins with:

```bash
git remote add upstream https://github.com/jviars/crewtavo.git
git fetch upstream --tags
```

Skip `remote add` if it already exists. Fetch tags for local/CI upgrade tests; do not push those tags to the fork. The inherited release workflow publishes on version tags. Avoid using `latest` as an unattended path from upstream into customised production.

## 14. Evidence and current documentation

Repository evidence is pinned to the inspected commit. Start at [the inspected tree](https://github.com/lunchlunch12/lemon-crm/tree/36987955d11f063b24ab65d92211474d0107242a) and inspect `Dockerfile`, `docker-compose.yml`, `.railway/railway.ts`, `deploy/README.md`, `docs/deploy.md`, `scripts/migrate.mjs`, `scripts/restore.mjs`, `scripts/test-upgrade.sh`, API `server.ts`, `mcp.ts`, `lib/crypto.ts`, `lib/stack.ts`, `lib/authMetadata.ts`, `lib/notify.ts`, `services/backups.ts`, integration registry/accounting/tokens, web `BrandMark.tsx`, `index.html`, `public/manifest.webmanifest`, `public/sw.js`, `lib/offline.ts`, and all four GitHub workflows. Future file changes can invalidate this assessment.

Official references checked on 25 November 2026:

- [Railway service sources](https://docs.railway.com/services) and [Dockerfile builds](https://docs.railway.com/builds/dockerfiles)
- [Railway isolated environments](https://docs.railway.com/environments), [autodeploy and CI gates](https://docs.railway.com/deployments/github-autodeploys), [volume backups and restore limits](https://docs.railway.com/volumes/backups)
- [Codex Cloud setup](https://learn.chatgpt.com/docs/environments/cloud-environments) and [mobile access](https://learn.chatgpt.com/docs/mobile)
- [Xero OAuth FAQs](https://developer.xero.com/faq/oauth2), [token/tenant management](https://developer.xero.com/documentation/best-practices/data-integrity/managing-tokens/), [webhooks](https://developer.xero.com/documentation/guides/webhooks/overview), [idempotent requests](https://developer.xero.com/documentation/guides/idempotent-requests/idempotency/)

Railway, GitHub, Codex and Xero controls/availability may change. Verify the actual account UI before applying a later setup runbook; do not treat uninspected account settings as confirmed.
