"use strict"
// Acceptance-only workflows. Loaded explicitly by the test, never by startup.
const {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} = require("@medusajs/framework/workflows-sdk")
const { Modules } = require("@medusajs/framework/utils")

const createItem = createStep(
  "m2-acceptance-create-item",
  async (input, { container }) => {
    const item = await container
      .resolve(Modules.INVENTORY)
      .createInventoryItems({ sku: input.sku, title: "Workflow acceptance" })
    return new StepResponse({ id: item.id, sku: input.sku }, item.id)
  },
  async (id, { container }) => {
    if (id)
      await container.resolve(Modules.INVENTORY).softDeleteInventoryItems([id])
  }
)
const retryItem = createStep(
  {
    name: "m2-acceptance-retry-item",
    async: true,
    maxRetries: 2,
    retryInterval: 1,
  },
  async (input, { container }) => {
    const cache = container.resolve(Modules.CACHE)
    const key = "acceptance:retry:" + input.sku
    const attempts = ((await cache.retrieve(key)) ?? 0) + 1
    await cache.set(key, attempts, 600)
    if (attempts === 1) throw new Error("Acceptance temporary failure")
    return new StepResponse(input)
  }
)
const failItem = createStep("m2-acceptance-fail-item", async () => {
  throw new Error("Acceptance compensation failure")
})
const retryWorkflowId = "m2-acceptance-retry"
createWorkflow(
  { name: retryWorkflowId, store: true, idempotent: true, retentionTime: 600 },
  function (input) {
    const item = createItem(input)
    return new WorkflowResponse(retryItem(item))
  }
)
const compensationWorkflowId = "m2-acceptance-compensation"
createWorkflow(
  { name: compensationWorkflowId, store: true, retentionTime: 600 },
  function (input) {
    const item = createItem(input)
    return new WorkflowResponse(failItem(item))
  }
)
module.exports = { retryWorkflowId, compensationWorkflowId }
