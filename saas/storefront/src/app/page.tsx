import { listRegions } from "@lib/data/regions"
import { redirect, notFound } from "next/navigation"

export const dynamic = "force-dynamic"
export default async function StoreRoot() {
  const regions = await listRegions()
  const countries = regions.flatMap((region) => region.countries?.map((country) => country.iso_2) || [])
  const country = countries.includes("us") ? "us" : countries[0]
  if (!country) notFound()
  redirect(`/${country}`)
}
