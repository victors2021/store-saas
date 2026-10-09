"use strict"

// Server-only control-plane persistence. Callers MUST derive actor IDs from
// verified native Medusa authentication, never from request bodies or headers.
const { createHash, randomUUID } = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")

const MIGRATIONS = [{ version: "001-tenant-control", file: "001-tenant-control.sql" }]
const RESERVED_SLUGS = new Set(["admin", "api", "auth", "assets", "cdn", "mail", "platform", "static", "support", "www"])

class TenantControlError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "TenantControlError"
    this.code = code
  }
}

function fail(code, message) { throw new TenantControlError(code, message) }

function identity(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    fail("INVALID_CONTROL_INPUT", `Invalid ${label}`)
  }
  return value
}

function slugValue(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{1,46}[a-z0-9]$/.test(value) || RESERVED_SLUGS.has(value)) {
    fail("INVALID_CONTROL_INPUT", "Use a non-reserved platform subdomain of 3–48 lowercase letters, numbers or hyphens")
  }
  return value
}

function domainValue(value) {
  if (typeof value !== "string" || value.length > 253 || value !== value.trim()) {
    fail("INVALID_CONTROL_HOST", "Invalid platform domain")
  }
  const domain = value.toLowerCase()
  const labels = domain.split(".")
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      labels.every(label => /^\d+$/.test(label))) {
    fail("INVALID_CONTROL_HOST", "A DNS platform base domain is required")
  }
  return domain
}

/** A trusted HTTP Host value, not a URL, X-Forwarded-Host list or wildcard. */
function normalizeHost(value) {
  if (typeof value !== "string" || value.length > 260 || value !== value.trim() ||
      /[\s,/@\\?#\u0000-\u001f\u007f]/.test(value)) {
    fail("INVALID_CONTROL_HOST", "A single trusted Host is required")
  }
  const match = /^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(value)
  if (!match || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) {
    fail("INVALID_CONTROL_HOST", "Invalid trusted Host")
  }
  // DNS trailing dot denotes the same hostname. Reject repeated trailing dots.
  return domainValue(match[1].endsWith(".") ? match[1].slice(0, -1) : match[1])
}

function tenantRow(row) {
  if (!row) return null
  return Object.freeze({
    id: row.id, tenantId: row.id, slug: row.slug, name: row.name,
    ownerActorId: row.owner_actor_id, publicKey: row.public_key, status: row.status,
    initializationVersion: row.initialization_version,
    initializationAttempts: row.initialization_attempts,
    initializationErrorCode: row.initialization_error_code,
    createdAt: row.created_at, initializedAt: row.initialized_at,
  })
}

async function withTransaction(pool, task) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await task(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally { client.release() }
}

/** Versioned, checksum-checked installation. Use a migration/admin connection. */
async function installTenantControl(client, { applicationRole } = {}) {
  if (applicationRole !== undefined && !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(applicationRole)) {
    throw new TypeError("A valid PostgreSQL application role name is required")
  }
  await client.query("BEGIN")
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["medusa-saas-control-migrations-v1"])
    await client.query("CREATE SCHEMA IF NOT EXISTS saas_control")
    await client.query(`CREATE TABLE IF NOT EXISTS saas_control.schema_migration (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`)
    await client.query("REVOKE ALL ON SCHEMA saas_control FROM PUBLIC")
    const applied = []
    for (const migration of MIGRATIONS) {
      const sql = fs.readFileSync(path.join(__dirname, "migrations", migration.file), "utf8")
      const checksum = createHash("sha256").update(sql).digest("hex")
      const existing = (await client.query("SELECT checksum FROM saas_control.schema_migration WHERE version=$1", [migration.version])).rows[0]
      if (existing) {
        if (existing.checksum !== checksum) fail("CONTROL_MIGRATION_CHECKSUM", `Applied migration changed: ${migration.version}`)
        continue
      }
      await client.query(sql)
      await client.query("INSERT INTO saas_control.schema_migration (version, checksum) VALUES ($1,$2)", [migration.version, checksum])
      applied.push(migration.version)
    }
    if (applicationRole) {
      const role = (await client.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=$1", [applicationRole])).rows[0]
      if (!role || role.rolsuper || role.rolbypassrls) fail("CONTROL_UNSAFE_ROLE", "Application role must exist without superuser or RLS bypass")
      // Identifiers cannot be SQL parameters; validated above and quoted here.
      const quoted = `"${applicationRole}"`
      await client.query(`GRANT USAGE ON SCHEMA saas_control TO ${quoted}`)
      await client.query(`GRANT SELECT, INSERT, UPDATE ON saas_control.tenant, saas_control.membership, saas_control.domain TO ${quoted}`)
      await client.query(`GRANT SELECT ON saas_control.platform_identity TO ${quoted}`)
      await client.query(`GRANT INSERT ON saas_control.audit_event TO ${quoted}`)
      await client.query(`GRANT USAGE ON SEQUENCE saas_control.audit_event_id_seq TO ${quoted}`)
      await client.query(`REVOKE ALL ON saas_control.schema_migration FROM ${quoted}`)
    }
    await client.query("COMMIT")
    return { applied, versions: MIGRATIONS.map(item => item.version) }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  }
}

/**
 * initializeTenant receives { tenantId, slug, name, ownerActorId, version,
 * attempt }. It MUST be idempotent by tenantId + version: an expired lease can
 * replay initialization after process failure. Avoid irreversible operations.
 * Control state and native module commits are not one distributed transaction.
 */
function createTenantControl(pool, {
  baseDomain, initializeTenant, platformAdminActorIds = [], initializationLeaseMs = 60_000,
} = {}) {
  const domain = domainValue(baseDomain)
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function" || typeof initializeTenant !== "function") {
    throw new TypeError("A PostgreSQL pool and explicit idempotent initializeTenant callback are required")
  }
  if (!Array.isArray(platformAdminActorIds) || !Number.isSafeInteger(initializationLeaseMs) ||
      initializationLeaseMs < 100 || initializationLeaseMs > 3_600_000) {
    throw new TypeError("Valid server administrator allowlist and initialization lease are required")
  }
  const administrators = new Set(platformAdminActorIds.map(id => identity(id, "platform actor")))

  async function audit(client, { actorId, tenantId = null, action, details = {} }) {
    identity(actorId, "actor ID")
    if (tenantId !== null) identity(tenantId, "tenant ID")
    if (typeof action !== "string" || !/^[a-z][a-z0-9_.]{1,63}$/.test(action) ||
        !details || Object.getPrototypeOf(details) !== Object.prototype || JSON.stringify(details).length > 4096) {
      fail("INVALID_CONTROL_INPUT", "Invalid audit event")
    }
    await client.query(`INSERT INTO saas_control.audit_event (actor_id,tenant_id,action,details)
      VALUES ($1,$2,$3,$4::jsonb)`, [actorId, tenantId, action, JSON.stringify(details)])
  }

  async function isPlatformAdmin(client, actorId) {
    identity(actorId, "actor ID")
    if (administrators.has(actorId)) return true
    return (await client.query(`SELECT 1 FROM saas_control.platform_identity
      WHERE actor_id=$1 AND status='active'`, [actorId])).rowCount > 0
  }

  async function authorizePlatformAdmin(actorId) {
    return isPlatformAdmin(pool, actorId)
  }

  async function authorizeMembership(input, secondActorId) {
    const tenantId = typeof input === "object" && input ? input.tenantId : input
    const actorId = typeof input === "object" && input ? input.actorId : secondActorId
    identity(tenantId, "tenant ID"); identity(actorId, "actor ID")
    return (await pool.query(`SELECT 1 FROM saas_control.membership m
      JOIN saas_control.tenant t ON t.id=m.tenant_id
      WHERE m.tenant_id=$1 AND m.actor_id=$2 AND m.status='active' AND
        (t.status='active' OR ($3::boolean AND t.status='suspended'))`, [tenantId, actorId, input?.allowSuspended === true])).rowCount > 0
  }

  async function getTenant(tenantId) {
    identity(tenantId, "tenant ID")
    return tenantRow((await pool.query("SELECT * FROM saas_control.tenant WHERE id=$1", [tenantId])).rows[0])
  }

  async function resolveDomain(trustedHost, { allowSuspended = false } = {}) {
    const hostname = normalizeHost(trustedHost)
    const suffix = `.${domain}`
    if (!hostname.endsWith(suffix)) return null
    const slug = hostname.slice(0, -suffix.length)
    if (slug.includes(".") || !/^[a-z][a-z0-9-]{1,46}[a-z0-9]$/.test(slug) || RESERVED_SLUGS.has(slug)) return null
    const row = (await pool.query(`SELECT t.* FROM saas_control.domain d
      JOIN saas_control.tenant t ON t.id=d.tenant_id
      WHERE d.hostname=$1 AND d.kind='platform_subdomain' AND
        (t.status='active' OR ($2::boolean AND t.status='suspended'))`, [hostname, allowSuspended])).rows[0]
    const tenant = tenantRow(row)
    return tenant ? Object.freeze({ ...tenant, hostname }) : null
  }

  async function openTenant({ ownerActorId, actorId = ownerActorId, slug, name, idempotencyKey, initializationFingerprint } = {}) {
    identity(ownerActorId, "owner actor ID"); slugValue(slug)
    identity(actorId, "initiating actor ID")
    if (actorId !== ownerActorId && !(await authorizePlatformAdmin(actorId))) {
      fail("PLATFORM_ADMIN_REQUIRED", "Only a platform administrator may provision a shop for another owner")
    }
    // Server-generated HMAC of extra initializer inputs, such as native owner
    // credentials. Never pass or persist passwords/provider secrets here.
    if (initializationFingerprint !== undefined &&
        (typeof initializationFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(initializationFingerprint))) {
      fail("INVALID_CONTROL_INPUT", "Initialization fingerprint must be a server-generated SHA-256 HMAC digest")
    }
    if (typeof name !== "string" || !name.trim() || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
      fail("INVALID_CONTROL_INPUT", "A shop name of 1–120 printable characters is required")
    }
    name = name.trim().normalize("NFC")
    // The default key permits reattempting the same owner/slug after failure.
    const requestKey = identity(idempotencyKey ?? `shop_${slug}`, "idempotency key")
    const hostname = `${slug}.${domain}`
    if (hostname.length > 253) fail("INVALID_CONTROL_HOST", "Platform hostname is too long")
    const fingerprint = createHash("sha256").update(JSON.stringify({ ownerActorId, slug, name, hostname,
      initializationFingerprint: initializationFingerprint ?? null, version: 1 })).digest("hex")
    const claimed = await withTransaction(pool, async client => {
      // Ordered transaction advisory locks serialize request-key and domain
      // reservations. Different owner keys for the same slug cannot race.
      for (const key of [`request:${ownerActorId}:${requestKey}`, `domain:${hostname}`].sort()) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`medusa-saas-open:${key}`])
      }
      let row = (await client.query(`SELECT * FROM saas_control.tenant
        WHERE (owner_actor_id=$1 AND request_key=$2) OR slug=$3 FOR UPDATE`, [ownerActorId, requestKey, slug])).rows[0]
      if (row && (row.owner_actor_id !== ownerActorId || row.slug !== slug || row.request_key !== requestKey || row.input_fingerprint !== fingerprint)) {
        fail("TENANT_OPEN_CONFLICT", "Tenant domain or idempotency key is already reserved with different input")
      }
      if (!row) {
        row = (await client.query(`INSERT INTO saas_control.tenant
          (id,slug,name,owner_actor_id,public_key,request_key,input_fingerprint)
          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [`tenant_${randomUUID().replaceAll("-", "")}`, slug, name, ownerActorId,
            `pk_${randomUUID().replaceAll("-", "")}`, requestKey, fingerprint])).rows[0]
        await client.query(`INSERT INTO saas_control.membership (tenant_id,actor_id,role)
          VALUES ($1,$2,'owner')`, [row.id, ownerActorId])
        await client.query("INSERT INTO saas_control.domain (hostname,tenant_id) VALUES ($1,$2)", [hostname, row.id])
        await audit(client, { actorId, tenantId: row.id, action: "tenant.created", details: { slug, ownerActorId } })
      }
      if (row.status === "active" || row.status === "suspended") return { tenant: tenantRow(row), shouldInitialize: false }
      // Use the database clock, not differing wall clocks on application nodes.
      const token = randomUUID()
      const attempt = (await client.query(`UPDATE saas_control.tenant SET
        status='pending', initialization_attempts=initialization_attempts+1,
        initialization_token=$2, initialization_lease_until=now()+($3::integer*interval '1 millisecond'),
        initialization_error_code=NULL, updated_at=now()
        WHERE id=$1 AND (initialization_lease_until IS NULL OR initialization_lease_until<=now()) RETURNING *`,
        [row.id, token, initializationLeaseMs])).rows[0]
      if (!attempt) return { tenant: tenantRow(row), shouldInitialize: false }
      await audit(client, { actorId, tenantId: row.id, action: "tenant.initialization_started", details: { attempt: attempt.initialization_attempts } })
      return { tenant: tenantRow(attempt), token, shouldInitialize: true }
    })
    if (!claimed.shouldInitialize) return claimed.tenant
    const tenant = claimed.tenant
    try {
      await initializeTenant(Object.freeze({
        tenantId: tenant.id, slug: tenant.slug, name: tenant.name, ownerActorId: tenant.ownerActorId,
        version: tenant.initializationVersion, attempt: tenant.initializationAttempts,
      }))
      return await withTransaction(pool, async client => {
        const row = (await client.query(`UPDATE saas_control.tenant SET status='active',
          initialized_at=now(), initialization_token=NULL, initialization_lease_until=NULL,
          initialization_error_code=NULL, updated_at=now()
          WHERE id=$1 AND initialization_token=$2 AND status='pending' RETURNING *`, [tenant.id, claimed.token])).rows[0]
        if (!row) return tenantRow((await client.query("SELECT * FROM saas_control.tenant WHERE id=$1", [tenant.id])).rows[0])
        await audit(client, { actorId, tenantId: tenant.id, action: "tenant.initialized", details: { attempt: row.initialization_attempts } })
        return tenantRow(row)
      })
    } catch (error) {
      // Persist a safe classification only; provider errors may contain secrets.
      await withTransaction(pool, async client => {
        const result = await client.query(`UPDATE saas_control.tenant SET status='failed',
          initialization_token=NULL, initialization_lease_until=NULL,
          initialization_error_code='INITIALIZATION_FAILED', updated_at=now()
          WHERE id=$1 AND initialization_token=$2 AND status='pending'`, [tenant.id, claimed.token])
        if (result.rowCount) await audit(client, { actorId, tenantId: tenant.id, action: "tenant.initialization_failed", details: { attempt: tenant.initializationAttempts } })
      })
      fail("TENANT_INITIALIZATION_FAILED", "Shop initialization failed; retry the identical opening request")
    }
  }

  async function requireTenantManager(client, tenantId, actorId) {
    const owner = (await client.query(`SELECT t.id FROM saas_control.tenant t
      JOIN saas_control.membership m ON m.tenant_id=t.id
      WHERE t.id=$1 AND t.status='active' AND t.owner_actor_id=$2
        AND m.actor_id=$2 AND m.role='owner' AND m.status='active' FOR UPDATE OF t`, [tenantId, actorId])).rowCount > 0
    if (!owner && !(await isPlatformAdmin(client, actorId))) fail("TENANT_OWNER_REQUIRED", "An active shop owner or platform administrator is required")
    if (!owner && !(await client.query("SELECT id FROM saas_control.tenant WHERE id=$1 FOR UPDATE", [tenantId])).rowCount) {
      fail("TENANT_NOT_FOUND", "Shop does not exist")
    }
  }

  async function setMembership({ tenantId, actorId, memberActorId, status = "active" } = {}) {
    identity(tenantId, "tenant ID"); identity(actorId, "actor ID"); identity(memberActorId, "member actor ID")
    if (!["active", "revoked"].includes(status)) fail("INVALID_CONTROL_INPUT", "Invalid membership status")
    return withTransaction(pool, async client => {
      await requireTenantManager(client, tenantId, actorId)
      const tenant = (await client.query("SELECT owner_actor_id FROM saas_control.tenant WHERE id=$1", [tenantId])).rows[0]
      if (tenant.owner_actor_id === memberActorId) fail("TENANT_OWNER_IMMUTABLE", "Owner membership cannot be changed")
      const row = (await client.query(`INSERT INTO saas_control.membership (tenant_id,actor_id,role,status)
        VALUES ($1,$2,'member',$3) ON CONFLICT (tenant_id,actor_id) DO UPDATE SET
        status=excluded.status, updated_at=now() RETURNING *`, [tenantId, memberActorId, status])).rows[0]
      await audit(client, { actorId, tenantId, action: "membership.changed", details: { memberActorId, status } })
      return Object.freeze({ tenantId, actorId: row.actor_id, role: row.role, status: row.status })
    })
  }

  async function setTenantStatus({ tenantId, actorId, status } = {}) {
    identity(tenantId, "tenant ID"); identity(actorId, "actor ID")
    if (!["active", "suspended"].includes(status)) fail("INVALID_CONTROL_INPUT", "Only active/suspended platform transitions are supported")
    if (!(await authorizePlatformAdmin(actorId))) fail("PLATFORM_ADMIN_REQUIRED", "Platform administrator authorization is required")
    return withTransaction(pool, async client => {
      const row = (await client.query(`UPDATE saas_control.tenant SET status=$2,updated_at=now()
        WHERE id=$1 AND initialized_at IS NOT NULL AND status IN ('active','suspended') RETURNING *`, [tenantId, status])).rows[0]
      if (!row) fail("TENANT_NOT_INITIALIZED", "Only initialized shops can be activated or suspended")
      await audit(client, { actorId, tenantId, action: "tenant.status_changed", details: { status } })
      return tenantRow(row)
    })
  }

  return Object.freeze({
    baseDomain: domain, openTenant, getTenant, resolveDomain, authorizeMembership,
    authorizePlatformAdmin, setMembership, setTenantStatus,
  })
}

module.exports = { installTenantControl, createTenantControl, normalizeHost, TenantControlError }
