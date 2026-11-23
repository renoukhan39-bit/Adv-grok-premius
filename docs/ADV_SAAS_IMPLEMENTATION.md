# Adv-Grok-Premius SaaS implementation

## Checkout and reuse

Baseline `b23d42cf1d22a6b2b354e9a96779b4ed49182aca`. The root pnpm workspace uses Node 24+, React, Electron and a local Node harness. `electron/cloud-account.mjs` validates Cloud Admin responses and Dodo checkout origins. `src/components/CloudAccountSettings.tsx` and `src/components/cloud-buy/ChooseScreen.tsx` already consume its offers. The Cloud Admin behind those contracts is a separate service. The in-tree account Worker in `cloudflare/control-plane/src/index.ts` uses Better Auth, D1, per-installation credentials, origin checks and redacted errors. `relay/src/server.ts` handles companion transport. `packages/phone-protocol` owns shared phone and scheduling contracts.

## Feature gap matrix

Status refers to the requested product behavior in this checkout. Existing primitives listed below have their own verification recipes.

| Area | Existing implementation | Remaining delivery |
| --- | --- | --- |
| Offline Free | Local engines, BYOK, local store, approval cards and local computer providers | Regression-test offline start and the proposed three starter playbooks. |
| Pricing and subscriptions | This change adds a public database-backed three-plan catalog and pricing page. Desktop already displays the separate Admin’s offers and verified session. | Account-scoped subscription state, provider events, reconciliation, checkout, plan management and admin adjustments. |
| Managed harness | `server/fleet.ts`, routine recovery, webhook ingress and hosted-workspace sign-in | Entitled allocation, durable job queue, timeout, quota and restart reconciliation with the laptop closed. |
| Credits and routing | `server/usage-ledger.ts` records attribution, reported or estimated cost. Engine drivers and model catalogs exist. | Transactional wallets, reservations, refunds, route policy, hard budgets and team pooling. |
| Mobile approvals | Local approval broker, companion relay and installation credentials | Official Telegram and WhatsApp linking, expiring one-time decisions and role escalation. |
| Cloud computers | Cloud computer start/reset/run gates and preview/takeover fixtures | Tenant-scoped leasing, desktop-hour accounting, cleanup and persistence. |
| Voice | `server/tts/elevenlabs.ts` and local voices | Adv voice catalog, per-agent preferences, consent, pricing, history and prepaid quota. |
| Video MCP | Existing MCP tooling and media handling | No complete research-to-validated-render pipeline identified. Add the local renderer first. |
| Playbooks | `server/installed-playbooks.ts`, team sharing and existing installation state | Three starters, reviewed premium content, preview, entitlement and dependency checks. |
| Agency | Fleet isolation and hosted workspace access | Five-client cap enforced atomically, member roles, credential and budget separation, dashboard. |
| Backup and sync | Password-protected workspace exports, validated restore, company-backup and Electron sync modules | Paid retention, device revocation across services, per-client restore and conflict handling. |
| Audit and reports | Usage rows, routine outcomes, approval decisions and admin activity | Durable tenant events, redaction, filtered export and weekly evidence-backed PDFs. |

## First working slice

`GET /v1/plans` returns public `id`, `label` and `price: {amount, currency, interval}` in display order. Amounts are integer US cents per month. `GET /pricing` serves the accessible comparison directly from the same query, including empty and temporarily unavailable states. Both are anonymous read-only endpoints under the Worker's existing HTTP protections. A catalog entry confers no access. The upstream Cloud Admin retains authority over its own checkout.

Migration `0019_public_plans.sql` adds only `public_plans`. Free is fixed at $0. The Pro and Agency defaults are $29 and $129 per month. Operators can update the monthly amount within each row's configured bounds ($25–39 and $99–149). For example, `UPDATE public_plans SET monthly_usd_cents = 3500 WHERE id = 'pro'`. This changes the public quote only.

## Design for subsequent slices

| Phase | Storage and API boundary | Acceptance |
| --- | --- | --- |
| 1 · Subscriptions | Reference Better Auth user IDs. Add versioned subscription periods and unique provider event IDs. A read-only `GET /v1/me/subscription` derives identity from the session. Later a verified provider adapter owns writes. | Signed-out denied, missing or expired entitlement resolves to Free, accounts cannot read each other's rows; replay and out-of-order events leave the same state. |
| 2 · Cloud | Account/workspace membership, harness lease, job and usage rows. Scope lifecycle, schedules, webhooks and logs by workspace. | Concurrent allocation stays within quota. Close the desktop, run a scheduled fixture job, crash and recover once. |
| 3 · Wallet | Wallet, reservations and append-only settlements with unique request IDs. Authorize and reserve before funded execution. | Two requests for the final credit cannot both spend it. BYOK incurs no platform debit. |
| 4 · Mobile and desktops | Bind one-time approval IDs and desktop leases to actor, client, action and expiry. | Denials, replays and cross-client requests fail; disconnected sessions release reservations. |
| 5 · Content | Version playbooks, voice usage and render job inputs/outputs. Gate each billable operation at execution. | Preview before activation, use authorized media, validate an actual audio/video output. |
| 6 · Agency | Workspace memberships and roles, per-client secret references, hard budget counters and isolated artifacts. | A viewer cannot mutate; two clients cannot access one another's data through HTTP, sockets, jobs or exports. |
| 7 · Operations | Encrypted backup versions, device grants, append-only audit events and generated report records. | Restore into an isolated fixture; PDF totals match recorded outcomes, spend and evidence links. |

## Licensing and rollout

`LICENSING.md`, `enterprise/LICENSE`, `enterprise/FEATURES` and `NOTICE` describe the boundaries. Preserve Apache notices and third-party licenses. The public catalog uses original code and product configuration. A product subscription cannot grant an enterprise deployment license. The repository directs enterprise features to its licensed layer; third-party hosting and white-labelling of that layer require a written partner agreement. Verify branding rights before release. Dodo checkout support is visible in the desktop client; merchant onboarding, webhook secrets and production rights remain unverified.

Develop against an isolated Worker and D1 database. From `cloudflare/control-plane`, use a local development configuration and local test variables as described in its README. Run `pnpm exec wrangler d1 migrations apply DB --local` then `pnpm exec wrangler dev --local`; open the printed loopback URL at `/pricing` and `/v1/plans`. Migration precedes serving the new routes. A code rollback leaves the additive table available. Production requires operator-owned bindings and domains; the repository's existing account IDs and routes are not defaults for a new deployment.

## Repeat this PR

1. Pick one acceptance case from the phase table. Identify its existing code and the actor allowed to perform it.
2. Start a branch from the previous dependency. Put one versioned migration, one backend contract and its user-facing result in the same review.
3. Exercise the normal entry point using temporary data. Include the success case, denial or failure, and a retry or isolation case when state changes. Use `docs/verification/README.md` for harness fixtures.
4. For this slice run `pnpm --filter @openmausbot/control-plane test -- public-plans.test.ts` or the entire Worker suite, plus the package check. In a full checkout run `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build`.
5. At each 10-minute checkpoint push the feature branch, record the commit and outstanding checks, and pause. In each follow-up issue link the example PR, name the files to extend, provide the acceptance fixture and link the next dependency.
