"use strict"
/**
 * Cloud-agent static preview for “远程代码，本地浏览”.
 * Binds 0.0.0.0 so Cursor can forward the port to the user's machine.
 * Serves the interactive HTML prototype only — no database or secrets.
 */
const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")
const { URL } = require("node:url")

const ROOT = path.resolve(__dirname, "..")
const DOCS = path.join(ROOT, "docs", "saas")
const HOST = process.env.SAAS_LOCAL_BROWSE_HOST || "0.0.0.0"
const PORT = Number(process.env.SAAS_LOCAL_BROWSE_PORT || 8080)

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

function main() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("Invalid SAAS_LOCAL_BROWSE_PORT")
  }
  const index = path.join(DOCS, "saas-prototype.html")
  if (!fs.existsSync(index)) {
    throw new Error("Missing docs/saas/saas-prototype.html")
  }

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
      let pathname = url.pathname
      if (pathname === "/") {
        pathname = "/saas-prototype.html"
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
  })

  server.listen(PORT, HOST, () => {
    console.log(
      JSON.stringify({
        mode: "remote-code-local-browse",
        bind: `${HOST}:${PORT}`,
        open: `http://localhost:${PORT}/`,
        note: "Cursor Agents Window → Forwarded Ports → open localhost",
        backend: false,
      })
    )
  })
  server.on("error", (err) => {
    console.error(err.message)
    process.exitCode = 1
  })
}

if (require.main === module) {
  main()
}

module.exports = { main }
