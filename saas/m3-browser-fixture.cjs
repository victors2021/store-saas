"use strict"
// Disposable real PostgreSQL/native Medusa fixture, with a loopback TLS ingress.
// Certificates and all application keys are generated for this run only.
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const https = require("node:https")
const http = require("node:http")
const { spawn, execFileSync } = require("node:child_process")
const { createFixture, credentials } = require("./m3-test-fixture.cjs")
console.log = (...args) => console.error(...args)

async function main() {
  const m5=process.env.SAAS_BROWSER_STAGE === "M5",m4=m5||process.env.SAAS_BROWSER_STAGE === "M4"
  const stripe=m4 ? await require("./m4-stripe-fixture.cjs").createStripeFixture() : undefined
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "medusa-m3-tls-"))
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(temporary, "key.pem"),
    "-out", path.join(temporary, "cert.pem"), "-days", "1", "-subj", "/CN=*.shops.example.test"], { stdio: "ignore" })
  const nextPort = Number(process.env.SAAS_M3_NEXT_PORT || 8000)
  const fixture = await createFixture({ secureCookies: true, trustedProxy: ["127.0.0.1/32"],
    ...(m4 ? {payments:true,testStripeFactory:stripe.factory} : {}),
    ...(m5 ? {operations:true,fixtureStage:"m5_browser"}:{}),
    objectRoot: path.join(temporary, "objects"), frontend: {
      adminDirectory: path.join(__dirname, "admin-dist"), storefrontOrigin: `http://127.0.0.1:${nextPort}`,
    } })
  await fixture.seedCommerce()
  const extra=m4 ? await require("./m4-browser-seed.cjs").seedM4Browser(fixture,stripe) : {}
  let workerTimer,workerTask
  if(m5) {
    if(!process.env.SAAS_M5_BROWSER_AUTH_FILE)throw new Error("Owned private browser authentication file required")
    fs.writeFileSync(process.env.SAAS_M5_BROWSER_AUTH_FILE,JSON.stringify({platformKey:fixture.config.platformKey}),{flag:"wx",mode:0o600})
    stripe.failNext("alpha","/v1/refunds",503)
    await fixture.app.m5Runtime.workerStarted()
    workerTimer=setInterval(()=>{if(!workerTask)workerTask=fixture.app.m2Runtime.jobs.processNext().catch(()=>{}).finally(()=>{workerTask=undefined})},250)
  }
  const server = https.createServer({ key: fs.readFileSync(path.join(temporary, "key.pem")),
    cert: fs.readFileSync(path.join(temporary, "cert.pem")) }, (req, res) => {
    const headers = { ...req.headers }
    for (const key of ["forwarded", "x-forwarded-proto", "x-forwarded-for", "x-forwarded-host", "x-forwarded-port", "x-real-ip"])
      delete headers[key]
    headers["x-forwarded-proto"] = "https"
    const proxy = http.request({ hostname: "127.0.0.1", port: fixture.server.address().port, method: req.method,
      path: req.url, headers }, (upstream) => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res) })
    proxy.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end() })
    req.pipe(proxy)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const next = spawn(process.execPath, [path.join(__dirname, "storefront/node_modules/next/dist/bin/next"),
    "start", "-H", "127.0.0.1", "-p", String(nextPort)], { cwd: path.join(__dirname, "storefront"),
    env: { ...process.env, NODE_ENV: "production", MEDUSA_BACKEND_URL: `http://127.0.0.1:${fixture.server.address().port}`,
      SAAS_BASE_DOMAIN: fixture.config.baseDomain }, stdio: ["ignore", 2, 2] })
  // Only public fixture IDs and public test credentials leave this process.
  process.stdout.write(JSON.stringify({ ready: true, port: server.address().port, nextPort,
    tenants: fixture.tenants.map((tenant) => ({ slug: tenant.slug, hostname: tenant.hostname,
      productId: tenant.product.id, variantId: tenant.product.variants[0].id, locationId: tenant.location.id, locationName: tenant.location.name,
      ...(m4 ? {orderId:tenant.orderId,inventoryId:tenant.inventoryId} : {}) })), credentials,...extra }) + "\n")
  let stopping = false
  async function stop() {
    if (stopping) return
    stopping = true
    if(workerTimer)clearInterval(workerTimer)
    if(workerTask)await workerTask
    next.kill("SIGTERM")
    await new Promise((resolve) => next.exitCode !== null || next.signalCode ? resolve() : next.once("exit", resolve))
    await new Promise((resolve) => server.close(resolve))
    await fixture.close()
    if(stripe)await stripe.close()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
  process.once("SIGINT", () => stop().catch((error) => { console.error(error.message); process.exitCode = 1 }))
  process.once("SIGTERM", () => stop().catch((error) => { console.error(error.message); process.exitCode = 1 }))
  next.once("exit", (code) => { if (!stopping) { process.exitCode = code || 1; stop().catch(() => {}) } })
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
