import { NextRequest, NextResponse } from "next/server"

// Never share a country->region map or a URL-only data cache across shops.
export async function middleware(request: NextRequest) {
  const host = request.headers.get("host")?.toLowerCase()
  const base = process.env.SAAS_BASE_DOMAIN?.toLowerCase()
  const domain = host?.split(":")[0]
  if (!host || !base || !domain?.endsWith(`.${base}`) ||
      !/^[a-z][a-z0-9-]{1,46}[a-z0-9]$/.test(domain.slice(0, -(base.length + 1))))
    return new NextResponse("Store is unavailable", { status: 404 })
  // Region resolution runs in the request-scoped Node server page. Edge fetch
  // cannot preserve the original tenant Host on the fixed backend connection.
  return NextResponse.next()
}
export const config = { matcher: ["/((?!api|_next|favicon.ico|images|assets).*)"] }
