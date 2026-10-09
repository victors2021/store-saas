"use strict"
const crypto = require("node:crypto"),
  fs = require("node:fs/promises"),
  path = require("node:path")
const { AsyncLocalStorage } = require("node:async_hooks")
const { tenantSQL } = require("./tenant-sql.cjs")
const { currentTenant, TenantSecurityError } = require("./tenant-context.cjs")
const fail = (code, message) => {
  throw new TenantSecurityError(code, message)
}
const key = (value) => {
  if (typeof value !== "string" || !value || value.length > 512)
    throw new TypeError("Invalid resource key")
  return value
}

function createTenantResources({ pool, objectRoot, fileSecret }) {
  if (typeof fileSecret !== "string" || Buffer.byteLength(fileSecret) < 32)
    throw new TypeError("File signing secret required")
  const owners = new WeakMap()
  const flowOwner = new AsyncLocalStorage()
  const owner = () => {
    const ctx = currentTenant()
    if (flowOwner.getStore()) return flowOwner.getStore()
    if (!owners.has(ctx)) owners.set(ctx, crypto.randomUUID())
    return owners.get(ctx)
  }
  const cache = {
    async retrieve(id) {
      return tenantSQL(
        pool,
        async (c) =>
          (
            await c.query(
              "SELECT value FROM saas_cache WHERE id=$1 AND expires_at>now()",
              [key(id)]
            )
          ).rows[0]?.value
      )
    },
    async set(id, value, ttl = 60) {
      if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 86400)
        throw new TypeError("Invalid cache TTL")
      await tenantSQL(pool, (c) =>
        c.query(
          "INSERT INTO saas_cache(id,value,expires_at) VALUES($1,$2,now()+$3*interval '1 second') ON CONFLICT(tenant_id,id) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at",
          [key(id), JSON.stringify(value), ttl]
        )
      )
    },
    async invalidate(id) {
      await tenantSQL(pool, (c) =>
        c.query("DELETE FROM saas_cache WHERE id=$1", [key(id)])
      )
    },
    async clear() {
      await tenantSQL(pool, (c) => c.query("DELETE FROM saas_cache"))
    },
  }
  const locking = {
    async acquire(ids, args = {}) {
      if (args.provider)
        fail(
          "LOCK_PROVIDER_DISABLED",
          "Only the tenant SQL lock provider is available"
        )
      const expiry = args.expire ?? 120
      if (!Number.isFinite(expiry) || expiry <= 0 || expiry > 3600)
        throw new TypeError("Invalid lock expiry")
      const holder = args.ownerId ?? owner()
      await tenantSQL(pool, async (c) => {
        for (const id of [
          ...new Set(Array.isArray(ids) ? ids : [ids]),
        ].sort()) {
          const r = await c.query(
            "INSERT INTO saas_lock(id,owner_id,expires_at) VALUES($1,$2,now()+$3*interval '1 second') ON CONFLICT(tenant_id,id) DO UPDATE SET owner_id=excluded.owner_id,expires_at=excluded.expires_at WHERE saas_lock.expires_at<=now() OR saas_lock.owner_id=excluded.owner_id RETURNING id",
            [key(id), holder, expiry]
          )
          if (!r.rowCount) fail("TENANT_LOCK_CONFLICT", "Resource is locked")
        }
      })
    },
    async release(ids, args = {}) {
      return tenantSQL(
        pool,
        async (c) =>
          (
            await c.query(
              "DELETE FROM saas_lock WHERE id=ANY($1::text[]) AND owner_id=$2 RETURNING id",
              [Array.isArray(ids) ? ids : [key(ids)], args.ownerId ?? owner()]
            )
          ).rowCount > 0
      )
    },
    async releaseAll(args = {}) {
      await tenantSQL(pool, (c) =>
        c.query("DELETE FROM saas_lock WHERE owner_id=$1", [
          args.ownerId ?? owner(),
        ])
      )
    },
    async execute(ids, task, args = {}) {
      await locking.acquire(ids, args)
      try {
        return await task()
      } finally {
        await locking.release(ids, args)
      }
    },
  }
  const file = {
    async upload({
      filename,
      mimeType = "application/octet-stream",
      content,
      isPublic = false,
    }) {
      key(filename)
      if (!Buffer.isBuffer(content) || content.length > 5 * 1024 * 1024)
        throw new TypeError("A buffer up to 5 MiB is required")
      if (typeof isPublic !== "boolean")
        throw new TypeError("Explicit visibility required")
      const id = "file_" + crypto.randomBytes(20).toString("hex"),
        tenant = currentTenant().tenantId
      const storageKey =
        crypto.createHash("sha256").update(tenant).digest("hex") + "/" + id
      const target = path.join(objectRoot, storageKey)
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      await fs.writeFile(target, content, { flag: "wx", mode: 0o600 })
      try {
        await tenantSQL(pool, (c) =>
          c.query(
            "INSERT INTO saas_file(id,storage_key,filename,mime_type,is_public) VALUES($1,$2,$3,$4,$5)",
            [id, storageKey, path.basename(filename), mimeType, isPublic]
          )
        )
      } catch (e) {
        await fs.unlink(target)
        throw e
      }
      return { id, filename: path.basename(filename), is_public: isPublic }
    },
    async retrieve(id, { publicOnly = false } = {}) {
      const row = await tenantSQL(
        pool,
        async (c) =>
          (
            await c.query("SELECT * FROM saas_file WHERE id=$1", [key(id)])
          ).rows[0]
      )
      if (!row || (publicOnly && !row.is_public))
        fail("TENANT_FILE_NOT_FOUND", "File is unavailable")
      if (!/^[a-f0-9]{64}\/file_[a-f0-9]{40}$/.test(row.storage_key))
        throw new Error("Invalid stored file key")
      return {
        id: row.id,
        filename: row.filename,
        mime_type: row.mime_type,
        content: await fs.readFile(path.join(objectRoot, row.storage_key)),
      }
    },
    sign(id, expiresIn = 60) {
      const tenant = currentTenant().tenantId
      return require("jsonwebtoken").sign(
        { file_id: key(id), tenant_id: tenant },
        fileSecret,
        {
          algorithm: "HS256",
          issuer: "medusa-saas-file",
          audience: "private-file",
          expiresIn,
        }
      )
    },
    async download(token) {
      let claims
      try {
        claims = require("jsonwebtoken").verify(token, fileSecret, {
          algorithms: ["HS256"],
          issuer: "medusa-saas-file",
          audience: "private-file",
        })
      } catch {
        fail("TENANT_FILE_TOKEN_INVALID", "Invalid file link")
      }
      if (claims.tenant_id !== currentTenant().tenantId)
        fail("TENANT_FILE_TOKEN_INVALID", "File link belongs to another store")
      return file.retrieve(claims.file_id)
    },
    async delete(id) {
      const row = await tenantSQL(
        pool,
        async (c) =>
          (
            await c.query(
              "DELETE FROM saas_file WHERE id=$1 RETURNING storage_key",
              [key(id)]
            )
          ).rows[0]
      )
      if (row) {
        if (!/^[a-f0-9]{64}\/file_[a-f0-9]{40}$/.test(row.storage_key))
          throw new Error("Invalid stored file key")
        await fs.unlink(path.join(objectRoot, row.storage_key))
      }
      return !!row
    },
  }
  return {
    cache,
    locking,
    file,
    runWithLockOwner: (id, task) => flowOwner.run(id, task),
  }
}
module.exports = { createTenantResources }
