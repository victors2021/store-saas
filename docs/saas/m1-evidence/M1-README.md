# M1: persisted tenancy and native HTTP integration

Source: Medusa MIT 2.18.0, `1014c0337027a6087410ad3cc1da9a11fd83ca8d`.
This increment implements the six M1 tasks for the catalog and identity surface.
AI, new merchant UI, and M2 transaction domains are not part of this increment.

## Reproduce acceptance

```bash
source /workspace/.medusa-baseline/activate.sh
cd /workspace/.medusa-baseline/mit-source
SAAS_ARTIFACT_DIR=/tmp/medusa-m1-results bash saas/verify-m1.sh
```

The verifier runs the original native transaction regressions with SaaS mode
disabled, then actual versioned migrations and M1 HTTP acceptance with SaaS mode
enabled. PostgreSQL/Redis are pinned loopback test containers. Reset operations
accept only their exact, marked disposable database names. No unknown database
is reset, and no default tenant is assigned to existing rows.

## Implementation

1. `inventory-m1.cjs`, `m1-ownership.json` and `M1-SCOPE.md` enumerate native DML,
   pivots, Links, method/path exports and SQL candidates. Unreviewed M2 entries
   remain marked as such. The inventory does not enable any endpoint.
2. `.tenantScoped()` adds required trusted `tenant_id` metadata only when
   `MEDUSA_SAAS_MODE=true` is set **before modules load**. Product/Pricing,
   Auth/User/Customer, implicit pivots and generated Links are covered. Business
   uniqueness becomes tenant-local. Independent checksum-checked migrations
   `0002-catalog` and `0003-identity` own RLS and composite FK constraints.
   Native destructive schema generation is refused for protected tables.
   Link regeneration is tested as noop; raw module schema diff is not claimed
   to be empty because ORM cannot represent all external RLS/FK constraints.
3. `tenant-control.cjs` persists tenant, membership, platform subdomain, public
   key, initialization lease/fingerprint, platform identity and audit records in
   the server-only `saas_control` schema. Native Graph never exposes these tables.
   Concurrent and failed opening requests retain the same tenant/owner identity.
4. `auth-integration.cjs` scopes native emailpass by tenant and actor type using
   a persistent HMAC namespace key. Native password hashing and JWT generation
   remain in Medusa. Tokens include immutable tenant/actor bindings. Native actor
   attachment verifies email and current-tenant visibility.
5. `m1-application.cjs` starts real native modules and mounts native login,
   session, Admin merchant-self/catalog handlers and Store catalog handlers with
   native validators. Customer creation uses native Customer/Auth services and
   deterministic retry identity. It is an explicit M1 HTTP gateway, not the
   unrestricted stock Medusa server. Host lookup happens before service access;
   JWT/cookie identity is rechecked against native identity and persisted owner
   membership. Session login rotates the SID. Bodies/queries/headers cannot
   select a tenant. Forwarded-host is rejected; configure a trusted ingress to
   preserve the actual shop Host. Store keys cannot override Host.
6. `m1-http.test.cjs` tests two real shops, same email/handle/SKU, CRUD/count,
   deep pricing, known foreign IDs and relations, token/header/body tampering,
   cookie binding/rotation, interrupted opening recovery, 40 concurrent reads
   and 40 concurrent writes, missing context, privileged runtime rejection and
   suspension without affecting another shop.

Catalog writes currently require inventory disabled for variants; sales-channel
and shipping-profile assignment, imports/exports/uploads, order/cart/payment,
MFA/OAuth/reset/refresh and unrestricted field expansions are closed. Empty
catalog-workflow inventory validation does not resolve optional domains. The M1
legacy RemoteQuery bridge returns an empty result for an empty conjunctive ID
selection without resolving a disabled module. Other native queries retain
their native implementation. Graph caching is disabled.

## Start a configured environment

Provide values through secret injection, not shell command arguments or committed
`.env` files. The required configuration names are:

- `MEDUSA_SAAS_MODE=true`.
- `SAAS_DATABASE_URL`: runtime connection, a dedicated NOSUPERUSER/NOBYPASSRLS
  role with no role/database creation, table ownership or owner-role membership.
- `SAAS_MIGRATION_DATABASE_URL` and `SAAS_APPLICATION_ROLE`: offline migration
  connection and the precreated runtime role name. Never pass the migration URL
  to the HTTP service.
- `SAAS_BASE_DOMAIN`, `SAAS_PLATFORM_ACTOR_ID`.
- `SAAS_JWT_SECRET`, `SAAS_CONTEXT_SECRET`, `SAAS_IDENTITY_SECRET`,
  `SAAS_PLATFORM_KEY`: persistent strong secrets, at least 32 bytes each.

Then run the reviewed migrations, provision the offline platform operator, and
start the HTTP service:

```bash
node saas/migrate-m1-command.cjs
node saas/provision-platform-operator.cjs
node saas/start-m1.cjs
```

The service binds loopback by default. The starter enforces Secure/HttpOnly/Lax
cookies. TLS/proxy/session-store production configuration belongs to deployment
acceptance, so this is not a production launch recipe. The present HTTP session
store is process memory and the event bus is native local; durable shared session,
worker/retry/event acceptance remains future work. Constructor checks migration
checksums and actual RLS/FK/index/role metadata before serving requests.

Platform opening is `POST /platform/tenants` with the independent platform bearer
key and `{slug,name,email,password,idempotency_key}`. The server derives the owner
ID and HMAC initialization fingerprint; no client actor ID is accepted. The
operator must also be active in the offline platform-identity table. M1 has one
immutable owner per shop; owner revocation/transfer is unavailable. Tenant
suspension stops all M1 HTTP access. Payment callback/refund exceptions are M4/M5
work, not implemented by the M1 suspension primitive.

Full native Admin UI navigation and reference storefront adaptation remain M3.
The acceptance proves the opened native Admin HTTP operations, not browser UI
E2E. Existing production data migration, all transaction modules, durable tasks,
cache/files/locks, real payments, SBOM/NOTICE and complete security clearance are
still required before SaaS MVP release.
