# M5: tenant operations and recovery

M5 extends the frozen MIT Medusa 2.18.0 M4 application in `store-saas/saas-mvp`.
It adds an actual platform console and a native Admin **Operations** extension.
The separate merchant UI remains paused; AI, Helpdesk, CRM and marketing remain
in phase two. Actual Stripe sandbox acceptance and actual off-host backup
acceptance are still required before a pilot release.

## Build and verify

Use Node 22.23.3, bundled root Yarn 3.2.1, Docker, Python Playwright and Chromium.
The frozen storefront uses its own bundled Yarn 4.12.0. Install and build as in
the root README, then run:

```bash
SAAS_ARTIFACT_DIR=/tmp/store-saas-m5-results bash saas/verify-m5.sh
```

The strict script includes the complete M0–M4 regression, production Admin/Next
builds, then M5 HTTP, M4-to-M5 upgrade, encrypted backup/restore, launcher and
browser checks. Only explicitly marked disposable loopback databases are reset.
Fixtures sharing a database run sequentially. The restore test creates and
removes an independent pinned PostgreSQL container; it is on the same physical
host. It does not demonstrate an off-host copy or a production deployment.

## Upgrade and start

Keep all M4 runtime keys and the separately privileged migration connection.
Stop gateway and worker processes before migration; take a matching M4 database,
object and secret snapshot with the existing operator procedure first.
`SAAS_OBJECT_ROOT` must be an absolute path to the actual existing object tree.

```bash
node saas/migrate-m5-command.cjs
# For old M2 tenants not already initialized for the browser application:
SAAS_ENABLE_OPERATIONS=true node saas/initialize-m3.cjs TENANT_ID
node saas/start-m5.cjs
```

Migration inputs: `SAAS_MIGRATION_DATABASE_URL`, `SAAS_APPLICATION_ROLE`,
`SAAS_JWT_SECRET`, `SAAS_OBJECT_ROOT`. The reviewed native reference seed
exception in M2 still applies only to that specific case. Unknown unowned data
and destructive native Link plans require their own migration review.

`0007-operations` verifies existing objects before adopting byte quotas. A
missing, oversized, symlinked or incorrectly namespaced legacy object aborts
the operations migration. The previous migration files/checksums are unchanged.
Startup verifies actual RLS, grants, constraints, trigger definitions, function
bodies and a portable schema fingerprint. Old M1–M4 launchers reject an M5
database. Do not roll back only the application binary or run mixed M4/M5 writers.

Runtime retains `SAAS_DATABASE_URL`, `SAAS_BASE_DOMAIN`, `SAAS_PLATFORM_ACTOR_ID`,
`SAAS_JWT_SECRET`, `SAAS_CONTEXT_SECRET`, `SAAS_IDENTITY_SECRET`,
`SAAS_PLATFORM_KEY`, `SAAS_OBJECT_ROOT`, `SAAS_PAYMENT_KEY` and the trusted
proxy/TLS settings described in M3/M4. The platform actor must already be
explicitly provisioned in `saas_control.platform_identity`; knowing a key alone
does not activate an operator. The worker defaults on. With it disabled,
readiness returns 503 until an actual worker has a fresh heartbeat.

## Operate stores

Open `https://platform.<SAAS_BASE_DOMAIN>/platform`. The platform console takes
the existing operator bearer key over HTTPS, keeps it only in page memory and
clears the input. Restrict this Host to the operations network at the ingress.
It lists tenant metadata and allows manual pilot cap changes and pause/resume.
Creation continues through the existing authenticated `/platform/tenants` API;
this increment does not add an onboarding wizard or subscription charging.
The platform console cannot read native merchant orders or customer records.

The single `pilot` plan defaults to 1,000 non-deleted products, 100 MiB uploaded
bytes and 1,200 requests/minute. Platform cap changes use an expected version and
cannot reduce capacity below actual usage. Existing stores above the default
product cap are adopted with a sufficient cap within the supported bounds.
Product insert/delete/restore and file reservations update quotas atomically in
PostgreSQL. Pending/deleting files remain charged until cleanup actually succeeds.
Uploads retain the existing 5 MiB per-object maximum.

Pause blocks new checkout, capture, new customer registration and normal business
writes. Owners can authenticate, inspect their records and use existing refund,
cancel and paid-order fulfillment/shipping paths. Customer order read APIs remain
tenant/customer scoped. The fixed storefront page returns a paused response;
there is no new customer-facing paused-order portal. Signed callbacks for an
existing order and its refunds continue. An unlinked checkout while paused is
held for review rather than creating a new order.

Native Admin **Operations** shows this tenant's status, quotas, uncertain payment
operations and recent audit entries. Retry uses the server's saved operation body
and original idempotency key. Known remote refund IDs are retrieved before any
new vendor request. An old uncertain effect without a remote ID requires operator
reconciliation; do not invent a new key or delete its recovery rows.

## Monitoring and retention

`/health/live` checks API liveness; `/health/ready` and `/health` require the
database and a worker heartbeat within 30 seconds. The authenticated platform
operations API shows queue failure/backlog, cleanup errors and a missing/stale
backup receipt. A receipt proves local encrypted bundle creation only; the API
explicitly keeps `off_host_backup_verified=false`.

Rate limits are atomic minute windows. Store traffic and authenticated owner
traffic have separate plan budgets; auth has 20/minute per tenant/HMAC-IP,
callbacks have 600/minute per tenant, platform has 60/minute per HMAC-IP.
Untrusted forwarding headers do not select the authority or client address.
429 includes Retry-After. Fair queue scheduling reserves extra capacity for
financial callbacks and keeps one active job per tenant.

Audits retain request ID, trusted tenant/actor, route category, method, status and
safe error code. Request bodies, query values, secrets and private resource paths
are excluded. Audited native writes require an accepted-event append before
execution; completion auditing is best effort and a failure appears as an
operations alert. Rate/admission failures before that listener are represented
by counters/errors, not a guarantee of complete per-request audit coverage.
Optional `SAAS_LOG_JSON=true` emits the same bounded fields. The ingress must
also redact its own logs.

Cleanup runs bounded batches: audit 90 days, completed native event tasks 30 days,
expired cache/locks/sessions/rate windows and abandoned file reservations.
Payment effects, callbacks, credentials, cart/payment operation ledgers and all
native workflow checkpoints remain retained for recovery. Monitor their size.
There is no destructive general checkpoint collector in this increment.

## Encrypted full backup and restore

The offline `node saas/m5-backup.cjs create|restore` operator tool bundles the
full PostgreSQL custom dump, owned media, hashes and encrypted recovery keys
under AES-256-GCM. Supply an independent 32-byte hex `SAAS_BACKUP_KEY` from a
secret store. The tool refuses overwrites and active fenced business mutations.
Remote control and PostgreSQL tool connections require certificate-verified TLS.
Transient plaintext dump/tar files use restricted permissions and are removed;
the operator's temporary volume must also be protected. The pilot bundle maximum
is 8 GiB. No public backup API or destination-specific upload service is added.

Restore requires an explicitly named absent database, absent object directory,
safe application role and matching confirmation. It verifies authentication,
archive paths, digests, migration metadata and runtime RLS/grants; source sessions
and heartbeats are cleared. Runtime keys can be exported only outside the source
checkout, to a new 0600 file. The role password and deployment/TLS configuration
must be provisioned separately. Reconcile vendor state since the snapshot before
opening a restored deployment for writes.

Exact variables, operating sequence, off-host acceptance and matching code/data
rollback are in [the runbook](../docs/saas/18-OPERATIONS-RUNBOOK.md).
Results and screenshots: [implementation](../docs/saas/16-M5-IMPLEMENTATION.md),
[development review](../docs/saas/17-M5-CODE-REVIEW.md).
