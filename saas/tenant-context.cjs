"use strict"

// Native ORM pilot only. HTTP routing and durable worker context are separate work.
const { AsyncLocalStorage } = require("node:async_hooks")
const jwt = require("jsonwebtoken")

const tenants = new AsyncLocalStorage()
const verifiedContexts = new WeakSet()

class TenantSecurityError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "TenantSecurityError"
    this.code = code
  }
}

function fail(code, message) {
  throw new TenantSecurityError(code, message)
}

function isIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}

/**
 * Returns async verifyTenant(jwtToken). lookupMembership receives
 * { tenantId, actorId }; only an explicit true authorizes the session.
 * A returned context is opaque: copying its fields does not create authority.
 */
function createTenantVerifier({ secret, issuer, audience, lookupMembership }) {
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) {
    throw new TypeError("A tenant signing secret of at least 32 bytes is required")
  }
  if (!isIdentity(issuer) || !isIdentity(audience) || typeof lookupMembership !== "function") {
    throw new TypeError("issuer, audience and lookupMembership are required")
  }

  return async function verifyTenant(token) {
    let claims
    try {
      claims = jwt.verify(token, secret, { algorithms: ["HS256"], issuer, audience })
    } catch {
      fail("TENANT_AUTHENTICATION_FAILED", "Invalid or expired tenant session")
    }
    if (!claims || typeof claims !== "object" || !isIdentity(claims.sub) ||
        !isIdentity(claims.tenant_id) || !Number.isSafeInteger(claims.exp)) {
      fail("TENANT_AUTHENTICATION_FAILED", "Tenant session requires subject, tenant_id and expiration")
    }

    const identity = Object.freeze({ tenantId: claims.tenant_id, actorId: claims.sub })
    if (await lookupMembership(identity) !== true) {
      fail("TENANT_MEMBERSHIP_REQUIRED", "An active tenant membership is required")
    }
    // Recheck expiration after the asynchronous authority lookup.
    if (claims.exp * 1000 <= Date.now()) {
      fail("TENANT_AUTHENTICATION_FAILED", "Tenant session expired during verification")
    }
    const context = Object.freeze({ ...identity, expiresAt: claims.exp * 1000 })
    verifiedContexts.add(context)
    return context
  }
}

function validateContext(context) {
  if (!context || !verifiedContexts.has(context)) {
    fail("TENANT_CONTEXT_UNVERIFIED", "Use a verified tenant session")
  }
  if (context.expiresAt <= Date.now()) {
    fail("TENANT_AUTHENTICATION_FAILED", "Tenant session has expired")
  }
}

function runWithTenant(context, task) {
  validateContext(context)
  if (typeof task !== "function") throw new TypeError("A task function is required")
  const active = tenants.getStore()
  if (active && (active.tenantId !== context.tenantId || active.actorId !== context.actorId)) {
    fail("TENANT_CONTEXT_SWITCH_FORBIDDEN", "Cannot switch tenant or actor inside an active tenant task")
  }
  return tenants.run(context, task)
}

function currentTenant() {
  const context = tenants.getStore()
  if (!context) fail("TENANT_CONTEXT_REQUIRED", "A verified tenant context is required")
  validateContext(context)
  return context
}

module.exports = { createTenantVerifier, runWithTenant, currentTenant, TenantSecurityError }
