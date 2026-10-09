"use strict"
// Acceptance-only subprocess. Fixture secrets arrive through IPC, not argv,
// environment values or a config file. This entry has no public HTTP server.
process.env.MEDUSA_SAAS_MODE = "true"
process.env.NODE_ENV = "test"
const { createM1Application } = require("./m1-application.cjs")
const { createTenantVerifier, runWithTenant } = require("./tenant-context.cjs")
const { tenantSQL } = require("./tenant-sql.cjs")
require("./m2-workflow-fixtures.cjs")

async function eventually(fn) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const result = await fn()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error("Worker acceptance condition did not become ready")
}

process.once(
  "message",
  async ({ config, operation, jobId, targets, workflowId }) => {
    let app
    try {
      app = await createM1Application(config)
      if (operation === "cart-crash-window") {
        const result = await app.m2Runtime.jobs.processNext({
          jobId,
          simulateCrashAfterHandler: true,
        })
        if (result?.state !== "unacknowledged")
          throw new Error("Expected unacknowledged checkpoint")
        process.send({ pid: process.pid, result })
        // The parent terminates this actual process with SIGKILL.
        return
      }
      let result
      if (operation === "cart-replay") {
        result = await app.m2Runtime.jobs.processNext({ jobId })
      } else if (operation === "retry-and-events") {
        const verifier = createTenantVerifier({
          secret: config.contextSecret,
          issuer: "m2-worker-fixture",
          audience: "acceptance",
          lookupMembership: (identity) =>
            app.control.authorizeMembership(identity),
        })
        const contexts = []
        for (const target of targets) {
          // The parent supplies a signed owner fixture. Worker task authority
          // continues to come from the persisted signed dispatch envelope.
          contexts.push(await verifier(target.token))
        }
        const delivered = []
        app.nativeApp.modules.event_bus.subscribe(
          "acceptance.order-export",
          async ({ data }) => {
            const order = await app.nativeApp.modules.order.retrieveOrder(
              data.orderId
            )
            const customer =
              await app.nativeApp.modules.customer.retrieveCustomer(
                order.customer_id
              )
            const orders = await app.nativeApp.modules.order.listOrders()
            delivered.push({
              orderId: order.id,
              customerId: customer.id,
              email: customer.email,
              exportOrderIds: orders.map((row) => row.id),
            })
          }
        )
        for (let index = 0; index < targets.length; index++) {
          const target = targets[index]
          const first = await app.m2Runtime.jobs.processNext({
            jobId: target.retryId,
          })
          if (first?.state !== "done")
            throw new Error("Native retry dispatch did not finish")
          await runWithTenant(contexts[index], () =>
            eventually(async () => {
              const states =
                await app.nativeApp.modules.workflows.listWorkflowExecutions({
                  workflow_id: workflowId,
                })
              if (states.length === 1 && states[0].state === "done") return true
              const next = await tenantSQL(
                app.pool,
                async (c) =>
                  (
                    await c.query(
                      "SELECT j.id FROM saas_job j JOIN saas_control.task_dispatch d ON d.id=j.id WHERE j.kind='native.resume' AND j.payload->>'workflowId'=$1 AND d.state='pending' AND d.available_at<=now() ORDER BY d.available_at LIMIT 1",
                      [workflowId]
                    )
                  ).rows[0]
              )
              if (
                next &&
                (await app.m2Runtime.jobs.processNext({ jobId: next.id }))
                  ?.state !== "done"
              )
                throw new Error("Native follow-up retry failed")
              return false
            })
          )
        }
        const firstEvent = await app.m2Runtime.jobs.processNext({
          jobId: targets[0].eventId,
        })
        if (firstEvent?.state !== "done")
          throw new Error("Originating event failed")
        if (
          (await app.m2Runtime.jobs.processNext({
            jobId: targets[1].eventId,
          })) !== null
        )
          throw new Error("Foreign event group was released")
        await runWithTenant(contexts[1], () =>
          app.nativeApp.modules.event_bus.releaseGroupedEvents(
            "same-event-group"
          )
        )
        if (
          (await app.m2Runtime.jobs.processNext({ jobId: targets[1].eventId }))
            ?.state !== "done"
        )
          throw new Error("Second tenant event failed")
        result = { delivered }
      } else {
        throw new Error("Unknown acceptance operation")
      }
      await app.close()
      app = undefined
      process.send({ pid: process.pid, result }, () => process.exit(0))
    } catch (error) {
      if (app) await app.close().catch(() => {})
      // Never send configuration or arbitrary native Error objects over logs.
      process.send(
        {
          error: { code: error.code, name: error.name, message: error.message },
        },
        () => process.exit(1)
      )
    }
  }
)
