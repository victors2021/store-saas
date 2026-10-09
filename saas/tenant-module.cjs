"use strict"

// In-place adapters preserve the instances already held by Query and Workflow.
// These adapters protect methods with native MedusaContext metadata; pure
// normalization helpers and startup metadata retain their original behavior.
// Never derive an HTTP allowlist from an adapted object's JavaScript methods.
// SQL RLS and composite FKs remain required; this is not a JavaScript sandbox.
const { AsyncLocalStorage } = require("node:async_hooks")
const {
  MedusaContext,
  MedusaContextType,
} = require("@medusajs/framework/utils")
const { currentTenant, TenantSecurityError } = require("./tenant-context.cjs")

const transactions = new AsyncLocalStorage()
const wrappedModules = new WeakMap()
const metadataMethods = new Set(["__joinerConfig"])

function fail(code, message) {
  throw new TenantSecurityError(code, message)
}

function rejectTenantFields(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return
  seen.add(value)
  for (const key of Object.keys(value)) {
    if (key === "tenant_id" || key === "tenantId") {
      fail(
        "TENANT_FIELD_FORBIDDEN",
        "tenant_id is managed by the verified session"
      )
    }
    rejectTenantFields(value[key], seen)
  }
}

// Native `*` projections can expose an ownership column to the next step.
// Keep it in SQL, and preserve Auth's server-bound metadata used by native JWTs.
function stripOwnershipColumns(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value
  if (
    !Array.isArray(value) &&
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return value
  seen.add(value)
  if (Object.hasOwn(value, "tenant_id")) delete value.tenant_id
  for (const [name, item] of Object.entries(value)) {
    if (name !== "app_metadata" && name !== "metadata")
      stripOwnershipColumns(item, seen)
  }
  return value
}

function publicMethods(service) {
  const found = new Map()
  for (
    let target = service;
    target && target !== Object.prototype;
    target = Object.getPrototypeOf(target)
  ) {
    for (const method of Object.getOwnPropertyNames(target)) {
      if (
        found.has(method) ||
        method === "constructor" ||
        metadataMethods.has(method) ||
        method.startsWith("_") ||
        method.endsWith("_")
      )
        continue
      const descriptor = Object.getOwnPropertyDescriptor(target, method)
      if (typeof descriptor.value === "function")
        found.set(method, descriptor.value)
    }
  }
  return found
}

/**
 * Returns the same service. Context-aware methods use the service's own repository
 * transaction, not a caller-supplied manager. Repeated wrapping is idempotent.
 * Native MedusaContext parameter metadata determines the sharedContext index.
 */
function wrapTenantModule(
  service,
  { name = service?.constructor?.name || "module" } = {}
) {
  if (
    !service ||
    typeof service !== "object" ||
    typeof service.baseRepository_?.transaction !== "function"
  ) {
    throw new TypeError(
      "A native module with baseRepository_.transaction is required"
    )
  }
  if (wrappedModules.has(service)) return service

  const methods = publicMethods(service)
  for (const [method, original] of methods) {
    const contextIndex = MedusaContext.getIndex(service, method)
    // TypeScript protected helpers remain enumerable prototype methods at
    // runtime. Only the explicit native context metadata marks an adaptable
    // service entry; treating every method as an entry breaks normalization.
    if (!Number.isInteger(contextIndex) || contextIndex < 0) continue
    Object.defineProperty(service, method, {
      configurable: true,
      writable: true,
      value: async function tenantModuleMethod(...args) {
        const identity = currentTenant()
        args.forEach((arg, index) => {
          if (index !== contextIndex) rejectTenantFields(arg)
        })
        const inputContext = args[contextIndex] ?? {}
        if (typeof inputContext !== "object" || Array.isArray(inputContext)) {
          throw new TypeError("sharedContext must be an object")
        }
        if (
          Object.hasOwn(inputContext, "tenant_id") ||
          Object.hasOwn(inputContext, "tenantId")
        ) {
          fail(
            "TENANT_FIELD_FORBIDDEN",
            "Use the verified session for the tenant context"
          )
        }
        const activeTransactions = transactions.getStore()
        const active = activeTransactions?.get(service)
        if (
          active &&
          (active.tenantId !== identity.tenantId ||
            active.actorId !== identity.actorId)
        ) {
          fail(
            "TENANT_CONTEXT_SWITCH_FORBIDDEN",
            "A module transaction cannot change tenant or actor"
          )
        }
        for (const key of ["manager", "transactionManager"]) {
          if (
            inputContext[key] != null &&
            (!active || inputContext[key] !== active.manager)
          ) {
            fail(
              "TENANT_MANAGER_FORBIDDEN",
              "Caller-supplied managers are not accepted"
            )
          }
        }

        const invoke = async (manager) => {
          const sharedContext = { ...inputContext }
          sharedContext.manager = manager
          sharedContext.transactionManager = manager
          sharedContext.__type = MedusaContextType
          args[contextIndex] = sharedContext
          return stripOwnershipColumns(
            await Reflect.apply(original, service, args)
          )
        }
        if (active) return invoke(active.manager)

        return service.baseRepository_.transaction(async (manager) => {
          if (
            typeof manager?.execute !== "function" ||
            typeof manager?.getTransactionContext !== "function" ||
            !manager.getTransactionContext()
          ) {
            fail(
              "TENANT_TRANSACTION_REQUIRED",
              "A native SQL transaction manager is required"
            )
          }
          // SqlEntityManager.execute uses its transaction context. Never issue
          // session-level SET or a query through an unbound pool connection.
          await manager.execute("select set_config('app.tenant_id', ?, true)", [
            identity.tenantId,
          ])
          const scoped = new Map(activeTransactions ?? [])
          scoped.set(service, {
            manager,
            tenantId: identity.tenantId,
            actorId: identity.actorId,
          })
          return transactions.run(scoped, () => invoke(manager))
        })
      },
    })
  }
  wrappedModules.set(service, { name })
  return service
}

module.exports = { wrapTenantModule }
