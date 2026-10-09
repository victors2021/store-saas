"use strict"
const express = require("express")
const fs = require("node:fs")
const http = require("node:http")
const path = require("node:path")

function mountFrontend(web, control, { adminDirectory, storefrontOrigin }) {
  const index = path.resolve(adminDirectory, "index.html")
  if (!fs.existsSync(index)) throw new Error("Build the native SaaS Admin before starting the M3 frontend")
  const target = new URL(storefrontOrigin)
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(target.hostname) ||
      target.username || target.password || target.pathname !== "/" || target.search || target.hash)
    throw new Error("The M3 frontend accepts only a fixed loopback Next.js origin")
  const staticAdmin = express.static(path.resolve(adminDirectory), { index: false, dotfiles: "deny", fallthrough: true })
  const isFrontend = (req) => req.path === "/app" || req.path.startsWith("/app/") || req.path === "/" ||
    /^\/[a-z]{2}(?:\/|$)/.test(req.path) || req.path.startsWith("/_next/") || req.path.startsWith("/images/") ||
    ["/favicon.ico", "/opengraph-image.jpg", "/twitter-image.jpg"].includes(req.path)
  web.use((req, res, next) => {
    if (!isFrontend(req)) return next()
    Promise.resolve().then(async () => {
      if (["x-forwarded-host", "x-tenant-id", "tenant-id", "tenant_id"].some((key) => req.headers[key] !== undefined))
        return res.status(400).json({ code: "TENANT_HEADER_FORBIDDEN", message: "A direct store Host is required" })
      if (!(await control.resolveDomain(req.headers.host)))
        return res.status(404).json({ code: "TENANT_NOT_FOUND", message: "Store is unavailable" })
      res.set("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'self'; object-src 'none'")
      if (req.path === "/app" || req.path.startsWith("/app/")) {
        if (!["GET", "HEAD"].includes(req.method)) return res.sendStatus(404)
        if (req.path === "/app") return res.redirect(308, "/app/")
        const savedUrl = req.url
        req.url = req.url.slice(4)
        return staticAdmin(req, res, (error) => {
          req.url = savedUrl
          if (error) return next(error)
          if (path.extname(req.path)) return res.sendStatus(404)
          res.sendFile(index)
        })
      }
      const headers = { ...req.headers }
      for (const name of ["authorization", "connection", "transfer-encoding", "proxy-authorization", "forwarded",
        "x-forwarded-host", "x-forwarded-for", "x-forwarded-port", "x-real-ip"]) delete headers[name]
      headers["x-forwarded-proto"] = req.protocol
      const upstream = http.request({ hostname: target.hostname, port: target.port || 80,
        path: req.originalUrl, method: req.method, headers, timeout: 30_000 }, (reply) => {
        res.status(reply.statusCode)
        for (const [name, value] of Object.entries(reply.headers))
          if (value !== undefined && !["connection", "transfer-encoding", "cache-control", "x-powered-by"].includes(name)) res.set(name, value)
        reply.on("error", () => res.destroy())
        reply.pipe(res)
      })
      upstream.on("timeout", () => upstream.destroy(new Error("Frontend timed out")))
      upstream.on("error", () => {
        if (!res.headersSent) res.status(503).json({ code: "STOREFRONT_UNAVAILABLE", message: "Storefront is temporarily unavailable" })
        else res.destroy()
      })
      req.on("aborted", () => upstream.destroy())
      req.pipe(upstream)
    }).catch(next)
  })
}
module.exports = { mountFrontend }
