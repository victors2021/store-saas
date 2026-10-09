import { defineRouteConfig } from "@medusajs/admin-sdk"
import { CreditCard } from "@medusajs/icons"
import {
  Button,
  Container,
  Heading,
  Input,
  Label,
  Text,
  toast,
} from "@medusajs/ui"
import { useEffect, useState } from "react"

type Payment = {
  account_id: string
  mode: string
  webhook_url: string
  publishable_key: string
}
type Total = {
  currency_code: string
  orders: number
  canceled_orders: number
  captured_amount: string
  refunded_amount: string
  net_received: string
}
type Attention = {
  failed_operations: number
  pending_operations: number
  pending_webhooks: number
  review_required: number
}
const request = async (path: string, options?: RequestInit) => {
  const response = await fetch(path, { credentials: "same-origin", ...options })
  const data = await response.json()
  if (!response.ok) throw new Error(data.message || "Payment request failed")
  return data
}
const PaymentSettings = () => {
  const [payment, setPayment] = useState<Payment | null>(null)
  const [totals, setTotals] = useState<Total[]>([])
  const [attention, setAttention] = useState<Attention | null>(null)
  const [form, setForm] = useState({
    account_id: "",
    api_key: "",
    publishable_key: "",
    webhook_secret: "",
  })
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  useEffect(() => {
    request("/admin/saas/payments")
      .then((data) => setPayment(data.payment))
      .catch((error) => setError(error.message))
    request("/admin/saas/metrics")
      .then((data) => {
        setTotals(data.currency_totals)
        setAttention(data.payment_attention)
      })
      .catch((error) => setError(error.message))
  }, [])
  async function save(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    try {
      const data = await request("/admin/saas/payments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      })
      setPayment(data.payment)
      setForm({
        account_id: "",
        api_key: "",
        publishable_key: "",
        webhook_secret: "",
      })
      toast.success("Stripe test account saved")
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Container>
      <Heading>Payments</Heading>
      <Text className="mt-2">Stripe test mode</Text>
      <Text>
        Connect this store&apos;s own Stripe test account. These amounts
        represent test transactions.
      </Text>
      {payment && (
        <div className="my-4">
          <Text>Account: {payment.account_id}</Text>
          <Label>Webhook URL</Label>
          <Text data-testid="stripe-webhook-url" className="break-all">
            {payment.webhook_url}
          </Text>
          <Text>
            Keep the previous webhook endpoint enabled while older payments are
            outstanding.
          </Text>
        </div>
      )}
      <form
        onSubmit={save}
        className="my-6 flex max-w-xl flex-col gap-4"
        autoComplete="off"
      >
        {(
          [
            "account_id",
            "api_key",
            "publishable_key",
            "webhook_secret",
          ] as const
        ).map((key) => (
          <div key={key}>
            <Label htmlFor={key}>
              {
                {
                  account_id: "Stripe account ID",
                  api_key: "Test secret key",
                  publishable_key: "Test publishable key",
                  webhook_secret: "Webhook signing secret",
                }[key]
              }
            </Label>
            <Input
              id={key}
              type={
                key === "api_key" || key === "webhook_secret"
                  ? "password"
                  : "text"
              }
              autoComplete="off"
              required
              value={form[key]}
              onChange={(event) =>
                setForm({ ...form, [key]: event.target.value })
              }
            />
          </div>
        ))}
        {error && (
          <Text role="alert" className="text-ui-fg-error">
            {error}
          </Text>
        )}
        <Button type="submit" disabled={busy} isLoading={busy}>
          {payment ? "Rotate test credentials" : "Connect test account"}
        </Button>
      </form>
      {attention &&
        (attention.review_required > 0 ||
          attention.failed_operations > 0 ||
          attention.pending_operations > 0 ||
          attention.pending_webhooks > 0) && (
          <div className="mb-6" role="status">
            <Heading level="h2">Payments needing attention</Heading>
            <Text>
              Merchant review: {attention.review_required} · Failed operations:{" "}
              {attention.failed_operations} · Pending operations:{" "}
              {attention.pending_operations} · Pending notifications:{" "}
              {attention.pending_webhooks}
            </Text>
            <Text>
              Check the affected payment in Stripe before retrying with the same
              request. External refunds or partial captures require
              reconciliation with your operator.
            </Text>
          </div>
        )}
      <Heading level="h2">Commerce totals</Heading>
      {totals.map((row) => (
        <div
          key={row.currency_code}
          className="mt-4"
          data-testid="commerce-total"
        >
          <Text>
            {row.currency_code.toUpperCase()} · {row.orders} orders ·{" "}
            {row.canceled_orders} canceled
          </Text>
          <Text>
            Captured: {row.captured_amount} · Refunded: {row.refunded_amount} ·
            Net received: {row.net_received}
          </Text>
        </div>
      ))}
    </Container>
  )
}
export const config = defineRouteConfig({ label: "Payments", icon: CreditCard })
export default PaymentSettings
