# M3: native Admin and a fixed storefront

This extends [M2](M2-README.md) on the MIT Medusa 2.18.0 fork. The native Admin
is built with a SaaS flag and one native `Storefront` settings extension. The
fixed theme is the MIT Next.js starter frozen in `storefront/UPSTREAM.json`.
It has its own lockfile; the Medusa root manifest, lockfile and MIT license are
unchanged. AI, Helpdesk, CRM and a separate merchant interface remain deferred.

## Build and verify

In this workspace, after the previously verified native M2 dependency build:

```bash
source /workspace/.medusa-baseline/activate.sh
cd /workspace/.medusa-baseline/mit-source
SAAS_ARTIFACT_DIR=/tmp/medusa-m3-results bash saas/verify-m3.sh
```

The strict verifier builds the native Admin dependencies and `/app` bundle,
checks the Admin and extension types, installs the storefront with its bundled
Yarn 4 and immutable lockfile, checks types, runs ESLint separately, then builds
Next.js. It runs M1/M2 HTTP regression, M3 HTTP acceptance, and Chromium against
the production bundles, real native handlers/workflows and PostgreSQL.
Python Playwright and `/usr/bin/chromium` are required for the last step. Results
include business-check JSON, logs and selected screenshots. No browser storage
state or authentication trace is saved.

Reset flags apply only to the fixed, marked, loopback disposable databases.
The HTTP and browser M3 tests use the same test database and must run
sequentially. The browser fixture creates two tenant Hosts and a temporary
self-signed TLS ingress; certificate verification is bypassed only by the test
browser. This does not constitute a public deployment or valid production TLS.

## Browser and API contract

- `https://SHOP.BASE_DOMAIN/app/` serves native Admin. The owner uses a Secure,
  HttpOnly, host-only SQL-backed Session. The bundle uses session authentication
  and the current browser origin, not a global administrator token.
- `/` redirects using the current tenant's regions; `/us` is the initialized
  test/default country. The fixed theme provides home/catalog/detail, signed-in
  cart/checkout, confirmation, profile and own order history. Guest checkout is
  intentionally unavailable.
- Native product/variant/options, collections/categories, single-warehouse
  inventory and selected native configuration CRUD use reviewed route/schema
  bindings in `m3-runtime.cjs`. Order and customer Admin pages are read-only.
  Import/export, reservation, account administration and M4 order operations
  are hidden. Direct unsupported requests remain rejected by the allowlist.
  Extra native configuration pages/actions are not exhaustively browser
  accepted; tax-rate editing and destructive warehouse operations remain closed.
- Public product pricing uses the native channel, pricing and tax pipeline.
  Only published products in the tenant's enabled default channel are returned.
  Internal/inactive categories and private metadata are removed from the public
  category DTO. Admin and Store field lists remain separate.
- The native extension saves store name, Logo, primary color and description.
  Image uploads accept PNG/JPEG/WebP signatures, up to five files totalling
  5 MiB. Local object storage and metadata are tenant scoped. Public media must
  belong to the current Host and be explicitly public; SVG is unavailable.
- Every frontend request resolves the active tenant Host. Next.js backend calls
  use a fixed connection and preserve that Host via Node HTTP, bypass the SDK's
  shared in-memory token/key state, and do not use shared response caches or
  static tenant pages. Customer authorization is sent only to private APIs.
  Cache tags, where used for invalidation, include the tenant Host.
- Gateway responses use `private, no-store`; unsafe browser methods require an
  exact same-origin Origin, including scheme and port. Sibling subdomains do
  not bypass this check. An ingress must strip client forwarding headers and
  preserve Host. Trust is granted only to explicitly configured proxy peers.

## Configuration and launch

Retain M2's separately migrated database and non-owner application role. Inject
persistent runtime values into the process, never into source or this README:
`SAAS_DATABASE_URL`, `SAAS_BASE_DOMAIN`, `SAAS_PLATFORM_ACTOR_ID`,
`SAAS_JWT_SECRET`, `SAAS_CONTEXT_SECRET`, `SAAS_IDENTITY_SECRET`,
`SAAS_PLATFORM_KEY`, `SAAS_OBJECT_ROOT`. Keep the identity secret stable.

For an existing M2 tenant, explicitly initialize its M3 business defaults:

```bash
node saas/initialize-m3.cjs TENANT_ID
```

This is an idempotent, audited, one-tenant operation after verifying an active
platform operator and the tenant owner membership. It does not reset schema,
assign unowned data or iterate all tenants. Existing multiple warehouses require
review. New tenant provisioning initializes M3 defaults automatically.

Build first, then launch behind a configured TLS ingress:

```bash
node saas/start-m3.cjs
```

The gateway defaults to `127.0.0.1:9000`; its Next.js child binds only to
`127.0.0.1:8000`. Optional values are `PORT`, `SAAS_BIND_HOST`,
`SAAS_STOREFRONT_PORT`, explicit comma-separated `SAAS_TRUSTED_PROXY` IP/CIDRs,
and `SAAS_RUN_WORKER=true`. The launcher requires both frontend builds and does
not pass the configured database or signing keys to its storefront child.
All external traffic must enter through the SaaS gateway; an unrestricted
stock Medusa server or direct Next.js ingress bypasses this reviewed contract.

M3 initializes a default region/channel/store, shipping profile and one
warehouse. Configure its native channel/provider links, fulfillment set,
country service zone and shipping option in the native location settings
before selling. Checkout does not invent a free shipping option. The verified
fixture configures these through the same native HTTP APIs.

## Remaining acceptance gates

The visible payment method is **Test payment**, using `pp_system_default`.
It persists native orders/payments without moving real money. M4 must implement
independent merchant credentials/accounts, provider signatures, inventory
contention/release, fulfillment, cancellation and refunds. M5 covers quotas,
rate limiting, monitoring, object cleanup and restore/deployment operations;
M6 covers full dependency/license/security/performance and release acceptance.
This increment does not migrate unknown production data, send email, expose
exports or callbacks, deploy publicly, or complete the SaaS MVP.

The frozen starter is deprecated upstream. Maintaining this fixed fork and
assessing future upgrades belongs to release planning. It uses React 19 while
the pinned Medusa UI package declares a React 18 peer range. Selected browser
flows are checked against the built package; this is not exhaustive compatibility
acceptance. Existing lint warnings and native Admin bundle size remain recorded
release work, not hidden build errors.
