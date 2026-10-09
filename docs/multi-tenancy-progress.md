# Multi-tenant implementation progress

Status: first-version implementation and local verification complete; user accepted the basic validation on 2026-10-02. GitHub issue #1 is closed as completed, with the ready-for-agent label removed. Requirements: `multi-tenancy-spec.md`. The 58-story audit and testing constraints are recorded in `multi-tenancy-verification.md`. Code publication is tracked by GitHub issue #2, authorized on 2026-10-09.

## Implemented foundations

- Default-off deployment parser and a managed launcher branch; original single-user entry remains the off path.
- SQLite tenants, roles, users, hashed passwords/tokens, expiring single-use invitations, sessions, project ownership, model call accounting, reservations and task leases.
- HTTP management entry: login/join/logout, tenants/members/invites, platform key/limits/usage/reconciliation; same-origin/role/resource guards and proxy forwarding.
- Real native project workers: fixed scope, separate environment files and BYOK/platform auth directories, control/status/drain/restart; private worker diagnostics and heartbeat.
- OpenRouter model gateway with known-price admission, streaming forwarding, usage settlement and persistent uncertain calls.
- Optional frontend login/team/project/limits interface; account/tenant storage partition and stale-account response guard.
- Managed-only parent/child task admission hooks, live observer revocation, credential staging through an internal configuration worker and pending/drain/reload handling.

## Earlier verification checkpoints

- Backend typecheck passed after restoring the harness versions already pinned in the manifest.
- Initial management HTTP checks: 5 passed (invitations, authorization, ownership, revocation, persisted budgets and unresolved usage).
- Real worker integration: 2 passed (off flag parsing; BYOK/platform credential separation, fixed project, idle supply change and preserved artifact).
- Frontend typecheck passed after restoring declared packages and the omitted Testing Library DOM peer.
- Frontend full regression run: 127 files, 854 tests passed, including login shell and account storage tests.
- Backend full suite initially: 1441 tests passed, 25 skipped, 2 failed. Both failures were resolved: the child callback now uses undici fetch with its dispatcher, and the existing helper venv was synchronized to include declared openpyxl. The targeted rerun of both regressions plus managed HTTP/real workers passed: 4 files, 21 tests. The complete backend suite still needs a final post-change run.
- Latest backend and frontend typechecks passed; latest focused frontend checks passed 29 tests after account-switch and cache changes.
- Interactive administrator bootstrap was verified with a temporary SQLite database: masked terminal password input, salted hash storage, no public initializer.
- Real local-model workflow now passes platform routing, a shared credential update mid-tool-loop (old key retained), idle/new-key reload, busy source-change refusal, history preservation, actual detached child routing and slot release, and supervisor settlement. No paid provider was used.
- Gateway HTTP stream tests pass incremental delivery, concurrent request rejection, confirmed usage and conservative disconnect settlement; native image prices and Fusion panel/judge pricing are covered.
- Managed model discovery is now project/account scoped and a late BYOK result cannot overwrite platform discovery. Its focused frontend check passed.
- Browser QA used temporary state at localhost:3310 (internal UI 3311). Verified admin login, team creation, saving a USD 10 budget, one-time owner invitation, owner join/shared-project access, persisted platform-to-BYOK switch, and logout clearing active identity. Fixed dev WebSocket forwarding, invitation hash changes/refresh persistence, desktop viewport overflow and mobile management wrapping. Desktop 1200×900 and mobile 390×844 were checked. Screenshots remain outside the repository under `/private/tmp/kady-browser-qa/`. Final app console had no runtime errors; existing unused KaTeX preload warnings were observed.
- Authenticated proxy integration now covers Office fixture binary read, styled preview, revision-checked save and stale-revision rejection in addition to source/fixed-project checks.
- Dependency installation used `--no-save --package-lock=false`; existing user changes in the backend lockfile were preserved.

## Final verification

- Full backend regression: 137 files passed, 1 skipped; 1471 tests passed, 8 skipped. Log: `/private/tmp/kady-backend-release-verification.txt`.
- Full frontend regression: 128 files and 855 tests passed. Log: `/private/tmp/kady-frontend-release-verification.txt`.
- Backend/frontend typechecks, frontend production build, launcher syntax and `git diff --check` passed.
- Real-worker checks cover parent/child/watchdog/schedule admission, old-key retention during a tool loop, pending reload, concurrent project startup/configuration save, source switching, rebuild failure, files/history and Office revisions. OAuth uses the real Pi SDK with simulated token exchange.
- HTTP checks cover invitation consumption, session expiry/revocation, role boundaries, every project selector, foreign/retired resources, persistent budgets and unsettled recovery. The manager lock keeps a second instance from resetting live commitments.
- Native image and Fusion pricing, incremental SSE and conservative disconnect accounting passed. Required child shutdown accounting remains in the app-owned extension; third-party SDK sources were not changed for multi-tenancy.
- Browser checks cover desktop/mobile login, invitation, shared projects, management, supply switching, usage and logout. Temporary QA browser and services are closed.
- At the initial 2026-10-02 checkpoint, user lockfile changes were preserved and no commit, push, PR, deployment or real paid supplier call had been performed.

The default-off switch and small guarded integration hooks preserve the original single-user path. Deployment instructions are in `multi-tenancy-deployment.md`; trusted-host execution, estimated costs and unmeasured hardware capacity remain the agreed limits.

## Public address follow-up

- Reproduced `Loading workspace…` at an origin different from `KADY_PUBLIC_URL`: the development WebSocket was rejected before client startup completed.
- Page requests now redirect to the configured public Host; API origin guards remain enforced. Next.js permits the configured public hostname in managed development mode. The deployment guide now includes the LAN HTTPS/reverse-proxy command and listening-address distinction.
- Lifecycle/management regressions: 12 passed; both typechecks passed. Isolated Playwright verification covered wrong-address redirect, synthetic administrator login, refresh with no team/projects, and opening management. No runtime errors after refresh; only existing KaTeX preload warnings. Evidence: `/private/tmp/kady-origin-qa/management-after-refresh.png`. Temporary browser/manager closed; the user's running services were retained.

## Key-filtered model selection follow-up

- Reproduced duplicate OpenRouter React keys: the platform `models.json` base-URL override was also listed as a custom provider. That second source is now excluded and the merged picker list is deduplicated by model ID.
- OpenRouter choices now come from authenticated `/models/user`, which applies user preferences/privacy/guardrails. BYOK uses effective Pi credentials; platform projects use the manager's master key without exposing it to workers or browsers. Failed discovery shows retryable status instead of the full static catalogue. Unlisted persisted choices are unavailable, and Fusion presets require all panel/judge models to be listed.
- Live prices seed synthesized model resolution so newly listed models do not silently resolve at zero cost; missing or malformed prices are excluded.
- Full frontend regression: 857 passed. Backend catalogue/model/pricing/custom-provider regressions: 48 passed; real managed-run integration also passed. Both typechecks passed. One unrelated workflow timeout in the first full frontend run passed on its focused rerun and the subsequent full run.
- Playwright with a synthetic restricted key showed exactly two unique choices, selected an allowed model and reopened it after refresh. No runtime errors after refresh/reopen and no paid generation calls. Screenshot: `/private/tmp/kady-model-picker-qa/two-allowed-models.png`. Temporary browser/manager closed; user services were retained and require a restart to load the new backend route.

## Output token limit follow-up

- Reproduced the reported `invalid_max_tokens` response with the installed Pi catalogue's valid 943718-token DeepSeek ceiling. The gateway's fixed 131072 ceiling was the cause.
- Gateway admission now validates positive safe integers and conflicting token fields, forwards exactly one of `max_tokens`/`max_completion_tokens`, and reserves the full requested maximum before sending upstream. Provider-specific maximum validation stays with the provider; tenant budgets still reject excessive reservations.
- Gateway/management/managed-run checks passed (14 tests), both output-field and invalid-value cases passed, and a subsequent real-Pi DeepSeek stream with a limit above 131072 passed against the local mock supplier. Backend typecheck and diff check passed; no paid calls.

## Team management UX follow-up

- User requested an Impeccable refactor and selected an independent management page; final validation focuses on desktop as requested. The page inherits the existing Geist, semantic colors, buttons and Settings visual system. Impeccable's context engine was unavailable, so its references and the existing implementation/screenshot were read directly.
- Replaced the long combined dialog with Projects, Members, Usage & limits, and admin-only Platform access. Platform credentials are explicitly global; limits/members/usage follow the selected team, initially the active project's team. Source choices require an explicit apply, new projects require an explicit source and remain in configuration after creation.
- BYOK configuration navigates to the owning project and its existing Providers panel. Management uses the URL's manage=team state; workspace components remain mounted behind it, including during directory refresh. A small managed-only HomePage event hook opens projects and defers the Providers deep link until the destination is mounted.
- Full frontend regression: 861 passed; frontend typecheck and diff check passed. Six focused shell/management checks cover source staging/apply, explicit creation, scope separation, members, role visibility and workspace mount preservation.
- Desktop Playwright verification used synthetic teams at localhost:3324, checked active-team selection, source save and the correct project's Providers navigation. Evidence: /private/tmp/kady-team-redesign-qa/projects-desktop.png and access-desktop-final.png. No React/Next runtime overlay; initial unauthenticated 401s and two transient 409s during worker replacement were expected. No real user configuration or paid generation was used.

## Code publication — 2026-10-09

- User authorized committing/pushing the implementation and requested a corresponding issue. Delivery tracker: [issue #2](https://github.com/eesql/k-dense-byok/issues/2), related to completed specification #1.
- Pre-push frontend full regression: 861 passed with four test workers; an initial high-parallelism workflow timeout did not recur. Both typechecks, launcher syntax and diff checks passed.
- Backend full run: 1474 passed, 8 skipped; one existing corrupt-mzML test timed out. Its unchanged seven-test helper-error file passed on isolated retry. No product code or test timeouts were changed for those transient failures.
- Commit scope includes the feature, fixes, management UI, tests and documentation. Both existing dependency lockfile edits remain local; no runtime data or credentials are included. No version bump or manual tag is added. Commit/push confirmation belongs in the delivery issue's completion comment.
