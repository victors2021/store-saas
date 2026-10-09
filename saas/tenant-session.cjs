"use strict"
const session = require("express-session"),
  crypto = require("node:crypto")
const { AsyncLocalStorage } = require("node:async_hooks")
const { normalizeHost } = require("./tenant-control.cjs")
const hosts = new AsyncLocalStorage()
function createTenantSessionStore({ pool, secret }) {
  const encryption = crypto.createHash("sha256").update(secret).digest()
  const id = (sid) =>
    crypto
      .createHmac("sha256", secret)
      .update(JSON.stringify([hosts.getStore(), sid]))
      .digest("hex")
  const encrypt = (value) => {
    const iv = crypto.randomBytes(12),
      c = crypto.createCipheriv("aes-256-gcm", encryption, iv)
    return Buffer.concat([
      iv,
      c.update(JSON.stringify(value)),
      c.final(),
      c.getAuthTag(),
    ]).toString("base64")
  }
  const decrypt = (value) => {
    const b = Buffer.from(value, "base64"),
      d = crypto.createDecipheriv("aes-256-gcm", encryption, b.subarray(0, 12))
    d.setAuthTag(b.subarray(-16))
    return JSON.parse(
      Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString()
    )
  }
  class Store extends session.Store {
    get(sid, cb) {
      pool
        .query(
          "SELECT ciphertext FROM saas_control.http_session WHERE id=$1 AND expires_at>now()",
          [id(sid)]
        )
        .then((r) => cb(null, r.rows[0] ? decrypt(r.rows[0].ciphertext) : null))
        .catch(cb)
    }
    set(sid, value, cb = () => {}) {
      const expires = value.cookie?.expires
        ? new Date(value.cookie.expires)
        : new Date(Date.now() + 3600000)
      pool
        .query(
          "INSERT INTO saas_control.http_session(id,ciphertext,expires_at) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext,expires_at=excluded.expires_at",
          [id(sid), encrypt(value), expires]
        )
        .then(() => cb())
        .catch(cb)
    }
    destroy(sid, cb = () => {}) {
      pool
        .query("DELETE FROM saas_control.http_session WHERE id=$1", [id(sid)])
        .then(() => cb())
        .catch(cb)
    }
    touch(sid, value, cb = () => {}) {
      this.set(sid, value, cb)
    }
  }
  return {
    store: new Store(),
    middleware: (req, res, next) => {
      try {
        const host = req.path === "/health" || req.path.startsWith("/platform/")
          ? `control:${String(req.headers.host).toLowerCase()}`
          : normalizeHost(req.headers.host)
        return hosts.run(host, next)
      } catch (error) {
        return next(error)
      }
    },
  }
}
module.exports = { createTenantSessionStore }
