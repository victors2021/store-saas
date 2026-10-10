"use strict"
/**
 * Cloud-agent static preview for “远程代码，本地浏览”.
 * Binds 0.0.0.0 so Cursor can forward ports to the user's machine.
 * Serves the interactive HTML prototype only — no database or secrets.
 *
 * HTTP (default 8080) always. HTTPS (default 9443) starts when the port is free,
 * so Forwarded Ports → https://localhost:9443/ works without the full demo stack.
 */
const fs = require("node:fs")
const http = require("node:http")
const https = require("node:https")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const { URL } = require("node:url")

const ROOT = path.resolve(__dirname, "..")
const DOCS = path.join(ROOT, "docs", "saas")
const HOST = process.env.SAAS_LOCAL_BROWSE_HOST || "0.0.0.0"
const PORT = Number(process.env.SAAS_LOCAL_BROWSE_PORT || 8080)
const HTTPS_PORT = Number(
  process.env.SAAS_LOCAL_BROWSE_HTTPS_PORT === undefined
    ? 9443
    : process.env.SAAS_LOCAL_BROWSE_HTTPS_PORT || 0
)

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
}

function safeJoin(base, requestPath) {
  const decoded = decodeURIComponent(requestPath.split("?")[0])
  const cleaned = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "")
  const full = path.join(base, cleaned)
  if (!full.startsWith(base + path.sep) && full !== base) {
    return null
  }
  return full
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  })
  res.end(body)
}

function createHandler() {
  return (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
      let pathname = url.pathname
      if (pathname === "/") {
        pathname = "/saas-prototype.html"
      }
      if (pathname === "/status.json" || pathname === "/health") {
        return send(
          res,
          200,
          JSON.stringify({
            mode: "remote-code-local-browse",
            backend: false,
            note: "Interactive HTML prototype only. Full https://localhost:9443 demo needs the persistent preview stack.",
            open_http: `http://localhost:${PORT}/`,
            open_https: HTTPS_PORT > 0 ? `https://localhost:${HTTPS_PORT}/` : null,
          }),
          { "Content-Type": "application/json; charset=utf-8" }
        )
      }
      const file = safeJoin(DOCS, pathname)
      if (!file) {
        return send(res, 400, "Bad path")
      }
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) {
          return send(res, 404, "Not found")
        }
        const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream"
        res.writeHead(200, {
          "Content-Type": type,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Length": st.size,
        })
        fs.createReadStream(file).pipe(res)
      })
    } catch {
      send(res, 500, "Server error")
    }
  }
}

function ensureBrowseTLS() {
  const directory =
    process.env.SAAS_LOCAL_BROWSE_TLS_DIR ||
    path.join(os.tmpdir(), "store-saas-local-browse-tls")
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    fs.chmodSync(directory, 0o700)
  } catch {
    /* best effort on shared tmp */
  }
  const keyFile = path.join(directory, "key.pem")
  const certFile = path.join(directory, "cert.pem")
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    const temporary = fs.mkdtempSync(path.join(directory, "gen-"))
    try {
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          path.join(temporary, "key.pem"),
          "-out",
          path.join(temporary, "cert.pem"),
          "-days",
          "30",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        { stdio: "ignore" }
      )
      fs.copyFileSync(path.join(temporary, "key.pem"), keyFile)
      fs.copyFileSync(path.join(temporary, "cert.pem"), certFile)
      fs.chmodSync(keyFile, 0o600)
      fs.chmodSync(certFile, 0o600)
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true })
    }
  }
  return {
    key: fs.readFileSync(keyFile),
    cert: fs.readFileSync(certFile),
    directory,
  }
}

function listen(server, port, label) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening)
      reject(err)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, HOST)
  }).then(() => {
    console.log(
      JSON.stringify({
        mode: "remote-code-local-browse",
        transport: label,
        bind: `${HOST}:${port}`,
        open:
          label === "https"
            ? `https://localhost:${port}/`
            : `http://localhost:${port}/`,
        note:
          label === "https"
            ? "Self-signed cert — accept the browser warning once. Agents Window → Forwarded Ports."
            : "Cursor Agents Window → Forwarded Ports → open localhost",
        backend: false,
      })
    )
  })
}

async function main() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("Invalid SAAS_LOCAL_BROWSE_PORT")
  }
  if (
    process.env.SAAS_LOCAL_BROWSE_HTTPS_PORT !== undefined &&
    process.env.SAAS_LOCAL_BROWSE_HTTPS_PORT !== "" &&
    (!Number.isInteger(HTTPS_PORT) || HTTPS_PORT < 0 || HTTPS_PORT > 65535)
  ) {
    throw new Error("Invalid SAAS_LOCAL_BROWSE_HTTPS_PORT")
  }
  const index = path.join(DOCS, "saas-prototype.html")
  if (!fs.existsSync(index)) {
    throw new Error("Missing docs/saas/saas-prototype.html")
  }

  const handler = createHandler()
  const httpServer = http.createServer(handler)
  await listen(httpServer, PORT, "http")
  httpServer.on("error", (err) => {
    console.error(err.message)
    process.exitCode = 1
  })

  if (HTTPS_PORT > 0) {
    try {
      const tls = ensureBrowseTLS()
      const httpsServer = https.createServer(tls, handler)
      await listen(httpsServer, HTTPS_PORT, "https")
      httpsServer.on("error", (err) => {
        console.error(err.message)
        process.exitCode = 1
      })
    } catch (err) {
      // Keep HTTP browse usable if 9443 is taken by the full demo stack or cert gen fails.
      console.error(
        JSON.stringify({
          mode: "remote-code-local-browse",
          https: "skipped",
          port: HTTPS_PORT,
          reason: err && err.message ? err.message : String(err),
          fallback: `http://localhost:${PORT}/`,
        })
      )
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err)
    process.exitCode = 1
  })
}

module.exports = { main, ensureBrowseTLS, createHandler }
