import { defineRouteConfig } from "@medusajs/admin-sdk"
import { BuildingStorefront } from "@medusajs/icons"
import { Button, Container, Heading, Input, Label, Text, Textarea, toast } from "@medusajs/ui"
import { useEffect, useState } from "react"

type Settings = { name: string; logo: string | null; primary_color: string; seo_description: string }
async function request(path: string, options?: RequestInit) {
  const response = await fetch(path, { credentials: "same-origin", ...options })
  const data = await response.json()
  if (!response.ok) throw new Error(data.message || "Store settings request failed")
  return data
}
const StorefrontSettings = () => {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => { request("/admin/saas/settings").then((data) => setSettings(data.settings)).catch((error) => setError(error.message)) }, [])
  async function save(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      const data = await request("/admin/saas/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) })
      setSettings(data.settings)
      toast.success("Storefront settings saved")
    } catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }
  async function upload(file?: File) {
    if (!file || !settings) return
    setBusy(true)
    try {
      const body = new FormData(); body.append("files", file)
      const data = await request("/admin/uploads", { method: "POST", body })
      setSettings({ ...settings, logo: data.files[0].url })
    } catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }
  if (!settings) return <Container><Text>{error || "Loading storefront settings"}</Text></Container>
  return <Container><Heading>Storefront</Heading><form onSubmit={save} className="mt-6 flex max-w-xl flex-col gap-4">
    <div><Label htmlFor="store-name">Store name</Label><Input id="store-name" required maxLength={120} value={settings.name}
      onChange={(event) => setSettings({ ...settings, name: event.target.value })} /></div>
    <div><Label htmlFor="store-logo">Logo</Label><input id="store-logo" type="file" accept="image/png,image/jpeg,image/webp"
      onChange={(event) => upload(event.target.files?.[0])} />{settings.logo && <img src={settings.logo} alt="Store logo" className="mt-2 h-16 object-contain" />}</div>
    <div><Label htmlFor="store-color">Primary color</Label><Input id="store-color" type="color" value={settings.primary_color}
      onChange={(event) => setSettings({ ...settings, primary_color: event.target.value })} /></div>
    <div><Label htmlFor="store-description">SEO description</Label><Textarea id="store-description" maxLength={320}
      value={settings.seo_description} onChange={(event) => setSettings({ ...settings, seo_description: event.target.value })} /></div>
    {error && <Text className="text-ui-fg-error">{error}</Text>}
    <Button type="submit" disabled={busy} isLoading={busy}>Save settings</Button>
  </form></Container>
}
export const config = defineRouteConfig({ label: "Storefront", icon: BuildingStorefront })
export default StorefrontSettings
