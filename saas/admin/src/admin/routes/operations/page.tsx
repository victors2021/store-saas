import { defineRouteConfig } from "@medusajs/admin-sdk"
import { ChartBar } from "@medusajs/icons"
import { Button, Container, Heading, Text, toast } from "@medusajs/ui"
import { useEffect, useState } from "react"

type Operation = { id: string; kind: string; resource_id: string; state: string; attempts: number; error_code: string | null }
type State = { status: string; quota: { plan_id: string; product_limit: number; product_count: string; upload_limit_bytes: string; upload_bytes: string; requests_per_minute: number }; operations: Operation[] }
type Audit = { id: string; request_id: string; action: string; route: string; method: string; status: number; created_at: string }
async function request(path: string, options?: RequestInit) {
  const response = await fetch(path, { credentials: "same-origin", ...options })
  const data = await response.json()
  if (!response.ok) throw new Error(data.message || "Operations request failed")
  return data
}
const bytes = (value: string) => `${(Number(value) / 1024 / 1024).toFixed(2)} MiB`
const Operations = () => {
  const [state, setState] = useState<State | null>(null)
  const [audit, setAudit] = useState<Audit[]>([])
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  async function load() {
    const [next, events] = await Promise.all([request("/admin/saas/operations"), request("/admin/saas/audit?limit=15")])
    setState(next); setAudit(events.events)
  }
  useEffect(() => { load().catch(error => setError(error.message)) }, [])
  async function retry(operation: Operation) {
    setBusy(true); setError("")
    try {
      await request(`/admin/saas/operations/${operation.id}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      await load(); toast.success("Operation recovered")
    } catch (error) { setError(error instanceof Error ? error.message : "Recovery failed") }
    finally { setBusy(false) }
  }
  return <div className="flex flex-col gap-y-3">
    <Container>
      <Heading level="h1">Shop operations</Heading>
      {error && <Text role="alert" className="text-ui-fg-error mt-3">{error}</Text>}
      {state && <>
        <Text data-testid="shop-status" className="mt-3">Status: {state.status === "suspended" ? "Paused" : "Active"}</Text>
        {state.status === "suspended" && <Text className="mt-2">New sales are paused. Refunds, paid-order fulfillment and payment reconciliation remain available. Contact the platform operator to resume your shop.</Text>}
        <Text className="mt-3">Plan: {state.quota.plan_id} · Manually activated by the platform</Text>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div className="rounded-lg border p-4"><Text>Products</Text><Heading level="h2" data-testid="product-quota">{state.quota.product_count} / {state.quota.product_limit}</Heading></div>
          <div className="rounded-lg border p-4"><Text>Uploaded files</Text><Heading level="h2" data-testid="upload-quota">{bytes(state.quota.upload_bytes)} / {bytes(state.quota.upload_limit_bytes)}</Heading></div>
          <div className="rounded-lg border p-4"><Text>API requests per minute</Text><Heading level="h2">{state.quota.requests_per_minute}</Heading></div>
        </div>
      </>}
      <Button variant="secondary" className="mt-4" disabled={busy} onClick={() => load().catch(error => setError(error.message))}>Refresh operations</Button>
    </Container>
    <Container>
      <Heading level="h2">Payment recovery</Heading>
      <Text className="mt-2">Retry uses the original saved operation and checks the current payment state. Review the order before retrying an uncertain action.</Text>
      {state?.operations.length === 0 && <Text className="mt-4">No payment operations need recovery.</Text>}
      {state?.operations.map(operation => <div key={operation.id} data-testid="recovery-operation" className="mt-4 flex items-center justify-between gap-4 border-t pt-4">
        <div><Text>{operation.kind} · {operation.state} · attempts: {operation.attempts}</Text><Text size="small">{operation.resource_id} · {operation.error_code || "Awaiting confirmation"}</Text></div>
        <Button disabled={busy || (state.status === "suspended" && operation.kind === "capture")} onClick={() => retry(operation)}>Retry saved operation</Button>
      </div>)}
    </Container>
    <Container>
      <Heading level="h2">Recent audit events</Heading>
      <Text className="mt-2">Requests are identified without storing passwords, payment keys or request bodies.</Text>
      <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Time</th><th>Action</th><th>Route</th><th>Status</th><th>Request ID</th></tr></thead><tbody>
        {audit.map(event => <tr key={event.id} className="border-t"><td className="py-3">{new Date(event.created_at).toLocaleString()}</td><td>{event.action}</td><td>{event.method} {event.route}</td><td>{event.status || "Accepted"}</td><td>{event.request_id}</td></tr>)}
      </tbody></table></div>
    </Container>
  </div>
}
export const config = defineRouteConfig({ label: "Operations", icon: ChartBar })
export default Operations
