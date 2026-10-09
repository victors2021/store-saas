import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps, HttpTypes } from "@medusajs/framework/types"
import {
  Button,
  Container,
  Heading,
  Input,
  Label,
  Text,
  toast,
} from "@medusajs/ui"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"

const request = async (path: string, options?: RequestInit) => {
  const response = await fetch(path, { credentials: "same-origin", ...options })
  const data = await response.json()
  if (!response.ok) throw new Error(data.message || "Order operation failed")
  return data
}
const OrderCommerce = ({ data }: DetailWidgetProps<HttpTypes.AdminOrder>) => {
  const [order, setOrder] = useState<HttpTypes.AdminOrder | null>(null)
  const [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  const [amount, setAmount] = useState(""),
    [tracking, setTracking] = useState("")
  const [trackingUrl, setTrackingUrl] = useState(""),
    [labelUrl, setLabelUrl] = useState("")
  const [location, setLocation] = useState("")
  const keys = useRef(new Map<string, string>())
  const queryClient = useQueryClient()
  async function refresh() {
    const fields = encodeURIComponent(
      "+currency_code,+*fulfillments,+*fulfillments.items"
    )
    setOrder((await request(`/admin/orders/${data.id}?fields=${fields}`)).order)
  }
  useEffect(() => {
    request("/admin/saas/payments")
      .then(() => {
        setEnabled(true)
        return refresh()
      })
      .catch((error) => setError(error.message))
    request("/admin/stock-locations")
      .then((data) => setLocation(data.stock_locations[0]?.id || ""))
      .catch(() => {})
  }, [data.id])
  async function operate(path: string, body: object) {
    const serialized = JSON.stringify(body),
      operation = path + serialized
    if (!keys.current.has(operation))
      keys.current.set(operation, crypto.randomUUID())
    setBusy(true)
    setError("")
    try {
      await request(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": keys.current.get(operation)!,
        },
        body: serialized,
      })
      keys.current.delete(operation)
      await refresh()
      await queryClient.invalidateQueries({ queryKey: ["orders"] })
      toast.success("Order operation completed")
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (!enabled) return null
  if (!order)
    return (
      <Container>
        <Heading level="h2">Order operations</Heading>
        <Text role="alert">{error || "Loading order"}</Text>
      </Container>
    )
  const payment = order.payment_collections
    ?.flatMap((collection) => collection.payments || [])
    .find((payment) => payment.provider_id === "pp_stripe_saas")
  const captured =
    payment?.captures?.reduce((sum, row) => sum + row.amount, 0) || 0
  const refunded =
    payment?.refunds?.reduce((sum, row) => sum + row.amount, 0) || 0
  const remaining = order.items
    .filter(
      (item) => item.quantity > Number(item.detail?.fulfilled_quantity || 0)
    )
    .map((item) => ({
      id: item.id,
      quantity: item.quantity - Number(item.detail?.fulfilled_quantity || 0),
    }))
  const fulfillments = (order.fulfillments ||
    []) as (HttpTypes.AdminOrderFulfillment & {
    items?: { line_item_id?: string; quantity: number }[]
  })[]
  return (
    <Container>
      <Heading level="h2">Order operations</Heading>
      <Text>Stripe test mode · {order.currency_code.toUpperCase()}</Text>
      {error && (
        <Text role="alert" className="text-ui-fg-error">
          {error}
        </Text>
      )}
      <div className="mt-4 flex flex-col gap-4">
        {payment && order.status !== "canceled" && (
          <>
            <Text>
              Captured: {captured} · Refunded: {refunded}
            </Text>
            {captured === 0 && (
              <Button
                disabled={busy}
                onClick={() =>
                  operate(`/admin/payments/${payment.id}/capture`, {})
                }
              >
                Capture full amount
              </Button>
            )}
            {captured > refunded && (
              <div>
                <Label htmlFor="refund-amount">Refund amount</Label>
                <Input
                  id="refund-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  max={captured - refunded}
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
                <Button
                  className="mt-2"
                  disabled={busy || !amount}
                  onClick={() =>
                    operate(`/admin/payments/${payment.id}/refund`, {
                      amount: Number(amount),
                    })
                  }
                >
                  Refund payment
                </Button>
              </div>
            )}
          </>
        )}
        {remaining.length > 0 && order.status !== "canceled" && (
          <Button
            disabled={busy || !location}
            onClick={() =>
              operate(`/admin/orders/${order.id}/fulfillments`, {
                location_id: location,
                items: remaining,
              })
            }
          >
            Fulfill remaining items
          </Button>
        )}
        {fulfillments
          .filter((row) => !row.shipped_at && !row.canceled_at)
          .map((fulfillment) => (
            <div key={fulfillment.id}>
              <Label htmlFor={fulfillment.id}>Tracking number (optional)</Label>
              <Input
                id={fulfillment.id}
                value={tracking}
                onChange={(event) => setTracking(event.target.value)}
              />
              {tracking && (
                <>
                  <Label htmlFor="tracking-url">Tracking URL</Label>
                  <Input
                    id="tracking-url"
                    type="url"
                    value={trackingUrl}
                    onChange={(event) => setTrackingUrl(event.target.value)}
                  />
                  <Label htmlFor="label-url">Shipping label URL</Label>
                  <Input
                    id="label-url"
                    type="url"
                    value={labelUrl}
                    onChange={(event) => setLabelUrl(event.target.value)}
                  />
                </>
              )}
              <Button
                className="mt-2"
                disabled={
                  busy || Boolean(tracking && (!trackingUrl || !labelUrl))
                }
                onClick={() =>
                  operate(
                    `/admin/orders/${order.id}/fulfillments/${fulfillment.id}/shipments`,
                    {
                      items:
                        fulfillment.items
                          ?.filter((row) => row.line_item_id)
                          .map((row) => ({
                            id: row.line_item_id!,
                            quantity: row.quantity,
                          })) || [],
                      labels: tracking
                        ? [
                            {
                              tracking_number: tracking,
                              tracking_url: trackingUrl,
                              label_url: labelUrl,
                            },
                          ]
                        : [],
                    }
                  )
                }
              >
                Mark shipped
              </Button>
              <Button
                className="ml-2"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  operate(
                    `/admin/orders/${order.id}/fulfillments/${fulfillment.id}/cancel`,
                    {}
                  )
                }
              >
                Cancel fulfillment
              </Button>
            </div>
          ))}
        {order.status !== "canceled" &&
          !fulfillments.some((row) => !row.canceled_at) && (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => operate(`/admin/orders/${order.id}/cancel`, {})}
            >
              Cancel order and release stock
            </Button>
          )}
      </div>
    </Container>
  )
}
export const config = defineWidgetConfig({ zone: "order.details.after" })
export default OrderCommerce
