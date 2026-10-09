import { retrieveCart } from "@lib/data/cart"
import { retrieveCustomer } from "@lib/data/customer"
import PaymentWrapper from "@modules/checkout/components/payment-wrapper"
import CheckoutForm from "@modules/checkout/templates/checkout-form"
import CheckoutSummary from "@modules/checkout/templates/checkout-summary"
import { Metadata } from "next"
import { notFound, redirect } from "next/navigation"

export const metadata: Metadata = {
  title: "Checkout",
}

export default async function Checkout(props: { params: Promise<{ countryCode: string }>, searchParams: Promise<{ step?: string }> }) {
  const cart = await retrieveCart()

  if (!cart) {
    return notFound()
  }
  const { step } = await props.searchParams
  if (!step || !["address", "delivery", "payment", "review"].includes(step)) {
    const nextStep = !cart.shipping_address?.address_1 || !cart.email ? "address"
      : !cart.shipping_methods?.length ? "delivery" : "payment"
    redirect(`/${(await props.params).countryCode}/checkout?step=${nextStep}`)
  }

  const customer = await retrieveCustomer()

  return (
    <div className="grid grid-cols-1 small:grid-cols-[1fr_416px] content-container gap-x-40 py-12">
      <PaymentWrapper cart={cart}>
        <CheckoutForm cart={cart} customer={customer} />
      </PaymentWrapper>
      <CheckoutSummary cart={cart} />
    </div>
  )
}
