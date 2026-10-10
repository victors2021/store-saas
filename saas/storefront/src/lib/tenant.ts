import "server-only"
import { headers } from "next/headers"
import { isTenantHost } from "./tenant-host"

export async function getTenantHost(): Promise<string> {
  const host = (await headers()).get("host")?.toLowerCase()
  const base = process.env.SAAS_BASE_DOMAIN?.toLowerCase()
  if (!host || !isTenantHost(host, base, process.env.SAAS_LOCALHOST_ACCESS === "true")) {
    throw new Error("Store Host is outside the configured platform domain")
  }
  return host
}

export async function getStoreOrigin(): Promise<string> {
  const host = await getTenantHost()
  const scheme = (await headers()).get("x-forwarded-proto")
  return `${scheme === "https" ? "https" : "http"}://${host}`
}
