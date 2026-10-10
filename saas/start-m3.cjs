"use strict"
process.env.MEDUSA_SAAS_MODE = "true"
process.env.NODE_ENV = process.env.NODE_ENV || "production"
const path = require("node:path")
const fs = require("node:fs")
const { spawn } = require("node:child_process")
const { createM1Application } = require("./m1-application.cjs")
const { runtimeConfig, port } = require("./m3-config.cjs")

async function main() {
  const config = runtimeConfig(), gatewayPort = port("PORT", 9000), storefrontPort = port("SAAS_STOREFRONT_PORT", 8000)
  if (gatewayPort === storefrontPort) throw new Error("Gateway and storefront ports must differ")
  const storefront = path.join(__dirname, "storefront")
  if (!fs.existsSync(path.join(storefront, ".next/BUILD_ID"))) throw new Error("Build the pinned storefront before starting M3")
  const app = await createM1Application({ ...config, frontend: { adminDirectory: path.join(__dirname, "admin-dist"),
    storefrontOrigin: `http://127.0.0.1:${storefrontPort}` } })
  let server, child, worker, stopping = false
  async function shutdown() {
    if (stopping) return
    stopping = true
    if (server) await new Promise((resolve) => server.close(resolve))
    if (child && child.exitCode === null && !child.signalCode) {
      child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve))
    }
    if (worker) await worker
    if(app.m5Runtime) await app.m5Runtime.workerStopped()
    await app.close()
  }
  try {
    server = await new Promise((resolve, reject) => {
      const value = app.web.listen(gatewayPort, process.env.SAAS_BIND_HOST || "127.0.0.1", () => resolve(value))
      value.once("error", reject)
    })
    const childEnvironment = { ...process.env, NODE_ENV:"production", MEDUSA_BACKEND_URL: `http://127.0.0.1:${gatewayPort}`, SAAS_BASE_DOMAIN: config.baseDomain }
    for (const key of Object.keys(childEnvironment))
      if ((key.startsWith("SAAS_") && key !== "SAAS_BASE_DOMAIN") ||
          ["STRIPE_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"].includes(key)) delete childEnvironment[key]
    child = spawn(process.execPath, [path.join(storefront, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(storefrontPort)],
      { cwd: storefront, env: childEnvironment, stdio: ["ignore", "inherit", "inherit"] })
    child.once("error", () => { process.exitCode = 1; shutdown().catch(() => {}) })
    child.once("exit", () => { if (!stopping) { process.exitCode = 1; shutdown().catch(() => {}) } })
    if (process.env.SAAS_RUN_WORKER === "true") {
      if(app.m5Runtime) await app.m5Runtime.workerStarted()
      worker = (async () => {
      while (!stopping) {
        try {
          if(app.m5Runtime) await app.m5Runtime.maintenance()
          if (!(await app.m2Runtime.jobs.processNext())) await new Promise((resolve) => setTimeout(resolve, 500))
        } catch (error) {
          console.error("M3 worker operation failed", { name: error.name, code: error.code })
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }
      })()
    }
    process.once("SIGTERM", () => shutdown().catch(() => { process.exitCode = 1 }))
    process.once("SIGINT", () => shutdown().catch(() => { process.exitCode = 1 }))
    console.log(`${config.operations ? "M5" : config.payments ? "M4" : "M3"} native Admin and storefront gateway listening on port ${gatewayPort}`)
  } catch (error) { await shutdown(); throw error }
}
main().catch((error) => { console.error("M3 startup failed", { name: error.name, message: error.message }); process.exitCode = 1 })
