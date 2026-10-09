"use strict"
const crypto = require("node:crypto"),
  path = require("node:path")
const { currentTenant, TenantSecurityError } = require("./tenant-context.cjs")
const { tenantSQL } = require("./tenant-sql.cjs")
const { createTenantJobs } = require("./tenant-jobs.cjs")
const { createTenantResources } = require("./tenant-resources.cjs")
const { mountM2Routes, routes, allowedFields } = require("./m2-routes.cjs")
const fail = (code, message) => {
  throw new TenantSecurityError(code, message)
}

function installM2Runtime({
  nativeApp,
  pool,
  contextSecret,
  objectRoot,
  getControl,
  getOperations = () => undefined,
}) {
  const { asValue } = require("@medusajs/framework/awilix")
  const { DefaultsUtils, Modules } = require("@medusajs/framework/utils")
  const resources = createTenantResources({
    pool,
    objectRoot: objectRoot || path.resolve(__dirname, "../../object-store"),
    fileSecret: contextSecret,
    getOperations,
  })
  const handlers = new Map(),
    subscribers = new Map()
  const jobs = createTenantJobs({
    pool,
    secret: contextSecret,
    handlers,
    getOperations,
    resolveHandler:(kind,payload)=>{
      // Native modules emit some event names that are not exported in Utils.
      // A persisted no-subscriber event still needs the same no-op delivery
      // after restart. Never fall back for workflow, cart or payment commands.
      if(!/^event:[A-Za-z][A-Za-z0-9._-]{1,127}$/.test(kind)||!payload||Object.keys(payload).join()!=="data")return undefined
      return async()=>{
        const listeners=subscribers.get(kind.slice(6))||new Set()
        for(const fn of listeners)await fn({name:kind.slice(6),data:payload.data})
        return {delivered:listeners.size}
      }
    },
    lookupMembership: async ({ tenantId, actorId }, { kind } = {}) => {
      const control = getControl(),
        tenant = await control.getTenant(tenantId)
      if (["pending", "failed"].includes(tenant?.status)) {
        const e = new Error("Tenant initialization is incomplete")
        e.code = "TENANT_INITIALIZING"
        throw e
      }
      const paused = !!getOperations() && tenant?.status === "suspended"
      if(paused && kind!=="m4.stripe.event" && !kind?.startsWith("event:")) {
        const e = new Error("Shop job waits until resumption"); e.code="TENANT_PAUSED_JOB";throw e
      }
      if (tenant?.status !== "active" && !paused) return false
      if (
        actorId === "public" ||
        (await control.authorizeMembership({ tenantId, actorId, allowSuspended: paused }))
      )
        return true
      const c = await pool.connect()
      try {
        await c.query("BEGIN")
        await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId])
        const yes =
          (
            await c.query(
              "SELECT 1 FROM customer WHERE id=$1 AND deleted_at IS NULL",
              [actorId]
            )
          ).rowCount > 0
        await c.query("COMMIT")
        return yes
      } catch (e) {
        await c.query("ROLLBACK")
        throw e
      } finally {
        c.release()
      }
    },
  })
  nativeApp.sharedContainer.register({
    [Modules.LOCKING]: asValue(resources.locking),
    [Modules.CACHE]: asValue(resources.cache),
  })
  const event = nativeApp.modules.event_bus
  for (const [key, values] of Object.entries(
    require("@medusajs/framework/utils")
  )) {
    if (key.endsWith("Events") && values && typeof values === "object")
      for (const name of Object.values(values))
        if (typeof name === "string")
          handlers.set(`event:${name}`, async () => ({ delivered: 0 }))
  }
  event.subscribe = (name, handler) => {
    if (typeof handler !== "function") throw new TypeError("Handler required")
    const set = subscribers.get(name) || new Set()
    set.add(handler)
    subscribers.set(name, set)
    handlers.set(`event:${name}`, async (payload) => {
      for (const fn of subscribers.get(name) || [])
        await fn({ name, data: payload.data })
      return { delivered: set.size }
    })
  }
  event.unsubscribe = (name, handler) => subscribers.get(name)?.delete(handler)
  event.emit = async (events, options = {}) => {
    currentTenant()
    const list = Array.isArray(events) ? events : [events]
    const ids = []
    for (const item of list) {
      if (typeof item.name !== "string")
        throw new TypeError("Event name required")
      // Even events without subscribers are durable records with verified origin.
      if (!handlers.has(`event:${item.name}`))
        handlers.set(`event:${item.name}`, async () => ({ delivered: 0 }))
      const group =
        options.eventGroupId ??
        item.metadata?.eventGroupId ??
        item.options?.eventGroupId
      const job = await jobs.enqueue(
        `event:${item.name}`,
        { data: item.data },
        {
          idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(),
          blocked: !!group,
          groupId: group ?? null,
          delay: options.delay ?? 0,
        }
      )
      ids.push(job.id)
    }
    return ids
  }
  event.releaseGroupedEvents = (group) => jobs.releaseGroup(group)
  event.clearGroupedEvents = (group) => jobs.cancelGroup(group)
  const engine = nativeApp.modules.workflows
  const orchestrator = engine.workflowOrchestratorService_
  const storage = orchestrator.inMemoryDistributedTransactionStorage_
  // Scope both the native checkpoint repository and its in-process optimization.
  const internal = storage.workflowExecutionService_
  for (const [method, index] of [
    ["list", 2],
    ["upsert", 1],
    ["delete", 1],
  ]) {
    const original = internal[method].bind(internal)
    internal[method] = async (...args) => {
      const identity = currentTenant()
      return engine.baseRepository_.transaction(async (manager) => {
        await manager.execute("SELECT set_config('app.tenant_id',?,true)", [
          identity.tenantId,
        ])
        args[index] = { manager, transactionManager: manager }
        if (method === "upsert")
          args[0] = args[0].map((row) => ({
            ...row,
            tenant_id: identity.tenantId,
          }))
        return original(...args)
      })
    }
  }
  const memory = storage.storage
  const scopedKey = (key) => JSON.stringify([currentTenant().tenantId, key])
  storage.storage = new Proxy(memory, {
    get: (target, key) =>
      typeof key === "string" ? target[scopedKey(key)] : target[key],
    set: (target, key, value) => {
      target[scopedKey(key)] = value
      return true
    },
    deleteProperty: (target, key) => delete target[scopedKey(key)],
  })
  for (const name of ["get", "save", "clearExpiredExecutions"]) {
    const original = storage[name].bind(storage)
    storage[name] = (...args) => {
      currentTenant()
      return original(...args)
    }
  }
  // Cleanup is explicitly per tenant; do not start a context-free interval.
  storage.onApplicationStart = async () => {}
  const prefix = () =>
    "t" +
    crypto
      .createHmac("sha256", contextSecret)
      .update(currentTenant().tenantId)
      .digest("hex")
      .slice(0, 24) +
    "-"
  const txId = (value) =>
    value.startsWith(prefix()) ? value : prefix() + value
  const run = engine.run.bind(engine)
  engine.run = (flow, options = {}, context) => {
    currentTenant()
    const transactionId = txId(
      options.transactionId || "auto-" + crypto.randomUUID()
    )
    return resources.runWithLockOwner(transactionId, () =>
      run(flow, { ...options, transactionId }, context)
    )
  }
  for (const name of ["subscribe", "unsubscribe"]) {
    engine[name] = () =>
      fail(
        "M2_WORKFLOW_SUBSCRIPTION_DISABLED",
        "Workflow subscriptions are not open in M2"
      )
  }
  handlers.set("native.resume", async (payload) => {
    const result = await engine.run(payload.workflowId, {
      transactionId: payload.transactionId,
      throwOnError: false,
      context: payload.metadata ?? {},
    })
    if (
      result.transaction.hasFinished() &&
      result.transaction.getFlow().state !== "done" &&
      result.errors?.length
    )
      throw result.errors[0].error
    return { finished: result.transaction.hasFinished() }
  })
  const timers = new Map()
  const retryKey = (t, step) =>
    JSON.stringify([
      currentTenant().tenantId,
      t.modelId,
      t.transactionId,
      step?.id,
    ])
  const schedule = async (t, step, timestamp, interval) => {
    const key = retryKey(t, step)
    const j = await jobs.enqueue(
      "native.resume",
      {
        workflowId: t.modelId,
        transactionId: t.transactionId,
        metadata: t.getFlow().metadata ?? {},
      },
      {
        idempotencyKey: crypto
          .createHash("sha256")
          .update(key + ":" + timestamp)
          .digest("hex"),
        delay: interval,
      }
    )
    timers.set(key, j.id)
  }
  const clear = async (t, step) => {
    const key = retryKey(t, step),
      id = timers.get(key)
    if (id) await jobs.cancel([id])
    timers.delete(key)
  }
  storage.scheduleRetry = schedule
  storage.clearRetry = clear
  storage.scheduleStepTimeout = schedule
  storage.clearStepTimeout = clear
  storage.scheduleTransactionTimeout = (t, timestamp, interval) =>
    schedule(t, undefined, timestamp, interval)
  storage.clearTransactionTimeout = (t) => clear(t, undefined)
  storage.schedule = () =>
    fail(
      "M2_SCHEDULE_DEFINITION_DISABLED",
      "Recurring workflow definitions need an explicit per-tenant registration"
    )
  storage.remove = () =>
    fail(
      "M2_SCHEDULE_DEFINITION_DISABLED",
      "Recurring workflow definitions are unavailable"
    )
  storage.removeAll = storage.remove
  return {
    resources,
    jobs,
    routes,
    allowedFields,
    storage,
    async initializeTenant(tenant) {
      await tenantSQL(pool, async (c) => {
        for (const country of DefaultsUtils.defaultCountries)
          await c.query(
            "INSERT INTO region_country(iso_2,iso_3,num_code,name,display_name) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,iso_2) DO NOTHING",
            [
              country.alpha2.toLowerCase(),
              country.alpha3.toLowerCase(),
              country.numeric,
              country.name.toUpperCase(),
              country.name,
            ]
          )
      })
      const channels = await nativeApp.modules.sales_channel.listSalesChannels({
        name: "Default",
      })
      const channel =
        channels[0] ??
        (await nativeApp.modules.sales_channel.createSalesChannels({
          name: "Default",
        }))
      const stores = await nativeApp.modules.store.listStores({
        name: tenant.name,
      })
      if (!stores.length)
        await nativeApp.modules.store.createStores({
          name: tenant.name,
          default_sales_channel_id: channel.id,
          supported_currencies: [{ currency_code: "usd", is_default: true }],
        })
      const regions = await nativeApp.modules.region.listRegions({
        name: "Default",
      })
      if (!regions.length)
        await nativeApp.modules.region.createRegions({
          name: "Default",
          currency_code: "usd",
          countries: ["us"],
          automatic_taxes: false,
        })
      for (const reason of require("./migrations/0004-commerce.cjs")
        .refundDefaults) {
        const id =
          "refr_" +
          crypto
            .createHmac("sha256", contextSecret)
            .update(JSON.stringify([currentTenant().tenantId, reason.code]))
            .digest("hex")
            .slice(0, 26)
        if (!(await nativeApp.modules.payment.listRefundReasons({ id })).length)
          await nativeApp.modules.payment.createRefundReasons({ id, ...reason })
      }
    },
    async guardProduct(data) {
      if (data.additional_data)
        fail("M2_HOOK_DATA_DISABLED", "Unreviewed hook input is unavailable")
      if (data.shipping_profile_id)
        await nativeApp.modules.fulfillment.retrieveShippingProfile(
          data.shipping_profile_id
        )
      for (const channel of data.sales_channels || [])
        if (channel.id)
          await nativeApp.modules.sales_channel.retrieveSalesChannel(channel.id)
      for (const variant of data.variants || [])
        for (const item of variant.inventory_items || [])
          await nativeApp.modules.inventory.retrieveInventoryItem(
            item.inventory_item_id
          )
    },
    mount(web, middleware) {
      mountM2Routes(web, { nativeApp, pool, jobs, resources, ...middleware })
    },
  }
}
module.exports = { installM2Runtime }
