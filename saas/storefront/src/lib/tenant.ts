import "server-only"
import { headers } from "next/headers"

export async function getTenantHost(): Promise<string> {
  const host = (await headers()).get("host")?.toLowerCase()
  const base = process.env.SAAS_BASE_DOMAIN?.toLowerCase()
  if (!host || !base || !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(host)) {
    throw new Error("A configured store Host is required")
  }
  const domain = host.split(":")[0]
  if (!domain.endsWith(`.${base}`) || !/^[a-z][a-z0-9-]{1,46}[a-z0-9]$/.test(domain.slice(0, -(base.length + 1)))) {
    throw new Error("Store Host is outside the configured platform domain")
  }
  return host
}

export async function getStoreOrigin(): Promise<string> {
  const host = await getTenantHost()
  const scheme = (await headers()).get("x-forwarded-proto")
  return `${scheme === "https" ? "https" : "http"}://${host}`
}
