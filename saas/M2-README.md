# M2: native commerce isolation and durable task boundaries

Source: MIT Medusa 2.18.0, `1014c0337027a6087410ad3cc1da9a11fd83ca8d`.
M2 extends the [M1 gateway](M1-README.md) with native transaction modules and
tenant-aware persistence. It is an implementation checkpoint; complete browser
flows, independent merchant payments and production acceptance remain M3–M6.

## Reproduce acceptance

```bash
source /workspace/.medusa-baseline/activate.sh
cd /workspace/.medusa-baseline/mit-source
SAAS_ARTIFACT_DIR=/tmp/medusa-m2-results bash saas/verify-m2.sh
```

The script builds native dependencies, runs the existing mode-off native and M1
regressions, checks DML tenant metadata, and runs real two-store HTTP/SQL/workflow
acceptance. It resets only explicitly marked, fixed-name loopback test databases.
No production data, real provider account or email delivery is used. Failed
commands retain their exit status. The cloud fixture uses PostgreSQL 5432 and
Redis 6379; its trust authentication is exclusively for disposable tests.

## Data and service changes

- Cart, Order, Payment, Inventory, Stock Location, Sales Channel, Fulfillment,
  Region, Tax, Promotion, API Key, Store and the in-memory workflow engine join
  the M1 Product/Pricing/Auth/User/Customer ownership boundary.
- `m2-schema.json` is a reviewed, frozen migration manifest. `0004-commerce`
  protects 130 native business, pivot and Link tables. `0005-runtime` adds four
  protected job/cache/lock/file tables and two server-only dispatch/session
  tables. Runtime uses a dedicated non-owner NOSUPERUSER/NOBYPASSRLS role.
- Logical references that native modules store as text receive composite tenant
  foreign keys, including cart customers/regions/channels, order lines, inventory
  locations and both tenant-owned ends of physical Links. Country ownership uses
  `(tenant_id, iso_2)`. Workflow checkpoint primary keys also include tenant.
- Provider catalogs are shared read-only definitions; they contain no merchant
  credentials. Payment, Tax and Fulfillment loaders cannot mutate them in SaaS
  mode. Only the system payment, system tax and manual shipping catalogs are
  configured in this increment.
- Native inventory quantity SQL and promotion rule SQL use their actual bound
  transaction. Module adapters reject caller tenant fields/managers. DTOs omit
  ownership columns while preserving server-bound Auth metadata. Native Graph
  resolves through those adapted modules; Graph caching remains disabled.
- Native product text search is RLS scoped. The indexed search module is not
  enabled. Global order display-ID sequences remain non-authoritative and can
  have gaps between stores; order/customer authorization uses scoped IDs.

Migrations and startup validate checksums **and live metadata**, including RLS,
keys, FK declarations, provider privileges, cache/lock primary keys and control
table grants. Native destructive schema generation remains refused; an ORM diff
is not a substitute for the reviewed migrations.

RLS does not restrict TRUNCATE. Runtime grants are checked through direct,
inherited and SET ROLE membership paths; PUBLIC grants and non-DML privileges
are rejected. Repeated native Link generation has 20 noop plans, retaining both
tenant FKs and the independent shared-provider references.

Existing unowned business data is rejected. The native Payment migration creates
three default refund reasons before tenant initialization; conversion is allowed
only with explicit `SAAS_ALLOW_NATIVE_REFERENCE_SEEDS=true`, exactly matching
untouched native defaults and no existing refunds. Those defaults are recreated
per store. This flag does not authorize any other tenant backfill or deletion.

## HTTP boundary

The existing M1 Host, native JWT/Session, membership and field guards remain.
New routes have finite method/path and field lists in `m2-routes.cjs`:

- Owner GET lists for orders, regions, sales channels, stock locations, inventory,
  shipping options, tax regions and promotions; owner GET order detail.
- Authenticated consumer cart create/read/update, add line items/promotions/
  shipping methods, payment collection/session creation, checkout and own-order
  retrieval. The consumer must own the cart/order in the current store.
- Cart creation and checkout require an `idempotency-key` header of 8–128 ASCII
  letters, digits, hyphens or underscores. Different input with the same key
  conflicts. Store address IDs and caller-supplied item prices are rejected;
  consumers submit fresh address data and the server computes prices.

The configured payment session is `pp_system_default`. It tests the real native
checkout/order/payment persistence path without connecting to a payment network.
Guest checkout and full native Admin navigation are not yet exposed. Other
native method/path exports remain closed, including callbacks, uploads, exports,
workflow administration/subscriptions, recurring definitions, API-key management,
refunds and unadapted CRUD. M3 must audit every additional route it opens.

## Worker, workflow and external-resource contracts

`tenant-jobs.cjs` writes the business job and server dispatch atomically. Signed
dispatch envelopes bind job ID, tenant, actor, kind and payload fingerprint.
Workers restore a fresh opaque context after checking the current tenant and
membership/customer, claim with SKIP LOCKED, renew their lease, retry bounded
failures and fence stale acknowledgments. Pending tenant initialization is
deferred; inactive tenants cannot run business handlers.

Delivery is **at least once**. Durable idempotency is required in every handler
that performs a side effect. Native create-cart and complete-cart workflows use
persistent checkpoints and idempotent replay. Execution IDs, checkpoint storage
and lock ownership are tenant scoped. Native retry/timeout callbacks become
durable resume jobs. Native asynchronous workflows can enqueue more than one
resume job; completion requires processing the follow-up jobs, not just the
first acknowledgment. Acceptance covers restart during a step retry, native
compensation, and a crash after a completed cart workflow but before job ack.
The acceptance launches three independent Node worker processes with fixture
configuration sent privately over IPC, terminates the unacknowledged worker with
SIGKILL, and resumes the checkpoint in a fresh process. It also rechecks the
persisted Session after reopening the HTTP application.

Native events are signed jobs. Group release/cancellation is tenant scoped and
survives restart. Register custom handlers at every application boot; missing
handlers fail closed. No email sender or downloadable exporter is configured.
The acceptance event handler resolves its recipient and exported orders through
protected native services. Actual delivery and export endpoints remain closed.

`tenant-resources.cjs` supplies SQL-backed tenant-local cache/locks and a local
private-file backend. File metadata uses RLS; object paths include a tenant hash;
signed download tokens also require the same verified tenant context. Maximum
upload size is 5 MiB. No public HTTP object route, CDN, S3 or external signed-URL
provider is accepted in this increment. Graph/new indexed cache stays disabled.
Session persistence is Host/SID HMAC keyed and AES-GCM encrypted in PostgreSQL;
the same cookie cannot authenticate on another shop after restart.

`tenant-callback.cjs` defines a reference HMAC callback contract: lookup a
server-owned credential binding, verify raw-body signature and timestamp, verify
external account, then enter the binding's tenant and enqueue idempotently.
Payload tenant authority is rejected. This is a tested internal contract;
vendor-specific signatures, credential storage/lifecycle, amounts, refunds,
ordering and HTTP exposure belong to M4. It is not a Stripe/PayPal adapter.

Only the native in-memory workflow engine with SQL checkpoints plus these durable
jobs is enabled/tested. Redis workflow model metadata is prepared, but the Redis
engine's storage/runtime path is not accepted. Context-free recurring cleanup,
global SSE subscriptions and recurring workflow definitions remain disabled.
Handlers should be short or chunked: internal authority expires after five
minutes, independently of lease renewal. Worker fairness, quotas and backlog/
dead-letter monitoring belong to M5; no capacity or exactly-once claim is made.

## Start a configured M2 instance

Inject persistent configuration through the deployment environment. Reuse M1's
`SAAS_DATABASE_URL`, `SAAS_MIGRATION_DATABASE_URL`, `SAAS_APPLICATION_ROLE`,
`SAAS_BASE_DOMAIN`, `SAAS_PLATFORM_ACTOR_ID`, `SAAS_JWT_SECRET`,
`SAAS_CONTEXT_SECRET`, `SAAS_IDENTITY_SECRET` and `SAAS_PLATFORM_KEY`. Keep the
same identity secret: changing it changes the native emailpass namespace.
Add `SAAS_OBJECT_ROOT` for private objects and optionally `SAAS_RUN_WORKER=true`.
The migration process and runtime role must be separate. Configure TLS and a
trusted ingress that preserves shop Host; Secure cookies are the starter default.

```bash
node saas/migrate-m2-command.cjs
node saas/provision-platform-operator.cjs
node saas/start-m2.cjs
```

The migration command does not reset a database. Review the native reference
seeds before explicitly enabling their narrow conversion flag. Startup refuses
missing/changed migrations or unsafe live metadata. The starter binds loopback
by default and waits for the worker during graceful shutdown. Use this explicit
gateway; starting the unrestricted stock server bypasses the HTTP route boundary.

Complete merchant/browser integration is M3; independent payment accounts,
inventory contention, fulfillment and refunds are M4; operational controls are
M5; complete performance, security, license/dependency and restore acceptance is
M6. AI, Helpdesk/CRM/marketing and a new merchant interface remain outside M2.
