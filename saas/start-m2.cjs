"use strict"
process.env.MEDUSA_SAAS_MODE = "true"
const { createM1Application } = require("./m1-application.cjs")
function required(name) {
  if (!process.env[name]) throw new Error(`${name} is required`)
  return process.env[name]
}
async function main() {
  const app = await createM1Application({
    databaseUrl: required("SAAS_DATABASE_URL"),
    baseDomain: required("SAAS_BASE_DOMAIN"),
    platformActorId: required("SAAS_PLATFORM_ACTOR_ID"),
    jwtSecret: required("SAAS_JWT_SECRET"),
    contextSecret: required("SAAS_CONTEXT_SECRET"),
    namespaceSecret: required("SAAS_IDENTITY_SECRET"),
    platformKey: required("SAAS_PLATFORM_KEY"),
    commerce: true,
    objectRoot: required("SAAS_OBJECT_ROOT"),
  })
  const port = Number(process.env.PORT || 9000),
    host = process.env.SAAS_BIND_HOST || "127.0.0.1"
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT")
  const server = app.web.listen(port, host, () =>
    console.log(`M2 gateway listening on ${host}:${port}`)
  )
  let stop = false,
    worker
  if (process.env.SAAS_RUN_WORKER === "true")
    worker = (async () => {
      while (!stop) {
        try {
          const result = await app.m2Runtime.jobs.processNext()
          if (!result) await new Promise((r) => setTimeout(r, 500))
        } catch (e) {
          console.error("Worker operation failed", {
            code: e.code,
            name: e.name,
          })
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
    })()
  async function shutdown() {
    if (stop) return
    stop = true
    await new Promise((r) => server.close(r))
    if (worker) await worker
    await app.close()
  }
  process.once("SIGTERM", () => shutdown().catch(() => (process.exitCode = 1)))
  process.once("SIGINT", () => shutdown().catch(() => (process.exitCode = 1)))
}
main().catch((e) => {
  console.error("M2 startup failed", { name: e.name, message: e.message })
  process.exitCode = 1
})
