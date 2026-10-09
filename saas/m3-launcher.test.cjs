"use strict"
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const http = require("node:http")
const os = require("node:os"), path = require("node:path")
const { spawn } = require("node:child_process")
const { createFixture } = require("./m3-test-fixture.cjs")

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function unusedPort() {
  const server = http.createServer()
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const value = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return value
}
function launch(args, env) {
  const child = spawn(process.execPath, args, { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] })
  // Keys are carried in the child's environment only. Never persist auth state.
  let output = ""
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { output = (output + data).slice(-16000) })
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  return { child, exited, output: () => output }
}
function get(port, host, path) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path, headers: { host }, timeout: 5000 }, (response) => {
      const chunks = []
      response.on("data", (data) => chunks.push(data))
      response.on("error", reject)
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString(), headers: response.headers }))
    })
    request.on("error", reject)
    request.on("timeout", () => request.destroy(new Error("Launcher request timed out")))
  })
}
const m5=process.env.SAAS_TEST_MILESTONE === "M5",m4=m5||process.env.SAAS_TEST_MILESTONE === "M4", milestone=m5?"M5":m4 ? "M4" : "M3"
test(`${milestone} actual upgrade CLI and production launcher reuse the isolated database`, { timeout: 120000 }, async () => {
  const f = await createFixture(m4 ? {payments:true,...(m5?{operations:true,fixtureStage:"m5_launcher"}:{})} : {}), [A, B] = f.tenants, checks = []
  let runtime
  const probe=m4 ? fs.mkdtempSync(path.join(os.tmpdir(),"saas-m4-launcher-")) : undefined
  try {
    await f.seedCommerce()
    const port = await unusedPort(), nextPort = await unusedPort()
    assert.notEqual(port, nextPort)
    const env = { ...process.env, SAAS_DATABASE_URL: f.config.databaseUrl, SAAS_BASE_DOMAIN: f.config.baseDomain,
      SAAS_PLATFORM_ACTOR_ID: f.config.platformActorId, SAAS_JWT_SECRET: f.config.jwtSecret,
      SAAS_CONTEXT_SECRET: f.config.contextSecret, SAAS_IDENTITY_SECRET: f.config.namespaceSecret,
      SAAS_PLATFORM_KEY: f.config.platformKey, SAAS_OBJECT_ROOT: f.config.objectRoot,
      SAAS_BIND_HOST: "127.0.0.1", SAAS_STOREFRONT_PORT: String(nextPort), PORT: String(port), SAAS_RUN_WORKER: "false",
      ...(m4 ? {SAAS_PAYMENT_KEY:f.config.paymentKey,SAAS_STRIPE_ALPHA_API_KEY:"sk_test_launchersecretfixture00000000",STRIPE_WEBHOOK_SECRET:"whsec_launchersecretfixture00000000"} : {}),
      ...(m5?{SAAS_ENABLE_PAYMENTS:"true",SAAS_ENABLE_OPERATIONS:"true",SAAS_RUN_WORKER:"true",SAAS_BACKUP_KEY:require("node:crypto").randomBytes(32).toString("hex")}:{}) }
    if(m4) {
      const namesFile=path.join(probe,"child-environment-names.json"),preload=path.join(probe,"probe.cjs")
      fs.writeFileSync(preload,`if(process.argv[1]?.includes("next/dist/bin/next"))require("node:fs").writeFileSync(${JSON.stringify(namesFile)},JSON.stringify(Object.keys(process.env)))`)
      env.NODE_OPTIONS=`${env.NODE_OPTIONS || ""} --require ${preload}`
      for(let attempt=0;attempt<2;attempt++) {
        const migration=launch([m5?"saas/migrate-m5-command.cjs":"saas/migrate-m4-command.cjs"],{...env,SAAS_MIGRATION_DATABASE_URL:`postgres://postgres@localhost:5432/medusa_saas_${m5?"m5_launcher":"m4"}_http`,
          SAAS_APPLICATION_ROLE:`medusa_saas_${m5?"m5_launcher":"m4"}_app`,SAAS_ALLOW_NATIVE_REFERENCE_SEEDS:"true"})
        assert.equal((await migration.exited).code,0,migration.output())
      }
      checks.push(`actual ${milestone} migration CLI is idempotent against the existing native database`)
      const missing={...env};delete missing.SAAS_PAYMENT_KEY
      const refused=launch([m5?"saas/start-m5.cjs":"saas/start-m4.cjs"],missing)
      assert.equal((await refused.exited).code,1);assert(refused.output().includes("SAAS_PAYMENT_KEY is required"))
      checks.push("M4 startup fails closed without the dedicated payment encryption key")
    }
    const before = (await f.request(A.hostname, "GET", "/store/settings")).body.settings
    for (let attempt = 0; attempt < 2; attempt++) {
      const upgrade = launch(["saas/initialize-m3.cjs", A.id], env)
      assert.equal((await upgrade.exited).code, 0, upgrade.output())
    }
    assert.deepEqual((await f.request(A.hostname, "GET", "/store/settings")).body.settings, before)
    const audit = await f.db.query("SELECT count(*)::int AS count FROM saas_control.audit_event WHERE tenant_id=$1 AND action='tenant.m3_initialized' AND actor_id=$2", [A.id, f.config.platformActorId])
    assert.equal(audit.rows[0].count, 2)
    checks.push("real upgrade CLI is idempotent and records its verified platform operator")
    runtime = launch([m5?"saas/start-m5.cjs":m4 ? "saas/start-m4.cjs" : "saas/start-m3.cjs"], env)
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      if (runtime.child.exitCode !== null || runtime.child.signalCode) throw new Error(runtime.output())
      try {
        const health = await get(port, "localhost", "/health")
        const page = await get(port, A.hostname, "/us")
        if (health.status === 200 && JSON.parse(health.body).stage === milestone && page.status === 200) { ready = true; break }
      } catch {}
      await delay(100)
    }
    assert(ready, runtime.output())
    for (const tenant of [A, B]) {
      const page = await get(port, tenant.hostname, "/us/products/cotton-shirt")
      assert.equal(page.status, 200)
      assert(page.body.includes(tenant.product.title))
      assert(!page.body.includes(tenant === A ? B.product.title : A.product.title))
      assert.equal(page.headers["cache-control"], "private, no-store")
      const admin = await get(port, tenant.hostname, "/app/login")
      assert.equal(admin.status, 200)
      assert(admin.body.includes("/app/assets/"))
    }
    assert.equal((await get(port, "missing.shops.example.test", "/us")).status, 404)
    assert.equal((await get(port, A.hostname, "/opengraph-image.jpg")).status, 200)
    checks.push("actual launcher starts both production bundles and retains Host isolation")
    if(m5) {
      const health=JSON.parse((await get(port,"localhost","/health/ready")).body)
      assert.deepEqual(health.checks,{api:true,database:true,worker:true})
      assert.equal((await get(port,"platform.shops.example.test","/platform")).status,200)
      checks.push("M5 actual launcher runs its durable worker and exposes the platform console on the platform Host")
    }
    if(m4) {
      const names=JSON.parse(fs.readFileSync(path.join(probe,"child-environment-names.json"),"utf8"))
      assert(!names.includes("SAAS_PAYMENT_KEY"),"Payment key must not enter the storefront environment")
      assert(!names.includes("SAAS_DATABASE_URL"),"Database credential must not enter the storefront environment")
      assert(!names.includes("SAAS_STRIPE_ALPHA_API_KEY"),"Sandbox provider key must not enter the storefront environment")
      assert(!names.includes("STRIPE_WEBHOOK_SECRET"),"Provider signing key must not enter the storefront environment")
      if(m5)assert(!names.includes("SAAS_BACKUP_KEY"),"Backup key must not enter the storefront environment")
      checks.push("private storefront child receives no payment encryption key or database credential")
    }
    runtime.child.kill("SIGTERM")
    const stopped = await runtime.exited
    assert.equal(stopped.code, 0)
    assert.equal(stopped.signal, null)
    runtime = null
    await assert.rejects(get(nextPort, "localhost", "/us"))
    checks.push("graceful shutdown also stops the private Next.js child")
    const output=process.env[m5?"SAAS_M5_LAUNCHER_RESULT":m4 ? "SAAS_M4_LAUNCHER_RESULT" : "SAAS_M3_LAUNCHER_RESULT"]
    if (output) fs.writeFileSync(output,JSON.stringify({ milestone, success: true, passed: checks.length, checks }, null, 2))
  } finally {
    if (runtime && runtime.child.exitCode === null && !runtime.child.signalCode) {
      runtime.child.kill("SIGTERM")
      await runtime.exited
    }
    await f.close()
    if(probe)fs.rmSync(probe,{recursive:true,force:true})
  }
})
