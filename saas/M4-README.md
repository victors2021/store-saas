# M4: tenant Stripe payments and native order operations

M4 extends the frozen MIT Medusa 2.18.0 [M3 gateway](M3-README.md).
Use `/workspace/store-saas` in this cloud workspace. The original Medusa and
historical MIT checkout are retained as references. No new merchant application
is introduced: payment settings and order actions are native Admin extensions.
AI, Helpdesk, CRM and marketing remain in phase two.

## Build and verify

Prepare Node 22.23.3, the root bundled Yarn 3.2.1, Docker, Python Playwright and
Chromium. Install the root dependencies with `yarn install --immutable
--inline-builds`. The frozen storefront uses its own bundled Yarn 4.12.0.

```bash
export NODE_OPTIONS=--max-old-space-size=4096
SAAS_ARTIFACT_DIR=/tmp/store-saas-m4-results bash saas/verify-m4.sh
```

The strict script builds native backend/Stripe/Loyalty, native Admin and Next.js;
checks frontend types and lint; runs native payment/order tests with SaaS mode
off, tenant unit tests, M1/M2/M3 HTTP regression, M3 launcher/browser regression,
then M4 HTTP, launcher and browser acceptance. All database resets are confined
to the existing fixed-name, marked, loopback disposable databases. Tests that
share a database run sequentially. Never adapt the reset flags to a live database.

M4 uses the **real Stripe SDK and native Medusa Stripe provider** against an
owned loopback protocol fixture, plus real PostgreSQL and native workflows.
This checks merchant selection, signatures, amounts and failure recovery without
vendor credentials. It is not actual Stripe sandbox or Stripe Elements acceptance.
The browser uses owned TLS hosts and production bundles. Only selected screenshots
are retained; no cookies, browser storage state, private keys or credentials.

## Upgrade and start

Retain M2/M3's stable runtime settings, separately privileged migration connection
and restricted application role. Add **`SAAS_PAYMENT_KEY`**, an independent,
stable 32-byte hexadecimal AES key supplied securely to the backend process.
Back up this key with the deployment's other secrets; generating a different
key at every start makes the existing merchant credentials unreadable.

```bash
node saas/migrate-m4-command.cjs
# Existing M2 stores only, if not already initialized for M3:
node saas/initialize-m3.cjs TENANT_ID
node saas/start-m4.cjs
```

The migration command reads `SAAS_MIGRATION_DATABASE_URL`,
`SAAS_APPLICATION_ROLE` and `SAAS_JWT_SECRET`. It does not reset a database.
The narrow `SAAS_ALLOW_NATIVE_REFERENCE_SEEDS=true` exception applies only to
the reviewed native refund-reason seeds described in M2. Unknown unowned data
or destructive native Link migration plans require separate migration work.
M4 adds `0006-payments`; the M0–M3 checksums are unchanged. Startup checks
actual RLS, grants, columns, credential uniqueness and callback ownership FKs.

Runtime still needs `SAAS_DATABASE_URL`, `SAAS_BASE_DOMAIN`,
`SAAS_PLATFORM_ACTOR_ID`, `SAAS_JWT_SECRET`, `SAAS_CONTEXT_SECRET`,
`SAAS_IDENTITY_SECRET`, `SAAS_PLATFORM_KEY` and `SAAS_OBJECT_ROOT`.
The launcher enables payments and defaults the durable worker on.
`SAAS_RUN_WORKER=false` is for controlled diagnostics, not reliable callback
retry operation. Gateway/Next default to loopback 9000/8000; use a TLS ingress
that preserves Host and strips untrusted forwarding headers. Configure explicit
`SAAS_TRUSTED_PROXY` peers when required. Backend SaaS secrets and Stripe secret
variables are removed from the Next.js child environment.

## Connect each merchant

Sign in to the current store's native Admin and open **Payments**. Supply its
own Stripe **test** secret key, publishable key, account ID and webhook signing
secret over HTTPS. The server retrieves the account with that secret key and
requires the returned ID to match. A merchant account belongs to exactly one
tenant. Keys are AES-256-GCM encrypted with tenant/credential/version AAD.
The browser never receives stored secret or signing keys.

Copy the returned opaque webhook URL into that account's Stripe test settings.
Enable `payment_intent.amount_capturable_updated`, `payment_intent.succeeded`,
and `refund.created`, `refund.updated`, `refund.failed`. Other verified events
are ignored when they do not drive the accepted lifecycle. Preserve old webhook
endpoints and old key access until their outstanding sessions settle; existing
sessions, captures and refunds remain pinned to their credential version.
Rotation changes new sessions, and must retain the same merchant account.
M4 does not delete old credentials or switch an existing store to another account.

The storefront obtains the publishable key from its own payment session.
There is no global Stripe key or Connect account selector. Public session data
contains only `client_secret` and `publishable_key`; consumers cannot provide
PaymentIntent IDs, amount overrides, metadata or capture settings.
Server pricing includes the native cart, shipping and tax calculations.
An unconfigured merchant exposes no enabled checkout payment provider.

## Order actions and recovery

Native order details expose full authorization capture, partial/full refunds,
manual single-warehouse fulfillment, shipping, fulfillment cancellation and
order cancellation. Tracking details are optional; supplied labels must have
real tracking and label URLs. Native workflows perform reservations, stock
movements, credit lines and financial entries. The implementation refuses
partial captures because the pinned provider captures the entire authorization.

All Owner action POSTs require an `idempotency-key` of 8–128 ASCII letters,
digits, hyphens or underscores. Reuse **the same key and exact body** after an
uncertain response. A different payload with the same key conflicts. The Admin
retains each key while that page retries; after leaving/reloading an uncertain
operation, check the actual order/refund state before initiating another action.
API integrations must persist their operation keys across restarts.

M4 serializes checkout and order actions per tenant with a PostgreSQL advisory
lock. Contention returns 409 and the caller retries the same operation. This
coarse lock is for the single-server MVP and is not a capacity guarantee.
Vendor effects have durable tenant/operation/binding identities. Amount updates
use persistent revisions so A → B → A does not replay an obsolete Stripe update.
Completed native action checkpoints are retained with a seven-day retention
setting; a lost operation acknowledgment can recover the current native DTO.
Cleanup is not scheduled globally: M5 must coordinate tenant-local checkpoint
cleanup with unresolved operations. Mid-step refund recovery also uses a
server-owned native refund marker and credit-line reference.

Raw-body callbacks verify the real SDK signature and freshness, then derive
tenant/account/credential from the server registry and verified Host. Durable
M2 jobs restore current authority. Live merchant API state wins over old event
payloads; closed sessions/orders and stale amounts are ignored. No callback body
or client header supplies tenant authority. Failed processing returns an error
after durable persistence for retry, including across an application restart.

Pending refunds do not create successful native financial entries until the
vendor reports success. A signed refund update completes the original operation
once. Merchant-dashboard refunds and external partial captures require operator
reconciliation; M4 flags them instead of inventing local entries.

**Payments → Commerce totals** shows all-time native order counts and Stripe
test captured/refunded/net amounts, separately by currency. SQL numeric sums
preserve monetary precision. Counts needing attention are tenant scoped.
These are operating totals, not accounting ledgers or automated settlement.

## Actual Stripe test-mode acceptance

Securely configure the eight process inputs
`SAAS_STRIPE_{ALPHA,BRAVO}_{API_KEY,PUBLISHABLE_KEY,WEBHOOK_SECRET,ACCOUNT_ID}`.
Use two distinct merchant test accounts. Never paste the values in chat or
commit them. Allow `api.stripe.com` through the configured proxy; browser
Elements also requires the appropriate Stripe frontend destinations.

```bash
SAAS_M4_TEST_RESET=1 SAAS_M4_SANDBOX_RESULT=/tmp/stripe-test-result.json \
  node saas/m4-sandbox.cjs
```

Without credentials the command exits 2 with a safe `pending` receipt before
touching the test database. With credentials it performs actual test-mode
authorization, native capture/replay and refund using `pm_card_visa` through
both accounts. Its receipt separately leaves official callback delivery and
browser Elements verification pending. Those need a reachable reviewed TLS
deployment, real test account settings and a browser session. No live keys or
real-money test is accepted by this increment.

## Remaining gates

Current local implementation and acceptance do not close external payment
acceptance: actual independent Stripe test accounts, official callback delivery
and browser Elements still need verification. M5 adds paid-order handling during
tenant suspension, quotas/rate limits, monitoring, coordinated cleanup and
backup/restore operations. Today suspension blocks business APIs and callbacks.
M6 completes independent security, license/dependency, performance, deployment
and release acceptance. Do not treat local tests as production launch approval.

Current implementation/review/evidence: [M4 report](../docs/saas/14-M4-IMPLEMENTATION.md),
[M4 review](../docs/saas/15-M4-CODE-REVIEW.md).
