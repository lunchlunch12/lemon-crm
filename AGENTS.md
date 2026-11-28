# Lemon Clean CRM — instructions for coding agents

## Project and owner

This is Lemon Clean's customised fork of Crewtavo, for its window and exterior-cleaning business in Christchurch, New Zealand. The owner is not technical. Explain outcomes in plain language, give numbered steps for manual actions, and distinguish verified facts, proposals, and work still to do.

- Fork: https://github.com/lunchlunch12/lemon-crm
- Upstream: https://github.com/jviars/crewtavo
- Read [the development plan and roadmap](docs/lemon-clean-development-plan.md) before planning deployment or integration changes.
- Initial inspection: 25 November 2026, commit `36987955d11f063b24ab65d92211474d0107242a` (upstream `v0.5.5`). The fork and upstream `main` matched at inspection. Recheck before relying on that later.
- The owner reports the original app is live on Railway and connected to ChatGPT. On 27 November 2026 a read-only Railway inventory confirmed the Lemon CRM project has a production environment, five services and the app domain `crm.lemonclean.co.nz`; no separate test environment was found. Runtime secrets, live data, deployed source revision and connection continuity have not been verified. Repository configuration is not proof of production configuration.

## Current authorisation boundary

Latest owner request, 28 November 2026: complete real token renewal, remote disconnect and reconnect tests first. Once those pass, implement/test two-way customer/contact sync, reviewed duplicate matching, chart/GST retrieval, NZ inclusive/exclusive pricing, revenue/bank/clearing mappings, directional controls and safe sync history/errors. Use only Lemon Clean TEST and provider-confirmed Xero Demo Company. No production changes, live Xero, customer communications, real data in Git or invoice/payment writes. Keep PR #1 draft. Prepare invoice/payment implementation only after this stage is implemented and tested; retain the full original plan. The real renewal, remote disconnect and reconnect gate passed on 28 November 2026. Customer/contact implementation is under development; new-stage GitHub CI and deployed Demo acceptance remain required.

The owner has completed TEST account setup and Demo Company consent, and confirms desktop/iPhone connection checks work. TEST credential deployment succeeded, with scheduler off and live access blocked. These observations supersede older statements below that TEST does not exist or credentials/consent are absent. The private handover and validation outputs hold current acceptance evidence; do not copy private runtime IDs, credentials, provider responses or customer records into Git.

Verify the actual Railway deployment's `meta.commitHash` after every deployment. A configured `source.commitSha` did not pin a later variables-triggered build in this session: it used the newer branch head, which had only documentation differences and had passed CI. Do not treat source configuration as proof of the code running, or build an unreviewed branch head.

Latest owner approval, 27 November 2026: disable production automatic deployments, finish CI, merge **only workflow safety PR #2**, update the Xero branch from corrected main, continue Xero tests and prepare a separate Demo Company TEST deployment. PR #2 is merged as `4bb70105c136c2e57c934d732873d2f942355223`; the Xero branch contains it. Production auto-deploys are disabled and its running deployment was verified unchanged. Do not reconnect production to branch auto-deploys, merge PR #1 or deploy production. TEST provisioning with fresh data/secrets is authorised; live Xero access and real-data migration remain forbidden. Read [TEST preparation](docs/xero-test-environment.md) and the latest validation evidence.

Update 27 November 2026: the owner has authorised an implementation branch for the secure Xero connection/configuration interface, mocked tests and a review PR. Read [the comprehensive Xero plan](docs/xero-integration-plan.md) and [owner setup instructions](docs/xero-setup.md). Preserve the full requirements there across sessions. No live Xero consent, production deployment, real-data migration or customer communications are authorised. The earlier documentation-only boundary below describes the original assignment, not a prohibition on this newly requested development.

Xero's connection foundation now lives in `integrations/xero.ts` and `routes/xero.ts`, with its own owner/human-only UI and database-fenced refresh lease. It does not implement two-way financial sync. Live mode and all financial sync remain blocked; Xero financial data must not enter AI features/prompts. Runtime secrets only; use fictional fixtures. Read [validation results](docs/xero-validation.md) rather than claiming deployment or Demo Company acceptance has happened.

The initial task is repository inspection and planning/documentation only. Do not deploy, change Railway configuration, run migrations on live data, change domains, rotate secrets, restore a database, connect external apps, or modify live integrations under this task. A later explicit user request may authorise specific work; do not infer production deployment permission from permission to develop a feature.

Work on a feature/documentation branch and submit a reviewable pull request. Do not push directly to `main`, merge, publish a release, or deploy production without the owner's explicit authorisation. Keep production credentials out of local and cloud development environments.

## Architecture and important files

| Path | Purpose |
| --- | --- |
| `apps/web` | React, TypeScript, Vite web app; desktop, mobile and installed web app |
| `apps/api/src/server.ts` | Node server; serves web/API, gateway, startup migrations and scheduler |
| `apps/api/src/app.ts`, `routes`, `services` | Hono API, business operations, external effects |
| `apps/api/src/mcp.ts`, `assistant-tools` | ChatGPT/Claude connector, OAuth discovery, permissions and audit |
| `apps/api/src/integrations` | Provider registry, encrypted tokens, accounting/calendar adapters |
| `apps/api/src/lib/crypto.ts`, `stack.ts` | Stable encryption/signing derivation and Supabase service keys |
| `packages/core` | Shared rules, roles, money, time, presets, generated database types |
| `supabase/migrations`, `supabase/tests` | Postgres schema, row-level security, functions and database tests |
| `Dockerfile`, `docker-compose.yml` | Production app image and local five-service reference stack |
| `.railway/railway.ts`, `deploy` | Railway infrastructure definition and database image/template docs |
| `scripts`, `e2e`, `.github/workflows` | Build/migrate/restore tools, browser tests, CI and release workflows |

Use Node 22 to match CI and Docker. Use `npm ci` with the committed lockfile. Do not update dependencies incidentally.

## Data and connection preservation

- Starting the app with `SUPABASE_DB_URL` can apply migrations automatically. A healthcheck or failed deployment cannot undo schema changes already applied.
- Preserve production database/volume identities, Auth/REST/Storage services, file volume or bucket, `APP_URL`, existing MCP URL, and all service references during the initial fork switch.
- Preserve the EXACT `JWT_SECRET` and existing encryption configuration. If `ENCRYPTION_KEY` was absent, do not add it casually: that changes the derived key. Preserve explicit Supabase key material too where used outside stack mode.
- Never globally replace `crewtavo` strings. Crypto salts/info, signed token formats, storage keys, bucket paths, package imports, cookies, browser cache/offline queue names and environment variable names can be compatibility contracts.
- A database dump includes business records, sign-ins, settings and encrypted app connections; it excludes file bytes and runtime secrets. Recovery needs database + files + secrets + compatible software. Rehearse restoration in quarantine before production changes.
- Production connection continuity is a goal to verify, not a guarantee. Keep OAuth issuer/resource addresses, Auth data and grants stable, and test the existing ChatGPT connection after cutover.

## Test environment isolation

- Default to a separate Railway project, `Lemon Clean TEST`, with its own five services, database, volumes, domain, JWT/encryption secrets and synthetic customers. This is proposed, not yet created.
- Never point a test app, script or CI job at production services or buckets. Never connect staging to the production Railway API token or other live provider credentials.
- `CREWTAVO_SCHEDULER=off` stops scheduled work, not manual sends, direct API calls, webhooks or all third-party effects. It is not a complete sandbox.
- Mailpit is a fallback: a company's connected mailbox can take precedence. Removing environment credentials alone does not neutralise credentials stored in the database.
- A production restore must first enter a quarantined recovery environment: no public app traffic, scheduler, webhook forwarding or outbound provider access. Remove/sanitise credentials, queued sends/charges/syncs, push subscriptions, customer contact details and production hosting links before starting it as staging. Never revoke a copied token at its provider; that can revoke production access too.
- Start normal development with synthetic data. Keep raw backups and secrets outside Git, public issues, logs, screenshots, PRs and cloud environment snapshots.

## Development and verification

1. Read the requested area and existing tests; describe the acceptance criteria.
2. Make one focused change on `feature/<description>` or `docs/<description>`.
3. Test with synthetic data and report exact checks/results. Never claim a check ran when it did not.
4. For code changes run `npm run typecheck`, `npm test`, `npm run build:server`; use the full CI for release candidates. Database changes also require `npm run test:db`, `npm run test:upgrade` from the actual deployed baseline, and relevant end-to-end/browser tests. Database scripts need Bash and Docker; use Linux CI/WSL where appropriate.
5. Run `npm run test:e2e` and `npm run test:browser` against the local test stack/demo data for affected business flows. Validate desktop and iPhone Safari; emulation alone does not prove real iPhone behaviour.
6. For docs-only changes, verify references, diff and absence of secrets; application tests are not required merely to change prose.
7. Open a PR with what changed, why, validation, migration/connection risk and rollback approach. Identify manual steps separately.

Preserve database-enforced permissions and company scoping. Do not replace them with browser-only checks. Changes involving money, OAuth, backup, customer communications or assistant permissions need targeted failure-case tests.

Never edit or delete released migrations. Add new migrations using the existing ordered naming convention; check for upstream timestamp collisions. Prefer additive changes compatible with both old and new app versions. Regenerate database types with `npm run db:types` when needed. A code rollback is not a database rollback.

## Fork-specific work still required

Initial findings below are historical. The Xero branch restricts authorship/PR closing/GitLab mirroring to upstream, adds fork-baseline tag fetching and secret scanning, and adapts contribution/PR guidance. CI results and protections still require verification; IaC/release deployment changes remain pending.

- `.github/workflows/ci.yml` contains an authorship check hard-coded to `jviars`; adapt it for this fork, retaining the substantive tests.
- `close-pull-requests.yml` can close PRs from anyone other than the fork owner; replace/remove this policy for the intended workflow.
- `mirror-gitlab.yml` targets the original author's GitLab repository; disable/remove it in the fork. Never supply its deploy key.
- `.github/pull_request_template.md` and `CONTRIBUTING.md` describe upstream's closed contribution policy; adapt fork guidance without erasing attribution.
- `.railway/railway.ts` still targets `jviars/crewtavo`. Do not apply it to production. Prepare a separately reviewed test-only configuration later.
- `test:upgrade` needs upstream release tags/history. A new GitHub fork may lack tags; fetch them locally or to CI explicitly from upstream. Do not push upstream version tags to the fork casually: that can trigger the release workflow.
- Release publishing uses the fork's repository name, but assumes upstream version tags and `main`. Review before creating tags; no image publishing is authorised by this planning task.

## Rebranding and roadmap

Ship visible Lemon Clean branding separately from schema/integration changes. Review `BrandMark.tsx`, `apps/web/index.html`, public icons/manifest, service-worker notifications, emails/PDFs, setup/legal screens, MCP display metadata and product docs. Retain copyright, `LICENSE`, `NOTICE`, third-party notices and a truthful indication that this is a modified version based on Crewtavo. The repository's NOTICE reserves upstream branding; do not present the fork as official Crewtavo.

Support Lemon Clean's window/exterior-cleaning workflows. Confirm NZD, Pacific/Auckland, NZ addresses/phone numbers and the owner's tax settings; do not assume the generic house-cleaning preset fits. Avoid unrelated trade rewrites.

Roadmap order: (1) verify production inventory/backups; (2) adapt fork CI and create isolated staging; (3) baseline/restore/cutover rehearsal; (4) approved code-source switch preserving production services; (5) Lemon Clean branding and business workflows; (6) Xero connection and read-only reconciliation, controlled exports, then two-way sync; (7) ongoing reviewed upstream updates.

Xero is not implemented at the inspected commit. Existing QuickBooks/Zoho adapters are patterns, not a two-way Xero implementation. Start with an approved field ownership map, Xero demo organisation, encrypted OAuth tokens, tenant isolation, safe token refresh, duplicate prevention, signed/replayed webhooks, retry/rate-limit handling and an audit/reconciliation screen. Define who owns contacts, invoices, payments, credits and tax/account mappings before allowing writes. No automatic conflict overwrites, payment creation or live Xero connection under the initial task.

Fetch upstream updates onto a dedicated review branch, merge with history preserved, inspect migrations/workflows/branding/contracts, test, and promote through staging. Never reset the customised fork to upstream or blindly deploy upstream `latest`. Record the upstream base and tested release commits.
