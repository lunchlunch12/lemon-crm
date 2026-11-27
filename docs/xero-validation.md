# Xero connection: validation and release gates

Review date: 27 November 2026. Base: `36987955d11f063b24ab65d92211474d0107242a` (upstream v0.5.5). This covers the connection/configuration increment, not the future financial integration.

## GitHub CI after workflow correction

Workflow safety PR #2 passed all four substantive jobs on both its push and PR runs (`45939247361`, `45939288461`), then was merged with explicit owner approval while production auto-deploys were disabled.

Xero candidate `dfbdc7c4f4643340dcab27ba686cddc32a0e4980` includes corrected main and retains the secret-scanning job. Its [CI run 45940732466](https://github.com/lunchlunch12/lemon-crm/actions/runs/45940732466) passed **check, upgrade, instance, browser and secrets**. This includes normal Linux dependency installation, typechecking/unit tests, full Docker database tests and upgrade from v0.5.5, production build, fresh-instance startup, lifecycle/end-to-end and browser tests. No Xero/production credentials were provided to CI. Later documentation-only updates do not change the tested application code.

These checks satisfy the previously outstanding automated Linux/DB/upgrade/instance/browser gates for this candidate. Xero Demo Company consent, actual provider token rotation and real iPhone Safari acceptance still require the isolated TEST environment and owner participation. Do not confuse the generic browser suite with successful real-provider OAuth acceptance.

## Checks performed locally

| Check | Result |
| --- | --- |
| Root `npm run typecheck`, Node 22 | Passed across API, web and core |
| `npm run build:server` | Passed including the web production build; existing bundle-size warnings remain |
| Server rebuild after final connection guard change | Passed, reusing the unchanged web build |
| Core unit suite | 1,217 passed |
| Full web unit suite, `TZ=UTC`, two workers | 2,274 passed; zero failed |
| Full API unit suite, `TZ=UTC`, two workers | 2,733 passed; zero failed |
| Targeted API suite | 101 passed: Xero, subcontractor access, calendars, review-card renderer and workflow coverage |
| New Xero tests within the suites | 24 API tests and 2 web rendering tests; all use fictional data and mocked provider calls |
| Actual new migration and SQL permission/fencing test | Passed in isolated PGlite PostgreSQL with minimal stand-ins for existing app tables |
| Secret scanning | Gitleaks full Git history and staged changes checked with redaction; see final review package for commit/count |
| Patch formatting | `git diff --check` checked before committing |

The connection tests exercise owner/non-owner/assistant permissions, company isolation, server feature gates, callback state/cookie/PKCE and replay, cancellation and owner demotion, tenant selection, token refresh and failed persistence, stale leases, rate-limit/provider failures, reconnect/disconnect races and local forgetting after configuration removal. Web tests check owner-only presentation, absence of browser credential fields and unavailable Live/sync controls.

The three full workspace suites total **6,224 passing unit tests**. API/web were run directly through Vitest with `--maxWorkers=2` and `TZ=UTC`; core used its workspace test command. The full API/web reruns followed the final test-portability edits. Typechecking and build preceded those test-only/documentation edits; application code was unchanged afterward.

These are mocks. They do not prove Xero's real consent flow, browser cookies on Safari, actual provider refresh rotation or the deployed stack works end to end. PGlite verifies the actual migration/function SQL and privilege checks against a deliberately small schema; it is not the full Supabase migration/upgrade suite or a real concurrent multi-process load test.

## Local development limitations

The host is Windows. Three inherited test assertions were made portable without changing product behaviour: two file-path comparisons normalise separators, and an English date assertion accepts US/NZ ordering. Broader date fixtures assume UTC; run those suites with `TZ=UTC`, as in Linux CI, rather than changing business dates to satisfy tests. Earlier runs in Pacific/Auckland therefore contained unrelated date-expectation failures and are not reported as successful full runs.

Dependencies came from the committed lockfile with install scripts disabled. Because this sandbox could not create npm workspace symlinks, a local installation-only helper copied the three exact workspace package directories instead. No dependency manifest or lockfile changed. Linux CI must repeat a normal `npm ci` and the repository's standard scripts.

Gitleaks initially found 39 inherited fixture matches: mock link/provider strings and self-signed test keys. Only their exact reviewed historical fingerprints are ignored. No whole directory/rule is exempted. A synthetic credential check confirmed the added Xero credential rule detects a new non-placeholder value. Pattern scanning cannot guarantee that all personal data or every possible secret is absent.

## Release gates and owner acceptance

1. Keep the Xero PR in draft. Publish code changes only to its review branch and require passing CI for each new application candidate.
2. Automated Linux database/upgrade/instance/end-to-end/browser checks passed in GitHub CI for the candidate above; they were unavailable on the local Windows host. Repeat for subsequent application/migration changes.
3. Independently review OAuth handling, server-only credentials, service-role RPC permissions, lease expiry and failed token-save recovery. Confirm hosting/edge logs do not retain sensitive callback query strings.
4. The owner has approved isolated TEST preparation. Use its own database, secrets and domain. Do not use production database references, encryption keys or provider credentials. See `xero-test-environment.md` for current preparation boundaries.
5. After reviewed code is deployed only to TEST, perform Xero Demo Company consent, select/check/reconnect/disconnect tests, plus desktop and real iPhone Safari acceptance.

Do not enable live organisation access, financial sync, Jobber migration, customer communications or production deployment on the strength of these local results. Live mode and financial sync are server-blocked in this increment. No live Xero API calls, real-data migrations, production configuration changes or customer sends were performed by this task.
