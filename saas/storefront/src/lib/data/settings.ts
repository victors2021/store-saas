"use server"
import { sdk } from "@lib/config"
export type StoreSettings = { name: string; logo: string | null; primary_color: string; seo_description: string }
export async function retrieveStoreSettings(): Promise<StoreSettings> {
  const { settings } = await sdk.client.fetch<{ settings: StoreSettings }>("/store/settings", { method: "GET" })
  return settings
}
