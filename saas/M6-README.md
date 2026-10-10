# M6: acceptance, hardening and controlled release

M6 retains the MIT Medusa **2.18.0** source and historical M5 migrations.
The current runtime also verifies additive `0008-platform-login`, which adds
platform email credentials and revocable sessions without editing `0001`–`0007`.
The subsequent `0009-self-service` adds merchant accounts, owned shop openings
and removable samples without editing previous migrations. See the
[self-service report](../docs/saas/24-SELF-SERVICE-ONBOARDING.md) for demo setup,
email verification limitations, screenshots and current targeted checks.
It adds a complete mounted/closed API matrix, stronger media cleanup, checkout
compensation repair, bounded Prometheus metrics, an operator monitor, supply
chain inventory, repeatable load tests and a fail-closed pilot release gate.
Native Admin remains the merchant interface. AI and customer operations remain
in phase two.

M6 local development acceptance and actual pilot release are separate states.
The development report and measured results are in
[the implementation report](../docs/saas/19-M6-IMPLEMENTATION.md). Official
Stripe, authorized live payment/refund, actual off-host restore, actual target
deployment/alarm delivery, independent review and merchant feedback must be
accepted before release. The user has explicitly deferred off-host acceptance
until a target is ready.

## Install, rebuild and verify

Use Node **22.23.3**, root bundled Yarn **3.2.1**, Docker, Python Playwright and
Chromium. Keep the managed proxy/CA configuration. The storefront has its own
bundled Yarn **4.12.0**. M6 intentionally updates security dependencies and both
lockfiles; the root MIT license, native 2.18.0 versions and applied migrations
are retained. Root checksum behavior now defaults to `throw`.

```bash
export NODE_OPTIONS=--max-old-space-size=4096
export YARN_CHECKSUM_BEHAVIOR=throw
export YARN_NM_MODE=hardlinks-local
yarn install --immutable --inline-builds
SAAS_ARTIFACT_DIR=/tmp/store-saas-m6-results bash saas/verify-m6.sh
```

The strict verifier builds native code, Admin and Next before running fixtures,
executes the M0–M5 regression, then platform email authentication, self-service
HTTP/browser checks, M6 security, transactions, TLS/snapshot
recovery, release gates, SBOM/advisories and a **30-minute** benchmark. It takes
longer than 30 minutes including builds, native seeding and checkout conflicts.
Only marked, explicitly authorized disposable loopback databases are reset.
Avoid concurrent builders replacing `dist` or `.next` during fixtures.

For the small diagnostic profile after building:

```bash
SAAS_M6_PERF_RESET=1 SAAS_ARTIFACT_DIR=/tmp/store-saas-m6-smoke \
  node saas/m6-performance.cjs --quick
```

The smoke profile is 30 seconds with smaller catalogs/history. It does not
qualify the reference performance gate. The full run uses 10 tenants, 1,000
products/2,000 variants/10,000 history orders each, 20 RPS for 1,800 seconds and
a separate 20-request inventory conflict. The updated user target is aggregate
ordinary API **P95 ≤ 300 ms**, replacing the original 800 ms planning target.
All issued requests, including initial cold requests, contribute to the result.
Ordinary traffic is 80% product
browse, 15% active cart read/update, 5% native Admin order read. Historical
order/address/item/totals/shipping shapes are bulk cloned from native workflow
output under application RLS; historical provider/refund/fulfillment/workflow
ledgers are excluded. The benchmark reports that profile and observed hardware.
It cannot imply a production tenant count or real Stripe latency.

The bulk catalog copies price/channel/shipping relationships but sets cloned
variants to unmanaged inventory. The full fixture has 10 original managed
variants/inventory items and 19,990 unmanaged variants. The separate checkout
conflict tests real stock on an original item; this is not a complete 20,000-SKU
managed-stock/multi-warehouse inventory benchmark. Target acceptance must review
that catalog profile as well as the reduced historical ledgers.

The benchmark runs **two independent Node API processes**, each with four native
and four application DB connections, sharing the same verified database, keys
and object root. One background worker drains the durable queue. Routing sends
both product list/detail and order list/detail shapes to both processes; resource
samples include both process RSS/CPU and combined API RSS. The current test
exercises the APIs directly; browser/Next rendering and public network/TLS latency
need their own measurements. Checkout and vendor waits have separate results.

## Platform administrator

The platform console now uses an offline-provisioned **email and password**.
It displays the authenticated administrator email and retains a fixed one-hour,
Secure, HttpOnly, host-only server session across refresh. Logout, password
reset, expiry and persisted operator revocation invalidate that session.
Native merchant Admin uses each store's email/password and separate tenant-bound
sessions; a merchant identity never grants platform authority.

Run the current `node saas/migrate-m5-command.cjs` with the existing privileged
migration configuration to add `0008` and `0009`. Then provision a platform operator using
`SAAS_MIGRATION_DATABASE_URL`, `SAAS_PLATFORM_ACTOR_ID`, `SAAS_PLATFORM_EMAIL`
and an absolute `SAAS_PLATFORM_PASSWORD_FILE` in a private directory:

```bash
node saas/provision-platform-login.cjs
```

The offline command generates a private random password when its file is absent
and stores a scrypt hash in the database. Repeating it does not rotate existing
credentials or reactivate revoked operators. An explicit reset requires
`SAAS_PLATFORM_RESET_PASSWORD=true` and invalidates prior sessions. No HTTP
endpoint grants platform authority or changes operator credentials. The runtime
role has SELECT-only credential privileges.

Use `https://platform.<SAAS_BASE_DOMAIN>/platform` over the restricted HTTPS
ingress. Password input is cleared after submission; no credentials enter
localStorage/sessionStorage. Cookie mutations require exact Origin and CSRF.
The existing persistent **`SAAS_PLATFORM_KEY`** and **`SAAS_PLATFORM_ACTOR_ID`**
remain available for controlled API automation/monitoring and check persisted
authority. Retain the stable five-key runtime configuration; no rotation is
needed for this upgrade. Knowing a platform key does not grant native merchant
data access.

The current cloud workspace also has a separately owned **local development**
preview operator `platform_admin`, with the user-selected login email
`admin@shops.example.test`. Its secrets and database
are outside the Git checkout and outside all disposable test reset paths. That
preview does not configure formal cloud Secrets, public DNS or release gates.
See [email login setup and evidence](../docs/saas/22-PLATFORM-EMAIL-LOGIN.md)
for the protected password location, actual UI and current access limitations.

## Metrics, monitoring and admission

`GET /platform/metrics` is Prometheus text with the same persisted platform
authority and Host check. Categories/method/status/trusted tenant labels are
bounded at 10,000 series. Query strings, bodies, resource paths, actor IDs and
credentials are omitted. Dropped series have a counter. Counters reset on
process restart; an operator-owned collector must persist and alert on them.

```bash
node saas/m6-monitor.cjs
```

Configure `SAAS_MONITOR_BASE_URL` as the bare HTTPS platform origin and provide
`SAAS_PLATFORM_KEY` through the secure environment. The monitor verifies TLS
with the configured CA/proxy and returns safe alert codes. Exit `2` means an
observed alert/unavailable API, `1` means invalid configuration. It sends no
messages; actual notification transport/delivery is operator release acceptance.

Snapshot fencing reserves **12 HTTP + 2 background** PG connections separately
from application/native pools. Both still use the same advisory snapshot lock.
Saturated mutation admission returns `409` and `Retry-After: 1`; retry the same
idempotency key. Database unavailability or maintenance returns `503`.
Readiness still requires a fresh real worker heartbeat.

The five explicit workflow orchestration entries validate the current tenant,
inputs and manager authority without holding a SQL transaction for the whole
cross-module flow. Business module calls and checkpoint reads/writes retain
their own transaction-local RLS. A regression runs twelve cart workflows across
two tenants with the native pool capped at four connections and verifies that
cross-store cart reads are still rejected.

A second real process regression verifies cross-process tenant-bound JWT/cookie
sessions, immediate cart writes, same-key concurrent checkout with exactly one
order, cross-store rejection and persisted platform operator revocation. No
cross-request business cache is introduced by the performance changes.

The exact storefront channel-to-product ID query uses scalar SQL through the
application role and verified tenant transaction, avoiding hydration of a large
Link graph for a single-column projection. It retains soft-delete and existing
product-ID intersection filters. All other projections, filters and Query
options retain the native implementation. This does not bypass RLS or cache
tenant data across requests.

## Pilot launch gate

Prepare an operator-owned acceptance directory with a current source manifest,
digest-bound evidence and a `format: 1`, `target: "pilot"` release record.
[Release acceptance](../docs/saas/21-RELEASE-ACCEPTANCE.md) defines all ten gates
and report fields. A current development packet is archived with the evidence;
pending/deferred gates deliberately keep it blocked.

```bash
node saas/m6-release-gate.cjs manifest > /ABSOLUTE/acceptance/source.sha256
node saas/m6-release-gate.cjs /ABSOLUTE/acceptance/release.json
NODE_ENV=production SAAS_RELEASE_MANIFEST=/ABSOLUTE/acceptance/release.json \
  node saas/start-m6.cjs
```

The gate checks source hashes, unchanged MIT provenance, evidence digest,
same-source binding, freshness within seven days and typed acceptance facts.
Invalid, missing, deferred or stale evidence produces exit `2` before database
startup. These checks bind operator-reviewed facts; they do not authenticate a
reviewer or turn a manually edited JSON assertion into real-world evidence.
The gate is a startup check, not an online expiry scheduler.

An isolated development rehearsal can use `NODE_ENV=development` with no release
record. The child storefront still uses a production build. Keep its bind address
loopback and do not use this path to serve a public pilot. Operators must use the
M6 entry; the retained historical launchers are not a tamper-proof enforcement
boundary against an operator who controls code or process arguments.

## Deployment and recovery

Render `deploy/nginx.conf.example` and `deploy/saas-gateway@.service.example` with
the actual domain, escaped domain regex, certificate paths, restricted operator
CIDRs, Node and checkout paths. Run `nginx -t` and `systemd-analyze verify` on the
actual target. Install built, immutable releases with non-root ownership and
an exclusive writable object volume. Forward original Host, replace forwarding
claims and trust only the actual ingress. Keep secrets out of query/header logs.

The Nginx example now balances two gateway instances on `9000` and `9001`.
For that topology use `deploy/saas-gateway@.service.example`, a shared protected
`/etc/store-saas/runtime.env` and two protected instance files:

| Instance file | PORT | SAAS_STOREFRONT_PORT | SAAS_RUN_WORKER |
|---|---:|---:|---|
| `/etc/store-saas/instances/primary.env` | 9000 | 8000 | true |
| `/etc/store-saas/instances/secondary.env` | 9001 | 8001 | false |

Both use the same `SAAS_OBJECT_ROOT`, database, stable runtime secrets and release
record. Each starts its own built Next process on a distinct port. The retained
single-instance service remains a smaller development option; it does not claim
the two-process performance result. Render and verify the instance template on
the actual host before installing it. Per-process metrics are deterministic TLS
targets `/platform/metrics` and `/platform/metrics/secondary` on the restricted
platform Host; scrape both separately and aggregate in the collector. Rolling
restarts, instance failover and public proxy latency still require target rollout
acceptance. These templates do not deploy or enable a service automatically.

M6 needs no new tenant migration. Stop writers, take a matching code/DB/media/key
snapshot, rebuild and start the M6 candidate. M6 retains M5 schema compatibility;
an M5 dependency/binary downgrade is not certified by the M6 restore rehearsal.
Recovery testing restores an empty owned database, media and keys, then restarts
the **same M6** source. It is local TLS/config-failure/snapshot recovery, not a
public rollout, off-host restore, or proof of financial state since the snapshot.
Reconcile Stripe state before reopening a restored system for writes. See
[the runbook](../docs/saas/18-OPERATIONS-RUNBOOK.md).

## Supply chain and review limits

`node saas/m6-supply-chain.cjs /ABSOLUTE/output` writes CycloneDX 1.6, complete
lock edges, installed license evidence/NOTICE texts, official npm advisory
observations and embedded sharp/libvips versions/binary hashes. It needs both
immutable dependency installations. Failures remain failures; the tool does
not silently produce a clean result when the registry is unavailable.

The remaining advisory triage, optional/uninstalled package metadata, actual
browser/server/native binary distribution obligations and image/OS vulnerabilities
require review. The native bundle declares LGPL; the project-wide MIT license
does not relicense those components. SaaS network use and distributing an image
or binary have different obligations.

RLS and composite tenant constraints enforce app query isolation; the shared DB
role is trusted to set a verified tenant GUC. Arbitrary SQL execution or a stolen
runtime DB credential is outside that authority boundary. Media path checks also
assume an exclusive object volume; an OS attacker racing parent replacements is
outside the filesystem guarantees. See the development review for these limits.
