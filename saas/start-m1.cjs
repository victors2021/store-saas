"use strict"

// Configure through secret injection; never put credentials in command args.
const { createM1Application } = require("./m1-application.cjs")
async function main() {
  const app = await createM1Application({
    databaseUrl: process.env.SAAS_DATABASE_URL,
    baseDomain: process.env.SAAS_BASE_DOMAIN,
    jwtSecret: process.env.SAAS_JWT_SECRET,
    contextSecret: process.env.SAAS_CONTEXT_SECRET,
    namespaceSecret: process.env.SAAS_IDENTITY_SECRET,
    platformKey: process.env.SAAS_PLATFORM_KEY,
    platformActorId: process.env.SAAS_PLATFORM_ACTOR_ID,
    secureCookies: true,
  })
  const port = Number(process.env.SAAS_PORT || 9000)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    await app.close()
    throw new Error("Invalid SAAS_PORT")
  }
  const listener = app.web.listen(
    port,
    process.env.SAAS_BIND_ADDRESS || "127.0.0.1",
    () => console.log("M1 HTTP service started")
  )
  let closing = false
  async function close() {
    if (closing) return
    closing = true
    await new Promise((resolve) => listener.close(resolve))
    await app.close()
  }
  process.once("SIGTERM", close)
  process.once("SIGINT", close)
}
main().catch((error) => {
  console.error("M1 startup failed", {
    name: error.name,
    message: error.message,
  })
  process.exitCode = 1
})
