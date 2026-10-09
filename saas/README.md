# MIT SaaS development baseline and native ORM pilot

Current development entry: [M6 acceptance and controlled release](M6-README.md).
M6 deliberately updates security dependencies/lockfiles and checksum defaults;
the native MIT 2.18.0 source/version and applied M5 migrations remain retained.

The native Admin and fixed storefront integration are documented in
[M3-README.md](M3-README.md), following [M2-README.md](M2-README.md) and
[M1-README.md](M1-README.md).
This file records the earlier bounded pilot; its outstanding items are historical.

The fork starts from Medusa **2.18.0**, commit
`1014c0337027a6087410ad3cc1da9a11fd83ca8d`, before the prospective enterprise
license change. Root MIT remains intact. `BASELINE.json` lists four selected
security backports and the remaining release gates. The original
`/workspace/medusa` checkout is preserved.

## Run the verified workflow

In this cloud workspace:

```bash
source /workspace/.medusa-baseline/activate.sh
cd /workspace/.medusa-baseline/mit-source
bash saas/verify-baseline.sh
```

The script uses `set -euo pipefail`, preserves failed command exit status, and
stores logs/results in `/tmp/medusa-saas-verification` unless `SAAS_ARTIFACT_DIR`
is supplied. It builds the separately scripted Loyalty plugin and checks its
compiled hook/module before running the original order tests. Omitting this
plugin build silently omitted the anonymous store-credit refund restriction.

`start-services.sh` checks and starts the pinned PostgreSQL/Redis containers.
Both bind only to loopback. PostgreSQL trust authentication is exclusively for
disposable development tests; it is unsuitable for production. No real payment
account, email sender or external fulfillment provider is used.

To run only the tenant identity/adapter unit checks:

```bash
node --test saas/tenant-context.test.cjs
```

To run the actual native ORM experiment:

```bash
bash saas/start-services.sh
SAAS_PROBE_RESULT=/tmp/native-catalog.json node saas/native-catalog-probe.cjs --reset
```

`--reset` only replaces `medusa_saas_catalog_probe` if its database comment
matches the probe marker. It refuses to reset an unmarked database. Production
database URLs are not accepted. The administrator creates native schema and
tenant constraints; the running native services use a separate
`NOSUPERUSER NOBYPASSRLS` application role.

## What the pilot implements

- `tenant-context.cjs`: verified HS256 sessions, issuer/audience/expiry and
  server-side membership lookup; immutable, opaque tenant identity in ALS.
- `tenant-module.cjs`: in-place adaptation of context-aware native service
  methods. Each module gets its own native transaction and transaction-local
  PostgreSQL setting. Callers cannot supply a tenant field or an external manager.
- `catalog-schema.cjs`: RLS, tenant-local unique indexes and composite FKs on
  the native migrated Product/Pricing tables and link tables in this owned DB.
- `native-catalog-probe.cjs`: actual native Product/Variant, pricing rules and
  calculations, Link, Graph and synchronous Workflow checks, including
  alternating concurrent reads/writes and unscoped pooled connections.
- Native pricing repository queries now use the supplied transaction; rule
  attributes are read per calculation rather than cached across tenants.
- Native variant-image reads populate DTOs without replacing managed entity
  collections; image removal carries the same native transaction context.

The membership lookup in the probe is an explicitly seeded test fixture. The
opaque-context and transaction tests use mocks; the native probe uses real
PostgreSQL and native modules. Neither is a production tenant HTTP login.

## Adoption gates

This is a bounded **native ORM experiment**, not complete SaaS isolation.
Tenant columns are currently added after native migrations, with a database
default derived from the trusted transaction context. They are not yet
synchronized into DML model metadata or the link generator. Do not run native
schema synchronization against this augmented database: reconcile the models,
DTOs, indexes and migrations first. Existing production data is not migrated.

Next work includes actual tenant/membership/domain persistence, native owner
and consumer authentication, protected HTTP scopes, all other transaction
modules, durable worker/retry context, tenant-aware cache/files/locks, full Store
field hardening, dependency/security/license review, independent payments and
complete backup/restore acceptance. Graph caching is disabled in the probe.
Do not expose internal module helpers by generating an HTTP allowlist from the
adapted object. Cross-module calls use separate transactions; no cross-module
atomicity or persistent worker guarantee is claimed.

The current public API scope remains MVP: reuse Medusa Admin and a reference
storefront. AI and customer operations remain phase two.
