import { Metadata } from "next"
import { retrieveStoreSettings } from "@lib/data/settings"
import { getStoreOrigin } from "@lib/tenant"
import "styles/globals.css"

export const dynamic = "force-dynamic"
export async function generateMetadata(): Promise<Metadata> {
  const settings = await retrieveStoreSettings()
  return { metadataBase: new URL(await getStoreOrigin()),
    title: { default: settings.name, template: `%s | ${settings.name}` },
    description: settings.seo_description }
}
export default async function RootLayout(props: { children: React.ReactNode }) {
  const settings = await retrieveStoreSettings()
  return <html lang="en" data-mode="light"><body style={{ "--store-primary": settings.primary_color } as React.CSSProperties}>
    <main className="relative">{props.children}</main></body></html>
}
