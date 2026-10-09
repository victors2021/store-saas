"use strict"

// Real PostgreSQL persistence/retry tests; never target a configurable or remote
// database. Only an explicitly marked localhost disposable database can reset.
const assert = require("node:assert/strict")
const { test, before, after } = require("node:test")
const { Pool, Client } = require("pg")
const { installTenantControl, createTenantControl, normalizeHost } = require("./tenant-control.cjs")

const DB = "medusa_saas_control_test"
const ROLE = "medusa_saas_control_test_app"
const MARKER = "medusa-saas-disposable-control-test-v1"
let admin, pool, control
let initialized = []

async function prepare() {
  const bootstrap = new Client({ connectionString: "postgres://postgres@localhost:5432/postgres" })
  await bootstrap.connect()
  try {
    const existing = (await bootstrap.query(`SELECT shobj_description(oid, 'pg_database') AS marker
      FROM pg_database WHERE datname=$1`, [DB])).rows[0]
    if (existing) {
      if (existing.marker !== MARKER || process.env.SAAS_CONTROL_TEST_RESET !== "1") {
        throw new Error("Control test DB exists: only SAAS_CONTROL_TEST_RESET=1 on the marked disposable DB is permitted")
      }
      await bootstrap.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [DB])
      await bootstrap.query(`DROP DATABASE ${DB}`)
    }
    await bootstrap.query(`CREATE DATABASE ${DB}`)
    await bootstrap.query(`COMMENT ON DATABASE ${DB} IS '${MARKER}'`)
    if (!(await bootstrap.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [ROLE])).rowCount) {
      await bootstrap.query(`CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`)
    }
  } finally { await bootstrap.end() }
  admin = new Client({ connectionString: `postgres://postgres@localhost:5432/${DB}` })
  await admin.connect()
  await installTenantControl(admin, { applicationRole: ROLE })
  await admin.query(`CREATE TABLE public.control_initialization_probe (
    tenant_id text PRIMARY KEY, version integer NOT NULL
  )`)
  await admin.query(`GRANT SELECT,INSERT ON public.control_initialization_probe TO ${ROLE}`)
  await admin.query("INSERT INTO saas_control.platform_identity(actor_id) VALUES ($1)", ["usr_operator"])
  pool = new Pool({ connectionString: `postgres://${ROLE}@localhost:5432/${DB}`, max: 5 })
  control = createTenantControl(pool, {
    baseDomain: "shops.example.test", platformAdminActorIds: ["usr_static_operator"],
    initializeTenant: async tenant => {
      initialized.push(tenant)
      await pool.query(`INSERT INTO public.control_initialization_probe (tenant_id,version)
        VALUES ($1,$2) ON CONFLICT DO NOTHING`, [tenant.tenantId, tenant.version])
    },
  })
}

before(prepare)
after(async () => { if (pool) await pool.end(); if (admin) await admin.end() })

test("versioned control migration rebuilds once and checks immutable migration checksum", async () => {
  assert.deepEqual(await installTenantControl(admin, { applicationRole: ROLE }), {
    applied: [], versions: ["001-tenant-control"],
  })
  const original = (await admin.query("SELECT checksum FROM saas_control.schema_migration")).rows[0].checksum
  await admin.query("UPDATE saas_control.schema_migration SET checksum=$1", ["invalid"])
  await assert.rejects(installTenantControl(admin), error => error.code === "CONTROL_MIGRATION_CHECKSUM")
  await admin.query("UPDATE saas_control.schema_migration SET checksum=$1", [original])
  await assert.rejects(installTenantControl(admin, { applicationRole: 'role";DROP SCHEMA public;--' }), TypeError)
  await assert.rejects(installTenantControl(admin, { applicationRole: "postgres" }), error => error.code === "CONTROL_UNSAFE_ROLE")
})

test("platform host normalization rejects lists, wildcard, URL, malformed ports and nested custom domains", async () => {
  assert.equal(normalizeHost("ALPHA.shops.example.test:8443"), "alpha.shops.example.test")
  assert.equal(normalizeHost("alpha.shops.example.test."), "alpha.shops.example.test")
  for (const value of ["", " alpha.shops.example.test", "alpha.shops.example.test ", "alpha.shops.example.test,evil.test", "https://alpha.shops.example.test", "*.shops.example.test", "alpha.shops.example.test:0", "alpha.shops.example.test:65536", "alpha..shops.example.test", "alpha.shops.example.test/", "alpha.shops.example.test\r\nx-test:1", "127.0.0.1", "[::1]:9000", "alpha.shops.example.test..", "user@alpha.shops.example.test"]) {
    assert.throws(() => normalizeHost(value), error => error.code === "INVALID_CONTROL_HOST", value)
  }
  assert.equal(await control.resolveDomain("custom.evil.test"), null)
  assert.equal(await control.resolveDomain("one.two.shops.example.test"), null)
  assert.equal(await control.resolveDomain("api.shops.example.test"), null)
})

test("opening persists tenant, owner membership, platform domain, public key and audit before activation", async () => {
  const tenant = await control.openTenant({ ownerActorId: "usr_alpha", slug: "alpha", name: "Alpha Shop" })
  assert.equal(tenant.status, "active")
  assert.match(tenant.id, /^tenant_[a-f0-9]{32}$/)
  assert.match(tenant.publicKey, /^pk_[a-f0-9]{32}$/)
  assert.equal(tenant.ownerActorId, "usr_alpha")
  assert.equal(tenant.initializationAttempts, 1)
  assert.equal((await control.getTenant(tenant.id)).id, tenant.id)
  assert.equal(await control.authorizeMembership({ tenantId: tenant.id, actorId: "usr_alpha" }), true)
  assert.equal(await control.authorizeMembership({ tenantId: tenant.id, actorId: "usr_beta" }), false)
  assert.equal((await control.resolveDomain("ALPHA.shops.example.test:8443")).tenantId, tenant.id)
  assert.equal((await control.resolveDomain("alpha.shops.example.test.")).publicKey, tenant.publicKey)
  assert.equal((await admin.query("SELECT count(*)::integer AS n FROM saas_control.membership WHERE tenant_id=$1", [tenant.id])).rows[0].n, 1)
  assert.deepEqual((await admin.query("SELECT action FROM saas_control.audit_event WHERE tenant_id=$1 ORDER BY id", [tenant.id])).rows.map(row => row.action), ["tenant.created", "tenant.initialization_started", "tenant.initialized"])
})

test("identical opening is stable across connections; changed owner or input cannot steal reserved domain", async () => {
  const request = { ownerActorId: "usr_beta", slug: "beta", name: "Beta Shop", idempotencyKey: "create_beta" }
  const first = await control.openTenant(request)
  const before = initialized.length
  const another = createTenantControl(pool, { baseDomain: "shops.example.test", initializeTenant: async () => { throw new Error("Must not rerun active tenant") } })
  const retry = await another.openTenant(request)
  assert.equal(retry.id, first.id)
  assert.equal(retry.publicKey, first.publicKey)
  assert.equal(retry.initializationAttempts, 1)
  assert.equal(initialized.length, before)
  for (const changed of [
    { ...request, name: "Replaced Shop" }, { ...request, ownerActorId: "usr_attacker" },
    { ...request, slug: "other-beta" }, { ...request, idempotencyKey: "changed_key" },
  ]) await assert.rejects(control.openTenant(changed), error => error.code === "TENANT_OPEN_CONFLICT")
})

test("concurrent identical opening claims one initialization and returns the same persistent tenant", async () => {
  let attempts = 0, unblock
  const blocked = new Promise(resolve => { unblock = resolve })
  const concurrent = createTenantControl(pool, {
    baseDomain: "shops.example.test",
    initializeTenant: async () => { attempts++; await blocked },
  })
  const request = { ownerActorId: "usr_parallel", slug: "parallel", name: "Parallel" }
  const first = concurrent.openTenant(request)
  while (!attempts) await new Promise(resolve => setImmediate(resolve))
  const others = await Promise.all(Array.from({ length: 20 }, () => concurrent.openTenant(request)))
  assert.equal(attempts, 1)
  assert.equal(new Set(others.map(tenant => tenant.id)).size, 1)
  assert.equal(others.every(tenant => tenant.status === "pending"), true)
  assert.equal(await concurrent.authorizeMembership({ tenantId: others[0].id, actorId: "usr_parallel" }), false)
  assert.equal(await concurrent.resolveDomain("parallel.shops.example.test"), null)
  unblock()
  const completed = await first
  assert.equal(completed.id, others[0].id)
  assert.equal(completed.status, "active")
  assert.equal(completed.initializationAttempts, 1)
})

test("different owners racing for a platform subdomain produce one success and one immutable conflict", async () => {
  const result = await Promise.allSettled([
    control.openTenant({ ownerActorId: "usr_race_a", slug: "reserved", name: "Reserved" }),
    control.openTenant({ ownerActorId: "usr_race_b", slug: "reserved", name: "Reserved" }),
  ])
  assert.equal(result.filter(item => item.status === "fulfilled").length, 1)
  assert.equal(result.find(item => item.status === "rejected").reason.code, "TENANT_OPEN_CONFLICT")
  const row = (await admin.query("SELECT id,owner_actor_id FROM saas_control.tenant WHERE slug='reserved'")).rows[0]
  assert.equal((await admin.query("SELECT count(*)::integer AS n FROM saas_control.membership WHERE tenant_id=$1", [row.id])).rows[0].n, 1)
})

test("failed initialization preserves owner/tenant identity and safely retries same immutable input", async () => {
  let attempts = 0, firstId
  const flaky = createTenantControl(pool, {
    baseDomain: "shops.example.test",
    initializeTenant: async tenant => {
      attempts++
      if (!firstId) firstId = tenant.tenantId
      assert.equal(tenant.tenantId, firstId)
      await pool.query(`INSERT INTO public.control_initialization_probe(tenant_id,version)
        VALUES ($1,$2) ON CONFLICT DO NOTHING`, [tenant.tenantId, tenant.version])
      if (attempts === 1) throw new Error("provider token=do-not-persist-sensitive-error")
    },
  })
  const request = { ownerActorId: "usr_retry", slug: "retry", name: "Retry Shop" }
  await assert.rejects(flaky.openTenant(request), error => error.code === "TENANT_INITIALIZATION_FAILED")
  const failed = await flaky.getTenant(firstId)
  assert.equal(failed.status, "failed")
  assert.equal(failed.initializationErrorCode, "INITIALIZATION_FAILED")
  assert.equal(JSON.stringify(failed).includes("do-not-persist"), false)
  assert.equal(await flaky.authorizeMembership({ tenantId: firstId, actorId: "usr_retry" }), false)
  assert.equal(await flaky.resolveDomain("retry.shops.example.test"), null)
  await assert.rejects(flaky.openTenant({ ...request, ownerActorId: "usr_stolen" }), error => error.code === "TENANT_OPEN_CONFLICT")
  const active = await flaky.openTenant(request)
  assert.equal(active.id, firstId)
  assert.equal(active.status, "active")
  assert.equal(active.initializationAttempts, 2)
  assert.equal((await pool.query("SELECT count(*)::integer AS n FROM public.control_initialization_probe WHERE tenant_id=$1", [firstId])).rows[0].n, 1)
})

test("credential initializer fingerprint is immutable across failed retries without persisting raw credentials", async () => {
  let shouldFail = true
  const fingerprinted = createTenantControl(pool, {
    baseDomain: "shops.example.test", initializeTenant: async () => {
      if (shouldFail) throw new Error("Seed owner initialization failed")
    },
  })
  const request = { ownerActorId: "usr_credentials", slug: "credentials", name: "Credentials",
    initializationFingerprint: "a".repeat(64) }
  await assert.rejects(fingerprinted.openTenant(request), error => error.code === "TENANT_INITIALIZATION_FAILED")
  await assert.rejects(fingerprinted.openTenant({ ...request, initializationFingerprint: "b".repeat(64) }), error => error.code === "TENANT_OPEN_CONFLICT")
  await assert.rejects(fingerprinted.openTenant({ ...request, initializationFingerprint: undefined }), error => error.code === "TENANT_OPEN_CONFLICT")
  await assert.rejects(fingerprinted.openTenant({ ...request, initializationFingerprint: "raw-password-not-a-digest" }), error => error.code === "INVALID_CONTROL_INPUT")
  shouldFail = false
  const retried = await fingerprinted.openTenant(request)
  assert.equal(retried.status, "active")
  assert.equal(retried.initializationAttempts, 2)
  const stored = (await admin.query("SELECT input_fingerprint FROM saas_control.tenant WHERE id=$1", [retried.id])).rows[0]
  assert.match(stored.input_fingerprint, /^[a-f0-9]{64}$/)
  assert.notEqual(stored.input_fingerprint, request.initializationFingerprint)
})

test("expired attempt lease is replayable while a stale initializer cannot overwrite a newer completed state", async () => {
  let calls = 0, unblock
  const blocked = new Promise(resolve => { unblock = resolve })
  const recoverable = createTenantControl(pool, {
    baseDomain: "shops.example.test", initializationLeaseMs: 100,
    initializeTenant: async () => { calls++; if (calls === 1) await blocked },
  })
  const request = { ownerActorId: "usr_recovered", slug: "recovered", name: "Recovered" }
  const stale = recoverable.openTenant(request)
  while (!calls) await new Promise(resolve => setImmediate(resolve))
  // Emulate process/clock lease expiry without a blocking wall-clock delay.
  await admin.query("UPDATE saas_control.tenant SET initialization_lease_until=now()-interval '1 second' WHERE slug='recovered'")
  const recovered = await recoverable.openTenant(request)
  assert.equal(recovered.status, "active")
  assert.equal(recovered.initializationAttempts, 2)
  unblock()
  const staleResult = await stale
  assert.equal(staleResult.id, recovered.id)
  assert.equal(staleResult.status, "active")
  assert.equal(staleResult.initializationAttempts, 2)
  assert.equal((await admin.query("SELECT count(*)::integer AS n FROM saas_control.audit_event WHERE tenant_id=$1 AND action='tenant.initialized'", [recovered.id])).rows[0].n, 1)
})

test("database constraints preserve tenant ownership and prevent owner membership revocation", async () => {
  const tenant = await control.openTenant({ ownerActorId: "usr_immutable", slug: "immutable", name: "Immutable" })
  await assert.rejects(pool.query("UPDATE saas_control.tenant SET owner_actor_id=$2 WHERE id=$1", [tenant.id, "usr_attacker"]), error => error.code === "23514")
  await assert.rejects(pool.query("UPDATE saas_control.tenant SET public_key=$2 WHERE id=$1", [tenant.id, "pk_replaced"]), error => error.code === "23514")
  await assert.rejects(pool.query("UPDATE saas_control.membership SET status='revoked' WHERE tenant_id=$1", [tenant.id]), error => error.code === "23514")
  await assert.rejects(control.setMembership({ tenantId: tenant.id, actorId: "usr_immutable", memberActorId: "usr_immutable", status: "revoked" }), error => error.code === "TENANT_OWNER_IMMUTABLE")
})

test("membership grants require matching owner or independent platform operator; revocation immediately removes access", async () => {
  const tenant = await control.openTenant({ ownerActorId: "usr_members", slug: "members", name: "Members" })
  await assert.rejects(control.setMembership({ tenantId: tenant.id, actorId: "usr_beta", memberActorId: "usr_staff" }), error => error.code === "TENANT_OWNER_REQUIRED")
  assert.deepEqual(await control.setMembership({ tenantId: tenant.id, actorId: "usr_members", memberActorId: "usr_staff" }), { tenantId: tenant.id, actorId: "usr_staff", role: "member", status: "active" })
  assert.equal(await control.authorizeMembership({ tenantId: tenant.id, actorId: "usr_staff" }), true)
  await assert.rejects(control.setMembership({ tenantId: tenant.id, actorId: "usr_staff", memberActorId: "usr_unauthorized" }), error => error.code === "TENANT_OWNER_REQUIRED")
  await control.setMembership({ tenantId: tenant.id, actorId: "usr_operator", memberActorId: "usr_staff", status: "revoked" })
  assert.equal(await control.authorizeMembership({ tenantId: tenant.id, actorId: "usr_staff" }), false)
  assert.equal(await control.authorizeMembership({ tenantId: tenant.id, actorId: "usr_members" }), true)
})

test("platform operators are separate from tenant ownership and runtime cannot self-provision an operator", async () => {
  assert.equal(await control.authorizePlatformAdmin("usr_alpha"), false)
  assert.equal(await control.authorizePlatformAdmin("usr_operator"), true)
  assert.equal(await control.authorizePlatformAdmin("usr_static_operator"), true)
  await assert.rejects(pool.query("INSERT INTO saas_control.platform_identity(actor_id) VALUES ($1)", ["usr_alpha"]), error => error.code === "42501")
  await assert.rejects(pool.query("UPDATE saas_control.platform_identity SET status='revoked'"), error => error.code === "42501")
  await assert.rejects(pool.query("SELECT * FROM saas_control.schema_migration"), error => error.code === "42501")
  await assert.rejects(pool.query("DELETE FROM saas_control.audit_event"), error => error.code === "42501")
})

test("platform provisioning records the actual operator and refuses delegated creation by ordinary tenant owners", async () => {
  const request = { ownerActorId: "usr_delegated", slug: "delegated", name: "Delegated" }
  await assert.rejects(control.openTenant({ ...request, actorId: "usr_alpha" }), error => error.code === "PLATFORM_ADMIN_REQUIRED")
  const tenant = await control.openTenant({ ...request, actorId: "usr_operator" })
  assert.equal(tenant.ownerActorId, "usr_delegated")
  assert.equal(await control.authorizeMembership({ tenantId: tenant.id, actorId: "usr_delegated" }), true)
  assert.equal(await control.authorizeMembership({ tenantId: tenant.id, actorId: "usr_operator" }), false)
  const events = (await admin.query("SELECT actor_id,action FROM saas_control.audit_event WHERE tenant_id=$1 ORDER BY id", [tenant.id])).rows
  assert.equal(events.length, 3)
  assert.equal(events.every(event => event.actor_id === "usr_operator"), true)
})

test("suspension stops host resolution and all memberships; only platform operators can resume initialized tenants", async () => {
  const tenant = await control.openTenant({ ownerActorId: "usr_suspend", slug: "suspend", name: "Suspend" })
  await assert.rejects(control.setTenantStatus({ tenantId: tenant.id, actorId: "usr_suspend", status: "suspended" }), error => error.code === "PLATFORM_ADMIN_REQUIRED")
  assert.equal((await control.setTenantStatus({ tenantId: tenant.id, actorId: "usr_operator", status: "suspended" })).status, "suspended")
  assert.equal(await control.resolveDomain("suspend.shops.example.test"), null)
  assert.equal(await control.authorizeMembership({ tenantId: tenant.id, actorId: "usr_suspend" }), false)
  assert.equal((await control.openTenant({ ownerActorId: "usr_suspend", slug: "suspend", name: "Suspend" })).status, "suspended")
  assert.equal((await control.setTenantStatus({ tenantId: tenant.id, actorId: "usr_static_operator", status: "active" })).status, "active")
  assert.equal(await control.authorizeMembership({ tenantId: tenant.id, actorId: "usr_suspend" }), true)
})

test("host aliases, arbitrary identity values, reserved slugs and invalid callbacks fail closed", async () => {
  assert.throws(() => createTenantControl(pool, { baseDomain: "*.example.test", initializeTenant: async () => {} }), error => error.code === "INVALID_CONTROL_HOST")
  assert.throws(() => createTenantControl(pool, { baseDomain: "shops.example.test" }), TypeError)
  for (const slug of ["api", "admin", "www", "a", "-alpha", "Alpha", "alpha-", "alpha.example"]) {
    await assert.rejects(control.openTenant({ ownerActorId: "usr_invalid", slug, name: "Invalid" }), error => error.code === "INVALID_CONTROL_INPUT")
  }
  await assert.rejects(control.authorizeMembership({ tenantId: "tenant_ok", actorId: "usr_fake\nactor" }), error => error.code === "INVALID_CONTROL_INPUT")
  await assert.rejects(control.openTenant({ ownerActorId: "usr_' OR 1=1", slug: "inject", name: "Injection" }), error => error.code === "INVALID_CONTROL_INPUT")
})

test("control queries neither set business tenant context nor bypass forced business RLS", async () => {
  await admin.query("CREATE TABLE public.control_rls_probe(tenant_id text NOT NULL, title text NOT NULL)")
  await admin.query("INSERT INTO public.control_rls_probe VALUES ('tenant_a','A'),('tenant_b','B')")
  await admin.query("ALTER TABLE public.control_rls_probe ENABLE ROW LEVEL SECURITY")
  await admin.query("ALTER TABLE public.control_rls_probe FORCE ROW LEVEL SECURITY")
  await admin.query(`CREATE POLICY tenant_isolation ON public.control_rls_probe
    USING (tenant_id=nullif(current_setting('app.tenant_id',true),''))
    WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),''))`)
  await admin.query(`GRANT SELECT ON public.control_rls_probe TO ${ROLE}`)
  const role = (await pool.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0]
  assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false)
  await control.authorizePlatformAdmin("usr_operator")
  assert.equal((await pool.query("SELECT * FROM public.control_rls_probe")).rowCount, 0)
  assert.equal((await pool.query("SELECT nullif(current_setting('app.tenant_id',true),'') AS tenant")).rows[0].tenant, null)
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.tenant_id',$1,true)", ["tenant_a"])
    assert.deepEqual((await client.query("SELECT title FROM public.control_rls_probe")).rows, [{ title: "A" }])
    await client.query("COMMIT")
    assert.equal((await client.query("SELECT * FROM public.control_rls_probe")).rowCount, 0)
  } finally { client.release() }
})
