"use strict"

const { normalizeHost } = require("./tenant-control.cjs")
const { TenantSecurityError } = require("./tenant-context.cjs")

// A configured ingress must preserve Host and strip client forwarding headers.
// Express only accepts its protocol header from the explicitly trusted peer.
function configureBrowserSecurity(web, trustedProxy = false, validateHost = normalizeHost) {
  if (trustedProxy !== false && (!Array.isArray(trustedProxy) ||
      !trustedProxy.length || trustedProxy.some((value) =>
        typeof value !== "string" || !value || value === "0.0.0.0/0" ||
        value === "::/0" || !/^[A-Fa-f0-9.:/]+$/.test(value)))) {
    throw new TypeError("Explicit ingress IP addresses or CIDRs are required")
  }
  web.set("trust proxy", trustedProxy)
  return (req, res, next) => {
    res.set("Cache-Control", "private, no-store")
    res.set("X-Content-Type-Options", "nosniff")
    res.set("Referrer-Policy", "same-origin")
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next()
    const origin = req.headers.origin
    // Non-browser clients (workers and the server-side storefront SDK) have no
    // Origin. Browser mutations must come from this exact scheme/host/port.
    if (origin !== undefined) {
      let accepted = false
      try {
        const url = new URL(origin)
        validateHost(req.headers.host)
        accepted = ["http:", "https:"].includes(url.protocol) &&
          !url.username && !url.password && url.origin === origin &&
          url.origin === `${req.protocol}://${req.headers.host.toLowerCase()}`
      } catch {}
      if (!accepted) return next(new TenantSecurityError(
        "TENANT_BROWSER_ORIGIN_FORBIDDEN", "Browser request must originate from this store"
      ))
    } else if (req.headers["sec-fetch-site"] &&
        req.headers["sec-fetch-site"] !== "same-origin" &&
        req.headers["sec-fetch-site"] !== "none") {
      return next(new TenantSecurityError(
        "TENANT_BROWSER_ORIGIN_FORBIDDEN", "Cross-origin browser mutation is unavailable"
      ))
    }
    next()
  }
}

module.exports = { configureBrowserSecurity }
