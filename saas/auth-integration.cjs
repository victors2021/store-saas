"use strict"

// Explicit SaaS integration for the native emailpass provider. The provider and
// native JWT routes retain their normal behavior when this adapter is disabled.
const { AsyncLocalStorage } = require("node:async_hooks")
const { createHmac, timingSafeEqual } = require("node:crypto")
const { MedusaContextType } = require("@medusajs/framework/utils")
const { currentTenant, TenantSecurityError } = require("./tenant-context.cjs")

const authActors = new AsyncLocalStorage()
const installations = new WeakMap()
const actorTypes = new Set(["user", "customer"])

function fail(code, message) {
  throw new TenantSecurityError(code, message)
}

function assertActorType(actorType) {
  if (!actorTypes.has(actorType)) fail("TENANT_AUTH_ACTOR_INVALID", "Only native user/customer authentication is enabled")
}

function runWithAuthActor(actorType, task) {
  assertActorType(actorType)
  currentTenant()
  if (typeof task !== "function") throw new TypeError("An authentication task is required")
  const active = authActors.getStore()
  if (active && active !== actorType) fail("TENANT_AUTH_ACTOR_SWITCH_FORBIDDEN", "Cannot switch authentication actor in an active request")
  return authActors.run(actorType, task)
}

function rejectTenantInput(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return
  seen.add(value)
  for (const key of Object.keys(value)) {
    if (key === "tenant_id" || key === "tenantId") fail("TENANT_FIELD_FORBIDDEN", "Tenant identity comes from the verified server context")
    rejectTenantInput(value[key], seen)
  }
}

function normalizedEmail(email) {
  if (typeof email !== "string" || email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail("TENANT_AUTH_EMAIL_INVALID", "A valid email address is required")
  }
  return email.toLowerCase()
}

function scopeForAuth(authenticationData) {
  const tenant = currentTenant()
  const actorType = authActors.getStore()
  assertActorType(actorType)
  if (authenticationData?.actor_type != null && authenticationData.actor_type !== actorType) {
    fail("TENANT_AUTH_ACTOR_INVALID", "Authentication actor must match the server route")
  }
  rejectTenantInput(authenticationData?.body)
  return { tenantId: tenant.tenantId, actorType }
}

function assertIdentityScope(identity, scope, { allowUnbound = false } = {}) {
  if (!identity || typeof identity.id !== "string" || !identity.id) {
    fail("TENANT_AUTH_IDENTITY_INVALID", "A native auth identity is required")
  }
  const metadata = identity.app_metadata
  if (allowUnbound && (!metadata || Object.keys(metadata).length === 0)) return
  if (!metadata || metadata.tenant_id !== scope.tenantId || metadata.saas_actor_type !== scope.actorType) {
    fail("TENANT_AUTH_SCOPE_MISMATCH", "Authentication identity belongs to a different tenant or actor")
  }
  const otherActor = scope.actorType === "user" ? "customer" : "user"
  if (metadata[`${otherActor}_id`]) fail("TENANT_AUTH_SCOPE_MISMATCH", "Authentication identity cannot be shared by actor types")
}

// Trusted app_metadata contains tenant_id, so it intentionally does not go
// through the generic public DTO adapter, which rejects all tenant input. This
// write uses the auth module's own repository and transaction manager; caller
// managers and tenant values are never accepted.
async function writeIdentityMetadata(service, id, scope, transform, { allowUnbound = false } = {}) {
  const tenant = currentTenant()
  if (scope.tenantId !== tenant.tenantId) fail("TENANT_AUTH_SCOPE_MISMATCH", "Cannot write identity metadata for another tenant")
  return service.baseRepository_.transaction(async (manager) => {
    if (typeof manager?.execute !== "function" || !manager.getTransactionContext?.()) {
      fail("TENANT_TRANSACTION_REQUIRED", "A native SQL transaction is required")
    }
    await manager.execute("select set_config('app.tenant_id', ?, true)", [tenant.tenantId])
    const sharedContext = { manager, transactionManager: manager, __type: MedusaContextType }
    // Read and update inside the same transaction. Retrieval must fail under
    // RLS for a foreign identity instead of attaching a guessed foreign ID.
    await manager.execute('select id from auth_identity where id = ? for update', [id])
    const identity = await service.authIdentityService_.retrieve(id, {}, sharedContext)
    assertIdentityScope(identity, scope, { allowUnbound })
    const metadata = transform(identity.app_metadata ?? {})
    if (metadata.tenant_id !== tenant.tenantId || metadata.saas_actor_type !== scope.actorType) {
      fail("TENANT_AUTH_SCOPE_MISMATCH", "Identity binding must preserve its tenant and actor type")
    }
    await service.authIdentityService_.update({ id, app_metadata: metadata }, sharedContext)
    return metadata
  })
}

/**
 * Call AFTER wrapTenantModule(auth). Native register/authenticate are patched
 * with MedusaContext metadata so provider lookup/create and MFA lookup inherit
 * the same native SQL transaction. Only emailpass is enabled for M1.
 */
function installTenantScopedAuth(service, { namespaceSecret, enabled = process.env.MEDUSA_SAAS_MODE === "true" } = {}) {
  if (!enabled) return service
  if (!service || typeof service.register !== "function" || typeof service.authenticate !== "function" ||
      typeof service.baseRepository_?.transaction !== "function" || !service.authIdentityService_) {
    throw new TypeError("The native Auth module must be tenant-adapted first")
  }
  if (typeof namespaceSecret !== "string" || Buffer.byteLength(namespaceSecret) < 32) {
    throw new TypeError("A persistent identity namespace secret of at least 32 bytes is required")
  }
  const fingerprint = createHmac("sha256", namespaceSecret).update("medusa-saas-identity-namespace-v1").digest()
  const installed = installations.get(service)
  if (installed) {
    if (!timingSafeEqual(installed.fingerprint, fingerprint)) throw new Error("Identity namespace configuration cannot change after installation")
    return service
  }
  const namespaceEntity = (scope, email) => {
    const digest = createHmac("sha256", namespaceSecret)
      .update(JSON.stringify(["v1", scope.tenantId, scope.actorType, normalizedEmail(email)])).digest("hex")
    return `saas:v1:${digest}@identity.invalid`
  }
  for (const method of ["register", "authenticate"]) {
    const original = service[method]
    service[method] = async function tenantScopedEmailPass(provider, authenticationData, ...rest) {
      const scope = scopeForAuth(authenticationData)
      if (provider !== "emailpass") fail("TENANT_AUTH_PROVIDER_DISABLED", "Only native emailpass authentication is enabled")
      // HMAC avoids disclosing tenant/email in provider entity IDs. JSON array
      // encoding prevents separator collisions; include actor type so owner
      // and consumer accounts with the same email never share an identity.
      const input = {
        ...authenticationData,
        actor_type: scope.actorType,
        body: { ...authenticationData?.body, email: namespaceEntity(scope, authenticationData?.body?.email) },
      }
      const response = await Reflect.apply(original, service, [provider, input, ...rest])
      currentTenant()
      if (!response?.success) return response
      if (response.location || response.mfaChallenge) fail("TENANT_AUTH_FLOW_DISABLED", "OAuth/MFA flows require a later tenant-aware implementation")
      assertIdentityScope(response.authIdentity, scope, { allowUnbound: method === "register" })
      if (method === "register" && !response.authIdentity.app_metadata?.tenant_id) {
        const metadata = await writeIdentityMetadata(service, response.authIdentity.id, scope,
          existing => ({ ...existing, tenant_id: scope.tenantId, saas_actor_type: scope.actorType }), { allowUnbound: true })
        // Return the provider-sanitized identity. Never replace it with an
        // unsanitized ORM serialization that might contain a password hash.
        return { ...response, authIdentity: { ...response.authIdentity, app_metadata: metadata } }
      }
      return response
    }
  }
  installations.set(service, { fingerprint, namespaceEntity })
  return service
}

/** Internal actor attachment, called after a native actor is created. */
async function attachTenantActor(service, { authIdentityId, actorType, actorId, actorService }) {
  if (!installations.has(service)) throw new Error("SaaS authentication must be installed first")
  assertActorType(actorType)
  const tenant = currentTenant()
  if (typeof actorId !== "string" || !actorId || typeof authIdentityId !== "string" || !authIdentityId) {
    throw new TypeError("Native auth identity and actor IDs are required")
  }
  const retrieveActor = actorType === "user" ? "retrieveUser" : "retrieveCustomer"
  if (typeof actorService?.[retrieveActor] !== "function") throw new TypeError("A tenant-adapted native actor service is required")
  const actor = await actorService[retrieveActor](actorId)
  if (actor?.id !== actorId) fail("TENANT_AUTH_ACTOR_INVALID", "The actor is not visible in the current tenant")
  const identity = await service.retrieveAuthIdentity(authIdentityId, { relations: ["provider_identities"] })
  assertIdentityScope(identity, { tenantId: tenant.tenantId, actorType })
  const expectedEntity = installations.get(service).namespaceEntity({ tenantId: tenant.tenantId, actorType }, actor.email)
  if (!identity.provider_identities?.some(provider => provider.provider === "emailpass" && provider.entity_id === expectedEntity)) {
    fail("TENANT_AUTH_ACTOR_EMAIL_MISMATCH", "Native actor email must match its registered authentication identity")
  }
  const key = `${actorType}_id`
  if (identity.app_metadata[key] && identity.app_metadata[key] !== actorId) {
    fail("TENANT_AUTH_ACTOR_ALREADY_BOUND", "An auth identity cannot be rebound to another actor")
  }
  await writeIdentityMetadata(service, identity.id, { tenantId: tenant.tenantId, actorType }, existing => {
    if (existing[key] && existing[key] !== actorId) {
      fail("TENANT_AUTH_ACTOR_ALREADY_BOUND", "An auth identity cannot be rebound to another actor")
    }
    return { ...existing, [key]: actorId }
  })
  return { authIdentityId: identity.id, actorId, actorType, tenantId: tenant.tenantId }
}

module.exports = { installTenantScopedAuth, runWithAuthActor, attachTenantActor }
