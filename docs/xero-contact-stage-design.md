# Xero customer and accounting-settings stage

28 November 2026. The connection lifecycle gate has passed. Customer/contact code and automated fixtures are implemented locally. GitHub CI and deployed Demo Company acceptance remain outstanding.

## Authorisation and order

The owner confirms the current connection works on desktop and iPhone. Finish real renewal, remote disconnect and reconnect before implementing this stage. Then implement/test in Lemon Clean TEST with Xero Demo Company only. Keep the Xero PR draft. No production changes, live Xero, real customer data, communications or financial transaction writes.

## Scope and defaults

Two-way CRM customers/Xero Contacts and supported additional contact people. Read Xero accounts, tax rates, currency and financial lock dates. Save explicit revenue/bank/clearing/GST mappings. Support NZD GST-inclusive/exclusive pricing with decimal arithmetic. Independent incoming/outgoing contact switches plus a global pause; all off initially. Manual preview/apply and bounded on-demand processing in this stage, with no scheduler/webhooks yet. History, conflicts, safe errors and retries are part of this stage, not deferred until invoices.

The next consent adds only the contact scope needed for reads and writes, retaining settings read and offline access. It must not request invoice/payment, bank-account administration, email sending or broad accounting transaction scopes. Existing connection-only grants remain usable for health checks; show 'Reconnect for contact permission' until the new scope is granted. Reconnect never silently enables sync.

Current `xeroTokens` validates every item in the single `XERO_SCOPES` constant. Do not simply expand that constant and thereby break refresh of the existing settings-only grant. Separate minimum connection scopes, consent-request scopes and per-operation requirements; validate a refresh against the supported connection minimum and granted permissions. A contact operation checks the granted contact-write scope before any provider call. Add an upgrade test using an existing settings-only token.

## Contact fields and ownership

| CRM field | Xero field | Behaviour |
| --- | --- | --- |
| display_name | Name | User-facing customer identity; never a unique match key by itself |
| company_name | No separate equivalent | Preserve locally; do not pretend Name and company_name are interchangeable |
| email | EmailAddress | Normalised exact email is matching evidence, not unconditional identity |
| phone | Phones.DEFAULT/MOBILE | Stable projection; preserve unsupported phone types |
| billing_address | Addresses.POBOX | Billing only; no property locations or operational notes |
| client_contacts | ContactPersons | Up to provider limit; preserve unmatched local contacts; no silent truncation |
| payment_terms_days | PaymentTerms.Sales | Only compatible day-after-invoice rules; other rules need explicit conflict/review |
| status active/archived | ContactStatus | Archive mapping preserves CRM work/history; unarchive explicit; never delete operational data |
| protected mapping | ContactID, ContactNumber | Tenant-scoped durable identity; preserve third-party ContactNumber on existing contacts |

Do not import tax numbers, balances, bank details or unrelated supplier fields into a customer projection. Do not export tags, notes, cleaning history, property access, custom operational fields or marketing consent. IncludeInEmails must never be set true by this integration. Existing unrelated ContactPersons and address/phone types must survive updates. More than five compatible people is a conflict to review, not permission to discard someone. Supplier-only contacts appear for matching when needed; avoid importing the complete supplier list as customers by default. IsCustomer may not become true until a sales transaction exists, so an exported contact remains known by mapping regardless of that flag.

## Duplicate prevention and conflict policy

1. Look up the protected mapping by company + selected Xero tenant + entity + local ID/Xero ContactID. Enforce uniqueness both directions.
2. For CRM-created contacts with no mapping, reconcile by a durable CRM ContactNumber reserved for that newly created record. Never overwrite another system's contact code to force a match.
3. For existing Xero/customer history, propose candidates by exact normalised email plus corroborating name/company/phone/account number. Names alone, shared family email, conflicting existing mappings and multiple candidates always require explicit review. The first implementation should be conservative: link recommendations need owner confirmation.
4. Store the local version and minimal remote projection used for preview. Re-read both before applying. A changed preview is stale and must be regenerated.
5. Store the last shared field projection. Compare local and remote changes to that baseline; changes on both sides to the same supported field are conflicts. Do not use timestamps as an automatic winner. Allow reviewed incoming or outgoing resolution only after displaying the changed fields.
6. Persist a pending operation and immutable request hash before any remote write. Give it a stable idempotency key. If the result is uncertain, stop automatic creates and reconcile the reserved contact number/known ID before retrying. Xero caches idempotency keys only briefly, so replaying an old key is not long-term duplicate prevention.
7. Persist the successful mapping and new shared projection atomically. A successful remote write followed by a local-save failure must remain an uncertain/reconcile operation, not become a new create on retry.
8. Detect remote merged/archived contacts and surface review. Do not silently change tenant or merge CRM customers. A new organisation gets a separate mapping namespace.

## Storage and transactions

Use dedicated protected Xero sync storage, not generic public sync_links metadata. Keep tenant IDs and detailed projections encrypted at rest or in private schema with strict service-only access; ordinary authenticated users and assistant sessions cannot read it directly. Owner-only routes return only the display data needed for review. No raw provider body goes into history or error logs.

Persist: per-company/tenant settings revision and switches; cached allowlisted accounting settings; customer identity map and origin/export eligibility; versioned previews; durable operations with attempt count, request digest, next retry and safe error code; conflict/resolution state; polling cursor; operation history. Histories need fixed codes and short explanations, not customer data copied into messages.

Use short atomic service-role RPCs for local apply, unique mapping/save and operation claims. Every apply checks the selected tenant, active connection generation, current switches/pause and settings revision again. Do not hold a long PostgreSQL transaction around remote HTTP. Connection lease expiry fences token saves; sync workers also require their own durable operation claim/fence. A paused or disconnected worker cannot commit a new import after it resumes from a remote call. Remote calls already in flight cannot be undone by pausing; show that limit honestly.

## Customer communication and AI safeguards

The inherited client INSERT trigger emits client.created, and activity can queue automations. Importing through ordinary client APIs alone is therefore unsafe. Add a service-only import RPC that suppresses automation/notification side effects in the same transaction as customer/contact changes. Test actual automation/outbox tables, not just mocked absence of an email function call. New imported contacts default notify_email=false and notify_sms=false; do not grant marketing consent. Preserve existing opt-outs. Do not change the production scheduler or existing automation behaviour.

Imported Xero data must not reach built-in AI or assistant tools. Connection-route rejection alone is insufficient: existing assistants can query clients and generic records. Add and test provenance-aware exclusions across direct Data API reads, MCP tools, search/activity and built-in draft/report paths, or enforce a tested company-wide AI-off gate before any import can apply. An owner toggling AI later must not bypass the safeguard. Do not mix a broad AI-read policy into an unrelated integration without reviewing all affected paths.

For the initial isolated TEST implementation, a persistent service-only 'Xero imports present' gate may block company AI/assistant access until provenance exclusions are complete. It must be enforced in the database's assistant pre-request path and built-in `complete`/`readDocument`, with fail-closed checks. Merely disabling new OAuth registrations or leaving API keys absent is not sufficient enforcement. Do not apply that broad gate to production under this task.

## Accounts, GST and pricing

- Retrieve only required account fields: ID/code/name/type/status/currency/tax default/payment eligibility. Never return or store bank account numbers in browser settings/history.
- Revenue choices must be active revenue/sales accounts. Bank choices require active BANK and NZD compatibility. Clearing/payment choices require active BANK or EnablePaymentsToAccount=true. Do not alter Xero accounts or enable that flag automatically.
- Save IDs bound to the current tenant. Refresh and revalidate mappings on settings retrieval/apply and again before future financial writes. A removed/archived account disables the mapping and explains why.
- Fetch tax definitions from the organisation. Choose an active revenue-compatible GST rate, not merely a rate called '15%'. Zero-rated/exempt/no-tax treatments need explicit separate choices. Do not assume every tax component/rate is ordinary NZ 15% GST.
- Keep price basis explicit: Inclusive, Exclusive, or NoTax where supported. Preserve NZD minor units and provider precision with decimal/BigInt arithmetic. For a basic 15% example, $115 inclusive has $100 net and $15 GST; $100 exclusive totals $115. Preserve source gross totals when converting; do not repeatedly convert rounded unit prices back and forth.
- Existing core quote/invoice arithmetic is tax-exclusive with a single rate. Do not globally change it or reinterpret saved prices. Implement a dedicated tested Xero pricing projection and a clearly labelled new price-basis setting. Integration pricing support must not claim that existing invoice entry/PDFs are inclusive until those paths and database totals are actually implemented and tested in the invoice stage.
- Xero rounds tax per line and sums it; current CRM core calculates aggregate document tax. Test the documented $25.06/$25.61/$25.63 at 15% case: Xero line tax totals $11.44, while aggregate tax is $11.45. Surface/reconcile the difference deliberately; do not silently override tax or add adjustment transactions in this contact/settings stage. Capture the Xero system ROUNDING account for later reviewed invoice reconciliation without hard-coding its code.
- Importing tax_exempt would trigger changes to existing CRM draft invoices. Keep tax exemption outside the contact-import projection in this stage; accounting tax defaults are separate protected settings until the invoice stage covers their financial effects.
- Store the organisation's currency and lock dates privately for the next stage; no transaction writes under this stage.

## On-demand engine and UI

Settings page sections: Connection; Sync controls; Accounting mappings; Preview/matching; Conflicts; History. Incoming and outgoing are independently disabled and saved server-side. Global pause wins. A manual 'Preview customers' fetches bounded pages (including archived records as required) and produces a persisted review. 'Apply reviewed changes' processes only selected non-stale operations for the permitted direction.

Use a bounded page size and work budget, deterministic ordering and overlap-aware cursors. Persist partial progress and resume, without refetching all data on every page load. A truncated scan cannot safely declare 'no matches'. Honour Retry-After and daily/minute budgets. Retry transient failures with bounded backoff; surface permanent validation/permission errors. An uncertain write is reconciled rather than blindly retried. All remote URLs are constructed from allowlisted endpoint/validated IDs.

History records incoming/outgoing direction, entity type, outcome, safe error code, attempts, operation time and next retry. Distinguish skipped/unchanged, applied, matching review, conflict, retryable failure and uncertain outcome. Expose provider IDs only where needed in protected owner review, never public logs/Git.

## Required tests

Mock/unit: known-ID matching; case/whitespace email; shared/missing email; same-name separate people; changed names; archived/unarchived/merged; paginated matches after first page; over-limit contacts; null/removal semantics; three-way conflict; no feedback loop after import/export; new and existing third-party contact codes; timeout before/after remote success; stale previews; uniqueness/save failure; 401/403/429/5xx; Retry-After; pause/direction/disconnect during an operation; wrong tenant; owner/non-owner/assistant; sanitised responses/history; account/GST invalidation; decimal inclusive/exclusive rounding and no-tax cases.

SQL/integration: service-only permissions; row scoping; atomic identity mapping and concurrent operation claims; rollback on stale local version; lease fencing; no activity-to-automation/customer notification/outbox work on import; unchanged ordinary client behaviour; AI/provenance enforcement; additive upgrade from the actual tested deployment baseline.

TEST Demo: one fictional customer exported, edited in Xero and imported back; one existing Demo customer matched by review; repeat runs produce no duplicates; simultaneous edits show conflict; pause and each direction switch block changes; accounts/GST retrieved without bank details; mappings survive reload; history contains safe outcomes; desktop and actual iPhone acceptance. Use example.test addresses; no communications. Provider tests must be run through protected TEST routes/UI, with real response content kept out of chat/Git.

## Next invoice/payment stage

Only prepare the implementation plan after this stage's tests pass. Retain original invoice/payment requirements: original receipt date distinct from sync time, partial payments, refunds/credits/overpayments as distinct entities, Stripe clearing reconciliation, cutover/export eligibility, immutable transaction mapping, lock dates, status constraints, lost-response reconciliation, and no emails or reminders. This stage does not authorise invoice/payment writes.

## Primary references checked

- [Xero token types](https://developer.xero.com/documentation/guides/oauth2/token-types/)
- [Contacts](https://developer.xero.com/documentation/api/accounting/contacts/), [official OpenAPI specification](https://github.com/XeroAPI/Xero-OpenAPI)
- [Accounts](https://developer.xero.com/documentation/api/accounting/accounts/), [tax rates](https://developer.xero.com/documentation/api/accounting/taxrates/)
- [Account/payment mappings](https://developer.xero.com/documentation/best-practices/categorising-transactions/account-mapping/)
- [Rounding](https://developer.xero.com/documentation/best-practices/data-integrity/rounding/)
- [Idempotent requests](https://developer.xero.com/documentation/guides/idempotent-requests/idempotency/)

Where older CRM guidance describes contact names as unique, follow the current Contacts warning to use ContactID and not assume name uniqueness.
