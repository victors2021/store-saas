import { NextRequest, NextResponse } from "next/server"
import { isTenantHost } from "./lib/tenant-host"

// Never share a country->region map or a URL-only data cache across shops.
export async function middleware(request: NextRequest) {
  const host = request.headers.get("host")?.toLowerCase()
  const base = process.env.SAAS_BASE_DOMAIN?.toLowerCase()
  if (!isTenantHost(host, base, process.env.SAAS_LOCALHOST_ACCESS === "true"))
    return new NextResponse("Store is unavailable", { status: 404 })
  // Region resolution runs in the request-scoped Node server page. Edge fetch
  // cannot preserve the original tenant Host on the fixed backend connection.
  return NextResponse.next()
}
export const config = { matcher: ["/((?!api|_next|favicon.ico|images|assets).*)"] }
