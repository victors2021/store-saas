"use server"
import { sdk } from "@lib/config"
import { HttpTypes } from "@medusajs/types"

export async function listRegions(): Promise<HttpTypes.StoreRegion[]> {
  return (await sdk.client.fetch<{ regions: HttpTypes.StoreRegion[] }>("/store/regions", { method: "GET" })).regions
}
export async function retrieveRegion(id: string): Promise<HttpTypes.StoreRegion> {
  return (await sdk.client.fetch<{ region: HttpTypes.StoreRegion }>(`/store/regions/${id}`, { method: "GET" })).region
}
export async function getRegion(countryCode: string): Promise<HttpTypes.StoreRegion | null> {
  const regions = await listRegions()
  return regions.find((region) => region.countries?.some((country) => country.iso_2 === countryCode)) || null
}
