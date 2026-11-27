# Lemon CRM: comprehensive two-way Xero integration

Updated 27 November 2026. Owner: Lemon Clean Ltd, New Zealand window and exterior cleaning.

## Current increment and boundaries

The owner's request is to build this incrementally, starting with a secure connection and configuration screen. **No production deployment, live Xero connection, customer communications or real-data migration is authorised.** This supersedes the earlier documentation-only boundary for development work, but does not authorise production changes.

This branch implements the connection foundation only: owner/human-only configuration, standard OAuth Web App with PKCE, one-use state/cookie binding, encrypted tokens and organisation selection, a database-fenced refresh lease, connection checking, reconnect/disconnect and read-only/demo controls. Live mode and all financial synchronisation are hard-disabled. Token refresh happens when connection operations need access; there is no new scheduled Xero job or financial worker.

Mock tests are required before review. Demo Company acceptance, full Docker database/upgrade tests and real iPhone acceptance remain separate gates. Code presence is not proof of a working production integration.

## Non-negotiable product rules

- Lemon CRM owns operations, property notes, cleaning history, signatures, acceptance and **all** emails, texts, receipts, quote/invoice delivery and reminders.
- Xero owns the authoritative accounting ledger, posted balances, chart of accounts, tax definitions and lock dates. Do not automatically change accounts, tax setup or reconcile transactions.
- Synchronise supported data in both directions, but compare versions and resolve conflicts instead of blindly overwriting financial records.
- Persistent tenant-scoped mappings and request identities must prevent duplicates and feedback loops. A timeout does not prove a write failed.
- Never call Xero invoice/quote email endpoints. Mark `SentToContact` only after confirmed CRM delivery, for statuses where the official API permits it.
- Imports and sync must suppress customer-communication side effects at the database/event boundary, not just omit an explicit email call. Existing invoice/payment triggers can enqueue automations.
- Use fictional fixtures and mocked responses in automated tests. Demo testing must use Xero Demo Company only. Never bring live Xero/Jobber data into development chats, screenshots, fixtures or AI prompts.

## Repository findings and development blockers

Reviewed base: `36987955d11f063b24ab65d92211474d0107242a` (upstream v0.5.5). The branch retains the earlier repository architecture report in `lemon-clean-development-plan.md`.

| Area | Existing architecture | Implication for Xero |
| --- | --- | --- |
| Accounting | `integrations/registry.ts`, `tokens.ts`, `accounting.ts`; QuickBooks/Zoho; outbound `outbox` tasks | Reuse catalogue, error/HTTP conventions, encryption and provider patterns; existing provider-specific writes are not Xero adapters |
| Contacts | `clients`, `properties`, customer APIs and assistant tools | Map financial contacts without copying property/operational notes to Xero |
| Invoices | `routes/sales.ts`, `services/sales.ts`, SQL functions, invoice lines/status/payment-derived balances | Introduce import-origin/version checks and event suppression before importing records |
| Payments | `payments.received_at`, Stripe integration, refunds/reversals and invoice rollups | Preserve Xero's recorded payment date; add sync timestamp and reconciliation metadata separately |
| Quotes | Rich quote lines, options, signatures, conversion to jobs/invoices | Loss-aware financial projection only; preserve richer CRM content and a single conversion identity |
| Integration storage | Encrypted `integration_secrets`; generic `integrations` metadata; tenant-aware accounting `sync_links` | New Xero state is kept encrypted, including tenant IDs; future sync mappings need protected storage and company/tenant constraints |
| Refresh | Generic provider single-flight is in-process | Xero uses a DB lease plus checked save, including across overlapping workers/reconnect/disconnect |
| Background tasks | `tasks.ts` scheduler, outbox retries, provider-specific enqueue triggers | Do not add Xero to current automatic accounting triggers before sync safeguards are ready |
| Assistant access | MCP tools, OAuth clients, company permissions and auditing | Human-only Xero routes reject assistant tokens; future imported financial data needs provenance/access boundaries before exposure to AI features |
| Hosting | Five-service Railway stack; automatic startup migrations | New migration is additive; never apply it to live data during development |

Inherited workflow blockers addressed in this branch: upstream-only authorship/automatic PR closer/GitLab mirror are restricted to the original repository. CI runs on feature/docs branches and PRs, retains substantive tests, fetches upstream baseline under a non-release tag for fork upgrade checks, and adds a checksum-pinned Gitleaks history scan. Source LF attributes prevent Windows checkout conversion from breaking SQL/source assertions and vendor SVG checksums. The original release workflow remains unchanged: do not create release tags or publish images under this task.

Three inherited test assertions were also made portable: font/source paths are compared after normalising Windows separators, and the English date assertion accepts both US and NZ ordering. These checks still enforce the same file locations/date; no application paths, dates or financial behaviour were changed to satisfy them.

History scanning initially reported 39 findings in inherited upstream tests: mock provider/link strings and self-signed test certificates/keys. Exact reviewed commit/file/rule/line fingerprints are listed in `.gitleaksignore`; there is no directory-wide or rule-wide exemption. New findings still block CI. This is a pattern scan and fixture-context review, not a guarantee that every possible secret can be detected. A genuine finding must be investigated and revoked/rotated, never merely added to the ignore file.

## Architecture for later synchronisation

Use a dedicated protected Xero sync subsystem, with incoming and outgoing queues, rather than letting generic API calls write directly to Xero. Persist:

- company + Xero tenant + entity + local ID + Xero ID mappings, with uniqueness on both sides;
- origin (`crm`, `xero`, `jobber_history`), cutover date and explicit export eligibility;
- last shared version/hash and field projection, source updated time and last successfully applied state;
- durable operation ID/idempotency key, request hash, status and ambiguous-outcome reconciliation state;
- webhook inbox identity/sequence, retry budget, cursors/watermarks with overlap, failed-sync queue and audit metadata;
- payment date (calendar date as supplied), `synced_at`, Xero reconciliation status and reversal/replacement links as separate fields.

Never treat an identical amount/date alone as proof of the same payment. Never change a mapping's tenant in place. A new organisation requires reviewed remapping/reconciliation; existing IDs belong to their original tenant. Pause/incoming/outgoing controls must be checked again immediately before each remote write and local apply, not only when queuing.

## Prioritised implementation plan and acceptance gates

### P0 — Connection and safe development (this PR)

- Configure credentials in protected runtime variables, not the browser or public repository.
- Default `XERO_ENABLED=false`/unset and `XERO_ALLOW_LIVE_CONNECTION=false`. Read-only is the default mode; demo selection verifies `Organisation.IsDemoCompany`, not a name match.
- OAuth uses a validated fixed redirect, minimal scopes, expiring signed state and browser cookie, persisted one-use nonce, PKCE, current-owner recheck at callback, and encrypted tokens.
- DB leases serialise mutation/refresh across processes. Save checks the current unexpired fencing token and writes metadata+secret atomically. Never return a newly rotated access token until persisted. A stale worker cannot overwrite a newer grant or resurrect a disconnected connection.
- Read-only and Demo controls are available. Live mode, unpause, all financial imports/exports and Sync Now are unavailable until implemented. Do not label a health check as a record sync.
- Disconnect removes the selected Xero connection only, not all tenants associated with a refresh token. Local forgetting is explicit and warns remote access may remain. No business records/mappings are deleted.
- Log/return fixed connection errors; never provider bodies, tokens, IDs or credentials. Private connection APIs are no-store and reject assistant sessions. No Xero financial APIs or customer communication imports are part of this increment.

Acceptance: all new mock tests pass; owner/non-owner/assistant access, replay/demotion, tenant selection, rotation/concurrency, stale-save fencing, failed saves, network/rate-limit failures, disconnect races and protected response fields checked. SQL permissions/fencing tests added. Full deployment/upgrade and Demo acceptance must pass before release.

### P1 — Accounting settings and migration preview, no financial writes

Read chart of accounts, tax rates, organisation currency and lock dates. Offer explicit revenue/bank/clearing/tax mappings without creating accounts or changing tax settings. Validate NZD; support inclusive/exclusive tax, the owner's 15% GST mapping, exempt/other treatments and Xero's rounding rules. Do not hard-code all tax as 15% or turn a tax amount into a tax code.

Add secure read-only record previews and matching, persistent protected mappings and import-origin controls. Show differences, ambiguous matches and the proposed cutover. Import historical records only after review, never automatically mark them exportable.

Acceptance: Xero remains untouched; history preserves dates/balances; no financial import creates notification, reminder, autopay, receipt or export work. Permissions and AI provenance boundaries tested.

### P2 — Contacts and compatible items, both directions

Contacts: names/company names, billing addresses, phones, emails, payment terms and supported status. Match known IDs first; propose name/email/number matches for owner review. Do not merge on names alone. Preserve property addresses/notes and cleaning history in CRM. Map archived status without deleting operational history.

Items/services: compatible codes, descriptions/prices and accounting defaults. Preserve operational quote formula/checklist information. Xero account/tax definitions remain authoritative. Record field-level shared versions and surface conflicting edits; support an explicit winner or manual correction.

Acceptance: repeated creates, edited names, missing email, archived/unarchived records, pagination and simultaneous edits cannot duplicate or silently overwrite contacts/items.

### P3 — Invoice export and permitted inbound edits

Map invoice number/reference, contact, invoice/due dates, terms, lines/descriptions, quantities, prices, discounts, inclusive/exclusive GST, totals, status, amount paid and remaining balance. Draft sync is independently configurable. CRM finalisation creates/updates the accounting invoice without emailing it; select Xero status only after confirming what the CRM's finalisation status means.

Read current Xero state/version and lock dates immediately before writes. Handle draft, submitted/authorised, paid/part-paid and voided states separately. Prevent changes prohibited by Xero or incompatible with reconciliation/lock dates; show conflicts with proposed actions. Do not silently renumber an existing Jobber/Xero invoice to make a create succeed. Direct CRM↔Xero links require official supported links and must not include credentials.

Acceptance: simulated lost create response is recovered by durable identity/mapping and reconciliation, never blind retry. Locked/authorised/paid changes conflict safely; imports preserve balances and do not send. `SentToContact` follows confirmed CRM delivery only where supported; it is not a substitute for disabling Xero reminders.

### P4 — Payments in both directions (critical)

Map every genuine CRM payment to its existing Xero invoice and chosen bank/clearing account; map each Xero payment back to the corresponding CRM payment. Persist both IDs and original source. Record payment date from Xero as supplied, including when reconciliation occurs later; never use webhook arrival or sync time as receipt date.

Cover cash/bank/card/Stripe, partial and multiple payments, deposits, supported prepayments/overpayments, credit allocations, corrections, reversals and refunds. These are distinct accounting entities: do not model a prepayment, credit allocation or refund as an ordinary positive invoice payment. Define supported API/status combinations and explicitly mark unsupported cases for review. Xero is authoritative for available reconciliation information; never set `IsReconciled` to manufacture bank reconciliation.

Stripe and Xero may describe the same receipt. Use provider references/known mappings and clearing-account policy to avoid duplicating the payment, its fees or the payout. A CRM-created Xero payment later reconciled in Xero updates its existing mapping. A correction follows permitted deletion/reversal-and-replacement flows; immutable, reconciled and locked-period records go to review.

Acceptance: full/partial/multiple payments, earlier receipt versus later reconciliation dates, ambiguous network outcomes, replays, reversal/replacement and refund cases reconcile without duplicate receipts or double-counted balances. Test customer receipts/reminders remain suppressed for imports.

### P5 — Credits, quotes and remaining supported financial data

Credit notes and allocations need their own mapping, status and balance effects. Treat adjustments/refunds separately from discount changes. Test effect on original invoices/payments before automating.

Quote sync is optional and independent: project only compatible financial lines/totals and supported statuses in both directions. Keep CRM signatures, acceptance workflow, delivery, photos, optional services and richer proposal material. Surface lossy/conflicting projections. Preserve a quote-conversion identity so a conversion never creates a second accounting invoice. Never email quotes through Xero or treat an imported Xero status as customer signature evidence.

### P6 — Automatic sync, monitoring and recovery

Implement a signature-verified webhook endpoint, constant-time comparison of the HMAC over the raw body, intent-to-receive verification, durable inbox before acknowledgement, tenant allowlist, replay handling and bounded asynchronous processing. Do not fetch arbitrary `resourceUrl` values: derive allowlisted endpoints from verified IDs.

Current official docs include contact/invoice and payment Create/Update webhooks. Verify event availability for the app, subscribe to supported categories and supplement with incremental polling for unsupported entities/missed events. A payment webhook's event time is not its recorded payment date. Persist overlapping polling cursors, deduplicate and periodically reconcile balances.

Provide owner-controlled pause, independent incoming/outgoing entity switches, quote/draft toggles, Sync Now, last successful financial sync, safe audit/history, failed queue, retries/backoff and manual conflict resolution. Poll on demand and with a limited schedule, not on every page load. Respect `Retry-After` and remaining-limit headers, with a durable per-tenant/app budget across workers.

Starter currently permits up to five organisation connections at no developer-tier charge, 1,000 calls/day per organisation; documented per-tenant limits include 60/minute and five concurrent calls. Recheck before implementation. Reserve capacity for retry/reconciliation, batch supported requests and avoid requesting unused endpoints/scopes. The business's Xero subscription and Railway hosting are separate costs.

### P7 — Jobber cutover and limited live pilot

1. Keep Jobber's current accounting integration unchanged during development.
2. On an explicitly approved migration date, take protected backups and inventory the Jobber/Xero sync state. Choose a cutover date and record which system owns pre/post-cutover exports.
3. Import history in a quarantine/import-only mode. Match existing Xero contacts/invoices/payments by IDs and corroborating evidence. Preserve historical receipt dates, balances, credits and references. Do not export unmatched historical records automatically.
4. Show discrepancies, duplicates, ambiguous identities and missing mappings; resolve them before enabling exports. Prove invoice/payment totals with the owner/bookkeeper.
5. Explicitly disable Jobber's exporter at the agreed point, drain/reconcile in-flight work, and verify it is stopped before Lemon CRM can export those transactions.
6. Pilot a small approved set of post-cutover transactions. Reconcile, review logs and prove rollback/pause behaviour. Never restore data or replay financial writes automatically to recover a bad rollout.

## Customer communication release gate

Do not call Xero invoice/quote emailing endpoints, enable reminders, or register a sending automation. A connection by itself does not turn off existing Xero/third-party reminders.

Before live sync, the owner must review Xero **Sales → Invoices → Invoice reminders** (or the current Invoice settings/reminders page) and turn off organisation-level automatic reminders, plus inspect customer/invoice exceptions and scheduled sends. Review repeating invoices set to approve/send and any connected apps that send on Xero's behalf. Confirm completion manually; the app must not assert it has disabled these settings merely because its own sending endpoints are absent. Jobber communications/export settings need their own cutover review. Keep all intended customer delivery in Lemon CRM.

## Public-repository and AI data safeguards

Only application code, schemas, placeholder templates, docs and fictional fixtures belong in Git. Never commit actual Client ID/secret, tokens, webhook/encryption secrets, DB credentials, Xero tenant IDs, customer/invoice/payment data, financial reports, bank details, backups or real API responses. Runtime configuration and protected DB storage must retain these privately.

Do not export raw provider responses into logs/error tracking, browser errors, PRs, CI artifacts, screenshots or prompts. OAuth redirects naturally carry a one-use code and a public Client ID is part of the authorisation URL: minimise access/query logging and retention outside the app too; confirm Railway/edge/error-tracker query-string handling before connecting. Client secrets, access/refresh tokens and the PKCE verifier never belong in authorisation URLs/browser responses.

Xero's current Developer Platform Terms prohibit using API data to train/fine-tune AI/ML models; the policy FAQ also describes restrictions on contributing API data to model creation. This project additionally forbids live Xero data in AI development sessions. Existing CRM AI features can read business records: before Xero financial imports are enabled, add and test provenance-based exclusions or keep those AI paths disabled for imported data. Do not assume rejecting MCP calls to connection settings solves AI exposure of future imported invoices.

Use redacted Gitleaks scans of staged changes and full Git history before pushing; CI repeats the history scan. Run external provider calls only through allowlisted adapters with sanitised errors. Review actual runtime logs and protected test responses before live approval. No scanner alone proves absence of all personal/business data.

## Test matrix for remaining increments

| Area | Required cases before release |
| --- | --- |
| Connection | Owner/non-owner/assistant access, cookie/state/PKCE, expired/cancelled/replayed callback, demoted owner, refresh races, failed save, stale worker, reconnect/tenant changes, local/remote disconnect |
| Customers/items | Create/update both directions, matched history, ambiguous identities, archiving, conflict, incompatible fields |
| Invoices/quotes | Configurable drafts/quotes, status transitions, lock dates, authorised/paid records, discounts/GST inclusive/exclusive/exempt rounding, voids, rich-content preservation, conversion identity |
| Payments | Full/partial/multiple, cash/bank/card/Stripe clearing, receipt date vs later reconciliation/sync time, deposits/prepayments/overpayments/credits, reversal/replacement/refunds, duplicate IDs/replays |
| Engine | Cross-worker concurrency, missing/repeated/out-of-order webhooks, signature failure, cursor overlap, 401/429/5xx, lost create response, uncertain remote success, loop prevention, pause during queued work |
| Migration | Jobber history matched to existing Xero records, cutover boundary, historical dates/balances, exporter overlap, discrepancies and recovery |
| Privacy/communications | No raw secrets/provider bodies in logs/responses/Git; no emails/texts/reminders/receipts/autopay triggered by imports; AI provenance exclusions; owner-only admin |

## Official evidence reviewed 27 November 2026

- [OAuth overview](https://developer.xero.com/documentation/guides/oauth2/overview/), [Web App code flow](https://developer.xero.com/documentation/guides/oauth2/auth-flow/), [scopes](https://developer.xero.com/documentation/guides/oauth2/scopes/), [token types](https://developer.xero.com/documentation/guides/oauth2/token-types/), [connections](https://developer.xero.com/documentation/best-practices/managing-connections/connections/)
- [Organisation and Demo Company flag](https://developer.xero.com/documentation/api/accounting/organisation/), [invoices](https://developer.xero.com/documentation/api/accounting/invoices/), [payments](https://developer.xero.com/documentation/api/accounting/payments/), [idempotent requests](https://developer.xero.com/documentation/guides/idempotent-requests/idempotency/)
- [Webhooks](https://developer.xero.com/documentation/guides/webhooks/overview/), [payment webhooks](https://developer.xero.com/documentation/guides/webhooks/payments/), [API limits](https://developer.xero.com/documentation/guides/oauth2/limits/), [developer pricing/tier FAQ](https://developer.xero.com/faq)
- [Developer Platform Terms](https://developer.xero.com/xero-developer-platform-terms-conditions), [AI/policy FAQ](https://developer.xero.com/faq/pricing-and-policy-updates), [invoice reminder controls](https://central.xero.com/s/article/Turn-invoice-reminders-on-or-off)

Broad `accounting.transactions` scopes are deprecated for new apps. Initial connection requests only `offline_access accounting.settings.read`. Later financial increments must request current granular contact/invoice/payment/settings scopes as needed, with renewed consent. Endpoint permissions, supported states, tier/partner restrictions and pricing must be rechecked when each feature is implemented.
