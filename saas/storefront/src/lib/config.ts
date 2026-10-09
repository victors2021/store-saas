import "server-only"
import Medusa, { FetchArgs, FetchInput, FetchError } from "@medusajs/js-sdk"
import { getAuthHeaders } from "./data/cookies"
import { getTenantHost } from "./tenant"
import { stringify } from "qs"
import http from "node:http"
import https from "node:https"

const backend = process.env.MEDUSA_BACKEND_URL || "http://127.0.0.1:9000"
// Reuse the SDK API methods. Its shared in-memory token and global publishable
// key are never authentication sources in this multi-tenant server.
export const sdk = new Medusa({ baseUrl: backend, debug: false, auth: { type: "jwt", jwtTokenStorageMethod: "memory" } })
sdk.client.fetch = async <T>(input: FetchInput, init?: FetchArgs): Promise<T> => {
  const route = String(input)
  if (!route.startsWith("/store/") && !/^\/auth\/(customer\/emailpass(?:\/register)?|session)$/.test(route))
    throw new Error("Only store and customer authentication APIs are available")
  if (route.includes("://") || route.includes("\\") || route.includes("..") || route.includes("#") || route.includes("?"))
    throw new Error("Invalid storefront API path")
  const host = await getTenantHost()
  const requestHeaders = new Headers({ accept: "application/json", host })
  if (init?.headers) for (const [key, value] of Object.entries(init.headers)) {
    if (typeof value === "string" && !["host", "x-forwarded-host", "x-tenant-id", "x-publishable-api-key", "x-publishable-key"].includes(key.toLowerCase()))
      requestHeaders.set(key, value)
  }
  // Public page rendering does not need a customer identity. A stale or copied
  // cookie must not turn the public layout into a failed authenticated request.
  const privateRoute = /^\/store\/(customers|carts|orders|payment-collections|shipping-options)(?:\/|$)/.test(route)
  if (!privateRoute) requestHeaders.delete("authorization")
  else if (!requestHeaders.has("authorization")) {
    const auth = await getAuthHeaders()
    if ("authorization" in auth) requestHeaders.set("authorization", auth.authorization)
  }
  if (init?.body !== undefined) requestHeaders.set("content-type", "application/json")
  if (route.endsWith("/complete") && !requestHeaders.has("idempotency-key"))
    requestHeaders.set("idempotency-key", `checkout-${route.split("/")[3]}`)
  const { fields: requestedFields, ...safeQuery } = init?.query || {}
  // The fixed theme consumes the server's approved DTO defaults. Its upstream
  // wildcard field selectors never expand the SaaS public query boundary.
  const query = stringify(safeQuery, { arrayFormat: "indices", skipNulls: true })
  // Node 22's built-in fetch replaces a supplied Host header with its URL host.
  // A fixed backend connection with an explicit original Host is mandatory here.
  const target = new URL(`${backend}${route}${query ? `?${query}` : ""}`)
  return await new Promise<T>((resolve, reject) => {
    const request = (target.protocol === "https:" ? https : http).request(target, {
      method: init?.method || "GET", headers: Object.fromEntries(requestHeaders.entries()), timeout: 15000,
    }, (response) => {
      const chunks: string[] = []; let size = 0
      response.setEncoding("utf8")
      response.on("data", (chunk: string) => {
        size += Buffer.byteLength(chunk)
        if (size > 16 * 1024 * 1024) request.destroy(new Error("Store response is too large"))
        else chunks.push(chunk)
      })
      response.on("error", reject)
      response.on("end", () => {
        try {
          const data = JSON.parse(chunks.join(""))
          const status = response.statusCode || 502
          if (status < 200 || status >= 300) reject(new FetchError(data.message || "Store request failed", response.statusMessage || "", status))
          else resolve(data as T)
        } catch (error) { reject(error) }
      })
    })
    request.on("error", reject)
    request.on("timeout", () => request.destroy(new Error("Store request timed out")))
    request.end(init?.body !== undefined ? JSON.stringify(init.body) : undefined)
  })
}
