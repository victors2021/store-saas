"use strict"

const { normalizeHost } = require("./tenant-control.cjs")

// Local aliases never replace persisted domains or supply a tenant ID. The
// normal control-plane lookup, membership checks and RLS still select the shop.
function createDevelopmentHosts({ baseDomain, enabled = false }) {
  if (typeof enabled !== "boolean") throw new TypeError("localhost access must be boolean")
  if (enabled && (!["development", "test"].includes(process.env.NODE_ENV) || process.env.SAAS_RELEASE_MANIFEST ||
      !/(^|\.)example\.test$/.test(baseDomain))) {
    throw new Error("localhost access requires development mode on example.test without a release manifest")
  }
  const domain = normalizeHost(baseDomain)
  function alias(host) {
    if (!enabled || typeof host !== "string") return null
    const match = /^(localhost|shops\.localhost|([a-z][a-z0-9-]{1,46}[a-z0-9])\.shops\.localhost)(?::([0-9]{1,5}))?$/i.exec(host)
    if (!match || (match[3] && (Number(match[3]) < 1 || Number(match[3]) > 65535))) return null
    return { hostname: match[1].toLowerCase(), slug: match[2]?.toLowerCase() }
  }
  const canonicalHost = host => {
    const local = alias(host)
    return local ? (local.slug ? `${local.slug}.${domain}` : domain) : normalizeHost(host)
  }
  const publicBaseDomain = host => alias(host) ? "shops.localhost" : domain
  // Old sample image URLs remain stored under their canonical domain. Return
  // same-shop media paths for local browsers; do not change persisted records,
  // arbitrary metadata, external images or another shop's URLs.
  function middleware(req, res, next) {
    const local = alias(req.headers.host)
    if (!local?.slug) return next()
    const canonical = `${local.slug}.${domain}`, json = res.json
    function media(value) {
      if (typeof value !== "string") return value
      try {
        const url = new URL(value)
        if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
            url.hostname === canonical && /^\/(images\/|store\/media\/)/.test(url.pathname))
          return url.pathname + url.search + url.hash
      } catch { /* Relative media and ordinary values are already usable. */ }
      return value
    }
    function project(value, parent) {
      if (Array.isArray(value)) return value.map(item => project(item, parent))
      if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return value
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
        key === "metadata" ? item : key === "thumbnail" || (key === "url" && parent === "images")
          ? media(item) : project(item, key)]))
    }
    res.json = function (value) { return json.call(this, project(value)) }
    next()
  }
  return Object.freeze({ enabled, canonicalHost, publicBaseDomain, middleware })
}

module.exports = { createDevelopmentHosts }
