"use strict"
/**
 * Cloud-agent static preview for “远程代码，本地浏览”.
 * Binds 0.0.0.0 so Cursor can forward ports to the user's machine.
 * Serves the interactive HTML prototype only — no database or secrets.
 *
 * HTTP (default 8080) always — preferred for Cursor Forwarded Ports.
 * HTTPS (default 9443) matches the full-demo port number, but still serves
 * the same prototype. Plain HTTP to 9443 gets a clear help page (Cursor’s
 * “Open” button often uses http:// and otherwise looks “broken”).
 */
const fs = require("node:fs")
const http = require("node:http")
const https = require("node:https")
const net = require("node:net")
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

function statusPayload() {
  return {
    mode: "remote-code-local-browse",
    backend: false,
    same_content: true,
    preferred: `http://localhost:${PORT}/`,
    http: {
      port: PORT,
      open: `http://localhost:${PORT}/`,
      note: "Plain HTTP — use this with Cursor Forwarded Ports",
    },
    https: HTTPS_PORT > 0
      ? {
          port: HTTPS_PORT,
          open: `https://localhost:${HTTPS_PORT}/`,
          note: "Self-signed HTTPS — must use https:// and accept the browser warning. Same prototype as 8080; not the full demo stack.",
        }
      : null,
    difference:
      "8080=HTTP prototype (easy). 9443=HTTPS prototype (same page, self-signed). Full login/demo needs the persistent preview stack.",
  }
}

function httpHintPage() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>9443 需要 HTTPS</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1.25rem;color:#172c29;background:#f5f6f2}
code,a{color:#116b51} .box{background:#fff;border:1px solid #e3e8e3;border-radius:12px;padding:1.25rem 1.4rem}
h1{font-size:1.35rem;letter-spacing:-.02em} li{margin:.45rem 0}
</style></head><body>
<div class="box">
<h1>端口 9443 只接受 HTTPS</h1>
<p>你当前用的是 <strong>http://</strong>。Cursor Forwarded Ports 的“打开”常会默认走 HTTP，因此看起来像无法访问。</p>
<ol>
<li>优先打开普通 HTTP 原型：<a href="http://localhost:${PORT}/"><code>http://localhost:${PORT}/</code></a>（推荐）</li>
<li>若要坚持 9443，请手动输入：<a href="https://localhost:${HTTPS_PORT}/"><code>https://localhost:${HTTPS_PORT}/</code></a></li>
<li>首次会提示自签证书不安全——选择继续访问即可</li>
</ol>
<p>两个地址现在是<strong>同一套交互原型</strong>（本地模拟数据，不连后端）。带真实登录的完整演示需要持久预览库，见文档 <code>25-LOCALHOST-DEVELOPMENT.md</code>。</p>
<p><a href="/status.json">status.json</a></p>
</div></body></html>`
}

function createHandler(options = {}) {
  const hintOnRoot = Boolean(options.httpHintOnRoot)
  return (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
      let pathname = url.pathname
      if (pathname === "/status.json" || pathname === "/health") {
        return send(res, 200, JSON.stringify(statusPayload()), {
          "Content-Type": "application/json; charset=utf-8",
        })
      }
      if (pathname === "/" && hintOnRoot) {
        // Only used for accidental plain-HTTP hits on the HTTPS port.
        return send(res, 400, httpHintPage(), {
          "Content-Type": "text/html; charset=utf-8",
        })
      }
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
          label === "https-mux"
            ? `https://localhost:${port}/`
            : `http://localhost:${port}/`,
        preferred: `http://localhost:${PORT}/`,
        note:
          label === "https-mux"
            ? "Use https:// (not http://). Self-signed — accept warning once. Prefer 8080 for Forwarded Ports."
            : "Cursor Agents Window → Forwarded Ports → open localhost",
        backend: false,
      })
    )
  })
}

/**
 * 9443 multiplexer: TLS clients get the prototype; plain HTTP clients get a help page
 * (Forwarded Ports “Open” often hits http://localhost:9443 and used to look dead).
 */
function createHttpsMuxServer(credentials, secureHandler, plainHandler) {
  // These servers are not listened on; the mux feeds accepted sockets into them.
  const secureServer = https.createServer(credentials, secureHandler)
  const plainServer = http.createServer(plainHandler)

  const mux = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      socket.pause()
      socket.unshift(chunk)
      // TLS handshake records start with 0x16; anything else is treated as HTTP.
      if (chunk[0] === 0x16) {
        secureServer.emit("connection", socket)
      } else {
        plainServer.emit("connection", socket)
      }
      process.nextTick(() => {
        try {
          socket.resume()
        } catch {
          /* ignore */
        }
      })
    })
    socket.on("error", () => {
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    })
  })

  secureServer.on("tlsClientError", () => {})
  secureServer.on("error", (err) => console.error(err.message))
  plainServer.on("error", (err) => console.error(err.message))
  return mux
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
      const credentials = ensureBrowseTLS()
      const mux = createHttpsMuxServer(
        credentials,
        createHandler(),
        createHandler({ httpHintOnRoot: true })
      )
      await listen(mux, HTTPS_PORT, "https-mux")
      mux.on("error", (err) => {
        console.error(err.message)
        process.exitCode = 1
      })
    } catch (err) {
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

module.exports = {
  main,
  ensureBrowseTLS,
  createHandler,
  createHttpsMuxServer,
  statusPayload,
}
