"use strict"
/**
 * Cloud Agent entry: prefer the full localhost demo (registerable) when the
 * private preview directory and marked database already exist; otherwise serve
 * the static HTML prototype on 8080/9443.
 */
const fs = require("node:fs")
const path = require("node:path")
const { spawn } = require("node:child_process")
const { Client } = require("pg")

const PREVIEW =
  process.env.SAAS_PREVIEW_DIRECTORY || "/workspace/.store-saas-preview"
const MARKER = "store-saas-persistent-local-development-v1"
const DB_URL =
  process.env.SAAS_DATABASE_URL ||
  "postgres://medusa_saas_preview_app@127.0.0.1:5432/medusa_saas_preview"

async function previewReady() {
  const runtime = path.join(PREVIEW, "runtime.json")
  const demo = path.join(PREVIEW, "demo-config.json")
  const admin = path.join(__dirname, "admin-dist", "index.html")
  const next = path.join(__dirname, "storefront", ".next", "prerender-manifest.json")
  if (![runtime, demo, admin, next].every((f) => fs.existsSync(f))) return false
  const client = new Client({ connectionString: DB_URL })
  try {
    await client.connect()
    const row = (
      await client.query(
        "SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()"
      )
    ).rows[0]
    return row?.marker === MARKER
  } catch {
    return false
  } finally {
    try {
      await client.end()
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  if (await previewReady()) {
    console.log(
      JSON.stringify({
        mode: "full-demo-preview",
        register: "https://localhost:9443/register",
        home: "https://localhost:9443/",
      })
    )
    const child = spawn(
      process.execPath,
      [path.join(__dirname, "start-demo-preview.cjs")],
      {
        cwd: path.join(__dirname, ".."),
        env: {
          ...process.env,
          NODE_ENV: "development",
          SAAS_PREVIEW_DIRECTORY: PREVIEW,
          SAAS_CLOUD_LOCAL_BROWSE: "1",
          SAAS_BASE_DOMAIN: process.env.SAAS_BASE_DOMAIN || "shops.example.test",
        },
        stdio: "inherit",
      }
    )
    child.on("exit", (code, signal) => {
      process.exitCode = code || (signal ? 1 : 0)
    })
    return
  }
  console.log(
    JSON.stringify({
      mode: "prototype-fallback",
      note: "Run bash saas/bootstrap-cloud-preview.sh for https://localhost:9443/register",
      open: "http://localhost:8080/",
    })
  )
  require("./serve-local-browse.cjs").main()
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err)
    process.exitCode = 1
  })
}
