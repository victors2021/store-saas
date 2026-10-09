"use strict"
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs")
const Stripe = require("stripe")
const { createFixture } = require("./m3-test-fixture.cjs")
const { createStripeFixture } = require("./m4-stripe-fixture.cjs")
const { tenantSQL } = require("./tenant-sql.cjs")
const { migrateM4, verifyM4Runtime } = require("./migrate-m4.cjs")
const providerId = "pp_stripe_saas"

test(
  "M4 native Stripe protocol, lifecycle, inventory and tenant isolation acceptance",
  { timeout: 240000 },
  async () => {
    if (process.env.SAAS_M4_RESULT)
      fs.rmSync(process.env.SAAS_M4_RESULT, { force: true })
    const stripe = await createStripeFixture(),
      checks = []
    let f
    const check = async (name, task) => {
      await task()
      checks.push({ name, passed: true })
      console.log("PASS", name)
    }
    try {
      f = await createFixture({
        payments: true,
        testStripeFactory: stripe.factory,
      })
      const [A, B] = f.tenants
      const owner = (tenant) => ({
        authorization: `Bearer ${tenant.ownerToken}`,
      })
      const call = async (
        tenant,
        method,
        path,
        body,
        headers = owner(tenant)
      ) => f.ok(await f.request(tenant.hostname, method, path, body, headers))
      const denied = (response, codes = [400, 401, 403, 404, 409]) =>
        assert(
          codes.includes(response.status),
          `Unexpected HTTP ${response.status}: ${JSON.stringify(response.body)}`
        )
      const register = async (tenant, email = "m4-buyer@example.test") => {
        const credentials = { email, password: f.credentials.password }
        const auth = (
          await call(
            tenant,
            "POST",
            "/auth/customer/emailpass/register",
            credentials,
            {}
          )
        ).token
        const customer = (
          await call(
            tenant,
            "POST",
            "/store/customers",
            { email },
            { authorization: `Bearer ${auth}` }
          )
        ).customer
        const token = (
          await call(
            tenant,
            "POST",
            "/auth/customer/emailpass",
            credentials,
            {}
          )
        ).token
        return { customer, headers: { authorization: `Bearer ${token}` } }
      }
      const stock = async (tenant, quantity) => {
        const item = (
          await call(tenant, "POST", "/admin/inventory-items", {
            title: "M4 managed stock",
            sku: "M4-SHARED-STOCK",
          })
        ).inventory_item
        await call(
          tenant,
          "POST",
          `/admin/inventory-items/${item.id}/location-levels`,
          { location_id: tenant.location.id, stocked_quantity: quantity }
        )
        await call(
          tenant,
          "POST",
          `/admin/products/${tenant.product.id}/variants/inventory-items/batch`,
          {
            create: [
              {
                variant_id: tenant.product.variants[0].id,
                inventory_item_id: item.id,
                required_quantity: 1,
              },
            ],
          }
        )
        await call(
          tenant,
          "POST",
          `/admin/products/${tenant.product.id}/variants/${tenant.product.variants[0].id}`,
          { manage_inventory: true }
        )
        tenant.inventory = item
      }
      let sequence = 0
      const cart = async (tenant, buyer, quantity = 1) => {
        const address = {
          first_name: "M4",
          last_name: "Buyer",
          address_1: "1 Acceptance St",
          city: "Boston",
          postal_code: "02110",
          country_code: "us",
        }
        const headers = {
          ...buyer.headers,
          "idempotency-key": `m4-cart-${++sequence}`,
        }
        let value = (
          await call(
            tenant,
            "POST",
            "/store/carts",
            {
              region_id: tenant.region.id,
              items: [{ variant_id: tenant.product.variants[0].id, quantity }],
              email: buyer.customer.email,
              shipping_address: address,
              billing_address: address,
            },
            headers
          )
        ).cart
        await call(
          tenant,
          "POST",
          `/store/carts/${value.id}/shipping-methods`,
          { option_id: tenant.shipping.id },
          buyer.headers
        )
        value = (
          await call(
            tenant,
            "GET",
            `/store/carts/${value.id}`,
            null,
            buyer.headers
          )
        ).cart
        const collection = (
          await call(
            tenant,
            "POST",
            "/store/payment-collections",
            { cart_id: value.id },
            buyer.headers
          )
        ).payment_collection
        const response = await call(
          tenant,
          "POST",
          `/store/payment-collections/${collection.id}/payment-sessions`,
          { provider_id: providerId },
          buyer.headers
        )
        const session = response.payment_collection.payment_sessions[0]
        const bound = (
          await f.db.query(
            "SELECT intent_id FROM saas_payment_binding WHERE tenant_id=$1 AND id=$2",
            [tenant.id, session.id]
          )
        ).rows[0]
        return {
          ...value,
          session,
          intentId: bound.intent_id,
          collectionId: collection.id,
          headers: buyer.headers,
        }
      }
      const complete = async (tenant, cart, key = `m4-complete-${cart.id}`) =>
        call(
          tenant,
          "POST",
          `/store/carts/${cart.id}/complete`,
          {},
          { ...cart.headers, "idempotency-key": key }
        )
      const mutate = async (tenant, path, body, key) =>
        call(tenant, "POST", path, body, {
          ...owner(tenant),
          "idempotency-key": key,
        })
      const level = async (tenant) =>
        (
          await call(
            tenant,
            "GET",
            `/admin/inventory-items/${tenant.inventory.id}/location-levels`
          )
        ).inventory_levels[0]
      let buyerA,
        buyerB,
        cartA,
        cartB,
        orderA,
        orderB,
        paymentA,
        paymentB,
        configA
      await check(
        "M4 upgrade is additive, idempotent and identifies its HTTP boundary",
        async () => {
          assert.equal(
            (await f.request("localhost", "GET", "/health")).body.stage,
            "M4"
          )
          assert(
            (
              await migrateM4(f.db, {
                applicationRole: "medusa_saas_m4_app",
                allowNativeReferenceSeeds: true,
              })
            ).every((m) => !m.applied)
          )
          const forced = (
            await f.db.query(
              "SELECT count(*)::integer AS count FROM pg_class WHERE relrowsecurity AND relforcerowsecurity"
            )
          ).rows[0].count
          assert.equal(forced, 139)
        }
      )
      await check(
        "startup verifies credential uniqueness and callback ownership even when the migration ledger matches",
        async () => {
          const verify = async () => {
            const client = await f.app.pool.connect()
            try {
              await verifyM4Runtime(client)
            } finally {
              client.release()
            }
          }
          await f.db.query("DROP INDEX saas_payment_active_credential")
          try {
            await assert.rejects(verify, /active credential uniqueness drift/)
          } finally {
            await f.db.query(
              "CREATE UNIQUE INDEX saas_payment_active_credential ON saas_payment_credential(tenant_id) WHERE active"
            )
          }
          await f.db.query(
            "ALTER TABLE saas_control.payment_endpoint DROP CONSTRAINT payment_endpoint_credential_fk"
          )
          try {
            await assert.rejects(verify, /endpoint ownership FK drift/)
          } finally {
            await f.db.query(
              "ALTER TABLE saas_control.payment_endpoint ADD CONSTRAINT payment_endpoint_credential_fk FOREIGN KEY(tenant_id,credential_id) REFERENCES saas_payment_credential(tenant_id,id)"
            )
          }
          await verify()
        }
      )
      await check(
        "an unconfigured store advertises no payment method",
        async () => {
          assert.equal(
            (
              await call(
                A,
                "GET",
                `/store/payment-providers?region_id=${A.region.id}`,
                null,
                {}
              )
            ).payment_providers.length,
            0
          )
        }
      )
      await check(
        "independent merchant credentials are verified, encrypted and never returned",
        async () => {
          configA = (
            await call(
              A,
              "POST",
              "/admin/saas/payments",
              stripe.config("alpha")
            )
          ).payment
          const configB = (
            await call(
              B,
              "POST",
              "/admin/saas/payments",
              stripe.config("bravo")
            )
          ).payment
          assert.notEqual(configA.account_id, configB.account_id)
          const rows = (
            await f.db.query("SELECT ciphertext FROM saas_payment_credential")
          ).rows
          for (const row of rows)
            assert(
              !row.ciphertext.includes("sk_test_") &&
                !row.ciphertext.includes("whsec_")
            )
          assert(!JSON.stringify(configA).includes("api_key"))
          assert.equal(
            (await call(A, "GET", "/store/saas/payments", null, {})).payment
              .publishable_key,
            stripe.config("alpha").publishable_key
          )
          denied(
            await f.request(
              B.hostname,
              "POST",
              "/admin/saas/payments",
              stripe.config("alpha"),
              owner(B)
            ),
            [400, 409]
          )
          denied(
            await f.request(
              A.hostname,
              "POST",
              "/admin/saas/payments",
              {
                ...stripe.config("alpha"),
                account_id: stripe.config("bravo").account_id,
              },
              owner(A)
            ),
            [400]
          )
          denied(
            await f.request(
              A.hostname,
              "POST",
              "/admin/saas/payments",
              {
                ...stripe.config("alpha"),
              api_key: stripe.config("alpha").api_key.replace("_test_", "_live_"),
              },
              owner(A)
            ),
            [400]
          )
        }
      )
      await f.seedCommerce()
      await stock(A, 3)
      await stock(B, 3)
      buyerA = await register(A)
      buyerB = await register(B)
      await check(
        "tenant Stripe sessions use native recalculated amounts and minimal public DTOs",
        async () => {
          cartA = await cart(A, buyerA)
          cartB = await cart(B, buyerB)
          assert.equal(stripe.intent("alpha", cartA.intentId).amount, 3000)
          assert.equal(stripe.intent("bravo", cartB.intentId).amount, 4200)
          assert.deepEqual(Object.keys(cartA.session.data).sort(), [
            "client_secret",
            "publishable_key",
          ])
          assert.equal(
            cartA.session.data.publishable_key,
            stripe.config("alpha").publishable_key
          )
          const refreshed = (
            await call(
              A,
              "GET",
              `/store/carts/${cartA.id}`,
              null,
              buyerA.headers
            )
          ).cart
          assert.equal(
            refreshed.payment_collection.payment_sessions[0].data
              .publishable_key,
            stripe.config("alpha").publishable_key
          )
          denied(
            await f.request(
              A.hostname,
              "POST",
              `/store/payment-collections/${cartA.collectionId}/payment-sessions`,
              {
                provider_id: providerId,
                data: { id: cartB.intentId, capture_method: "automatic" },
              },
              buyerA.headers
            ),
            [400]
          )
          denied(
            await f.request(
              A.hostname,
              "POST",
              `/store/payment-collections/${cartB.collectionId}/payment-sessions`,
              { provider_id: providerId },
              buyerA.headers
            ),
            [404]
          )
        }
      )
      await check(
        "region-level payment configuration gates new sessions in the owning store",
        async () => {
          const link = {
            region: { region_id: A.region.id },
            payment: { payment_provider_id: providerId },
          }
          await f.inStore(A, () => f.app.nativeApp.link.dismiss(link))
          try {
            assert.equal(
              (
                await call(
                  A,
                  "GET",
                  `/store/payment-providers?region_id=${A.region.id}`,
                  null,
                  {}
                )
              ).payment_providers.length,
              0
            )
            denied(
              await f.request(
                A.hostname,
                "POST",
                `/store/payment-collections/${cartA.collectionId}/payment-sessions`,
                { provider_id: providerId },
                buyerA.headers
              ),
              [400]
            )
            assert.equal(
              (
                await call(
                  B,
                  "GET",
                  `/store/payment-providers?region_id=${B.region.id}`,
                  null,
                  {}
                )
              ).payment_providers.length,
              1
            )
          } finally {
            await f.inStore(A, () => f.app.nativeApp.link.create(link))
          }
        }
      )
      await check(
        "native payment amount updates use new durable identities when amounts repeat",
        async () => {
          for (const amount of [40, 30, 40, 30]) {
            await f.inStore(A, async () => {
              const session =
                await f.app.nativeApp.modules.payment.retrievePaymentSession(
                  cartA.session.id
                )
              await f.app.nativeApp.modules.payment.updatePaymentSession({
                id: session.id,
                data: session.data,
                amount,
                currency_code: "usd",
              })
            })
            assert.equal(
              stripe.intent("alpha", cartA.intentId).amount,
              amount * 100
            )
          }
          const bound = (
            await f.db.query(
              "SELECT amount,update_revision,update_amount FROM saas_payment_binding WHERE id=$1",
              [cartA.session.id]
            )
          ).rows[0]
          assert.equal(Number(bound.amount), 30)
          assert.equal(bound.update_revision, 4)
          assert.equal(bound.update_amount, null)
        }
      )
      await check(
        "native completion authorizes payment and reserves the correct store's inventory",
        async () => {
          stripe.confirm("alpha", cartA.intentId)
          stripe.confirm("bravo", cartB.intentId)
          orderA = (await complete(A, cartA)).order
          orderB = (await complete(B, cartB)).order
          const nativeA = await call(A, "GET", `/admin/orders/${orderA.id}`),
            nativeB = await call(B, "GET", `/admin/orders/${orderB.id}`)
          paymentA = nativeA.order.payment_collections[0].payments[0]
          paymentB = nativeB.order.payment_collections[0].payments[0]
          assert.equal(paymentA.amount, 30)
          assert.equal(paymentB.amount, 42)
          assert.equal((await level(A)).reserved_quantity, 1)
          assert.equal((await level(B)).reserved_quantity, 1)
          assert.equal((await complete(A, cartA)).order.id, orderA.id)
        }
      )
      await check(
        "capture refuses foreign identities, altered amounts and partial capture",
        async () => {
          denied(
            await f.request(
              A.hostname,
              "POST",
              `/admin/payments/${paymentB.id}/capture`,
              {},
              { ...owner(A), "idempotency-key": "m4-foreign-capture" }
            ),
            [404]
          )
          denied(
            await f.request(
              B.hostname,
              "POST",
              `/admin/payments/${paymentA.id}/capture`,
              {},
              { ...owner(A), "idempotency-key": "m4-foreign-capture-b" }
            ),
            [401]
          )
          denied(
            await f.request(
              A.hostname,
              "POST",
              `/admin/payments/${paymentA.id}/capture`,
              { amount: 10 },
              { ...owner(A), "idempotency-key": "m4-partial-capture" }
            ),
            [400]
          )
          denied(
            await f.request(
              A.hostname,
              "POST",
              `/admin/payments/${paymentA.id}/capture`,
              {},
              { ...buyerA.headers, "idempotency-key": "m4-buyer-capture" }
            ),
            [401, 403]
          )
        }
      )
      await check(
        "full native capture is durable and duplicate requests do not charge twice",
        async () => {
          const path = `/admin/payments/${paymentA.id}/capture`
          const first = await mutate(A, path, {}, "m4-capture-alpha"),
            duplicate = await mutate(A, path, {}, "m4-capture-alpha")
          assert.deepEqual(first, duplicate)
          assert.equal(first.payment.captures.length, 1)
          assert.equal(
            stripe.calls.filter(
              (c) =>
                c.account === stripe.config("alpha").account_id &&
                c.path.endsWith("/capture")
            ).length,
            1
          )
          denied(
            await f.request(
              A.hostname,
              "POST",
              path,
              { amount: 30 },
              { ...owner(A), "idempotency-key": "m4-capture-alpha" }
            ),
            [409]
          )
          await mutate(
            B,
            `/admin/payments/${paymentB.id}/capture`,
            {},
            "m4-capture-bravo"
          )
        }
      )
      await check(
        "partial and full refunds affect only their merchant account and native order totals",
        async () => {
          const path = `/admin/payments/${paymentA.id}/refund`
          const partial = await mutate(
            A,
            path,
            { amount: 10, note: "M4 partial refund" },
            "m4-refund-alpha-10"
          )
          assert.equal(
            partial.payment.refunds.reduce((sum, row) => sum + row.amount, 0),
            10
          )
          assert.deepEqual(
            await mutate(
              A,
              path,
              { amount: 10, note: "M4 partial refund" },
              "m4-refund-alpha-10"
            ),
            partial
          )
          denied(
            await f.request(
              A.hostname,
              "POST",
              path,
              { amount: 21 },
              { ...owner(A), "idempotency-key": "m4-refund-over" }
            ),
            [400]
          )
          denied(
            await f.request(
              B.hostname,
              "POST",
              path,
              { amount: 1 },
              { ...owner(B), "idempotency-key": "m4-refund-foreign" }
            ),
            [404]
          )
          const full = await mutate(
            A,
            path,
            { amount: 20 },
            "m4-refund-alpha-20"
          )
          assert.equal(
            full.payment.refunds.reduce((sum, row) => sum + row.amount, 0),
            30
          )
          const native = await call(A, "GET", `/admin/orders/${orderA.id}`)
          assert.equal(native.order.payment_status, "refunded")
          assert.equal(
            [
              ...stripe.accounts
                .get(stripe.config("bravo").api_key)
                .refunds.values(),
            ].length,
            0
          )
        }
      )
      await check(
        "all five M4 business tables enforce SQL ownership on pooled connections",
        async () => {
          for (const table of require("./migrations/0006-payments.cjs")
            .tables) {
            const rows = await f.inStore(A, () =>
              tenantSQL(f.app.pool, (c) =>
                c.query(`SELECT tenant_id FROM ${table}`)
              )
            )
            assert(rows.rows.every((row) => row.tenant_id === A.id))
          }
          const none = await f.app.pool.query(
            "SELECT count(*)::integer AS count FROM saas_payment_credential"
          )
          assert.equal(none.rows[0].count, 0)
        }
      )
      await check(
        "business metrics reconcile native captures and refunds separately per tenant",
        async () => {
          const a = (await call(A, "GET", "/admin/saas/metrics"))
            .currency_totals[0]
          const b = (await call(B, "GET", "/admin/saas/metrics"))
            .currency_totals[0]
          assert.equal(a.orders, 1)
          assert.equal(Number(a.captured_amount), 30)
          assert.equal(Number(a.refunded_amount), 30)
          assert.equal(Number(a.net_received), 0)
          assert.equal(b.orders, 1)
          assert.equal(Number(b.captured_amount), 42)
          assert.equal(Number(b.refunded_amount), 0)
        }
      )
      await check(
        "manual fulfillment and shipment use native inventory movements and ownership checks",
        async () => {
          const body = {
            location_id: B.location.id,
            items: orderB.items.map((item) => ({
              id: item.id,
              quantity: item.quantity,
            })),
          }
          denied(
            await f.request(
              B.hostname,
              "POST",
              `/admin/orders/${orderB.id}/fulfillments`,
              { ...body, location_id: A.location.id },
              { ...owner(B), "idempotency-key": "m4-foreign-location" }
            ),
            [404]
          )
          denied(
            await f.request(
              B.hostname,
              "POST",
              `/admin/orders/${orderB.id}/fulfillments`,
              { ...body, items: [{ id: orderA.items[0].id, quantity: 1 }] },
              { ...owner(B), "idempotency-key": "m4-foreign-item" }
            ),
            [404]
          )
          const response = await mutate(
            B,
            `/admin/orders/${orderB.id}/fulfillments`,
            body,
            "m4-fulfill-bravo"
          )
          await f.db.query(
            "UPDATE saas_payment_operation SET state='pending',result=NULL WHERE tenant_id=$1 AND idempotency_key='m4-fulfill-bravo'",
            [B.id]
          )
          const duplicate = await mutate(
            B,
            `/admin/orders/${orderB.id}/fulfillments`,
            body,
            "m4-fulfill-bravo"
          )
          assert.deepEqual(response, duplicate)
          assert.equal(response.order.fulfillments.length, 1)
          const fulfillment = response.order.fulfillments[0]
          const shipment = {
            items: body.items,
            labels: [
              {
                tracking_number: "M4-TRACK-BRAVO",
                tracking_url: "https://tracking.example.test/bravo",
                label_url: "https://labels.example.test/bravo",
              },
            ],
          }
          const shipped = await mutate(
            B,
            `/admin/orders/${orderB.id}/fulfillments/${fulfillment.id}/shipments`,
            shipment,
            "m4-ship-bravo"
          )
          assert(shipped.order.fulfillments[0].shipped_at)
          assert.equal((await level(B)).stocked_quantity, 2)
          assert.equal((await level(B)).reserved_quantity, 0)
          assert.deepEqual(
            await mutate(
              B,
              `/admin/orders/${orderB.id}/fulfillments/${fulfillment.id}/shipments`,
              shipment,
              "m4-ship-bravo"
            ),
            shipped
          )
          denied(
            await f.request(
              A.hostname,
              "POST",
              `/admin/orders/${orderA.id}/fulfillments/${fulfillment.id}/shipments`,
              {
                items: orderA.items.map((item) => ({
                  id: item.id,
                  quantity: item.quantity,
                })),
              },
              { ...owner(A), "idempotency-key": "m4-foreign-fulfillment" }
            ),
            [404]
          )
          denied(
            await f.request(
              B.hostname,
              "POST",
              `/admin/orders/${orderB.id}/cancel`,
              {},
              { ...owner(B), "idempotency-key": "m4-cancel-shipped" }
            ),
            [400, 409]
          )
        }
      )
      await check(
        "canceling an unfulfilled native order releases reservation once",
        async () => {
          const response = await mutate(
            A,
            `/admin/orders/${orderA.id}/cancel`,
            {},
            "m4-cancel-alpha"
          )
          assert.equal(response.order.status, "canceled")
          assert.equal((await level(A)).reserved_quantity, 0)
          await f.db.query(
            "UPDATE saas_payment_operation SET state='pending',result=NULL WHERE tenant_id=$1 AND idempotency_key='m4-cancel-alpha'",
            [A.id]
          )
          assert.deepEqual(
            await mutate(
              A,
              `/admin/orders/${orderA.id}/cancel`,
              {},
              "m4-cancel-alpha"
            ),
            response
          )
          assert.equal(
            stripe.accounts.get(stripe.config("alpha").api_key).refunds.size,
            2
          )
        }
      )
      await check(
        "canceled manual fulfillment restores stock and order cancellation releases its renewed reservation",
        async () => {
          const created = await cart(A, buyerA)
          stripe.confirm("alpha", created.intentId)
          const order = (await complete(A, created)).order
          const items = order.items.map((row) => ({
            id: row.id,
            quantity: row.quantity,
          }))
          const fulfilled = await mutate(
            A,
            `/admin/orders/${order.id}/fulfillments`,
            { items, location_id: A.location.id },
            "m4-fulfill-cancel-create"
          )
          const id = fulfilled.order.fulfillments[0].id
          const canceled = await mutate(
            A,
            `/admin/orders/${order.id}/fulfillments/${id}/cancel`,
            {},
            "m4-fulfill-cancel"
          )
          assert(canceled.order.fulfillments[0].canceled_at)
          assert.equal((await level(A)).stocked_quantity, 3)
          assert.equal((await level(A)).reserved_quantity, 1)
          await mutate(
            A,
            `/admin/orders/${order.id}/cancel`,
            {},
            "m4-cancel-restored-fulfillment"
          )
          assert.equal((await level(A)).reserved_quantity, 0)
        }
      )
      await check(
        "a failed post-provider refund resumes without duplicate money or credit lines",
        async () => {
          const module = f.app.nativeApp.modules.payment,
            original = module.refundPayment
          let crash = true
          module.refundPayment = async (...args) => {
            const result = await original(...args)
            if (crash) {
              crash = false
              throw new Error("Fixture crash after native refund commit")
            }
            return result
          }
          const path = `/admin/payments/${paymentB.id}/refund`,
            body = { amount: 5 }
          const failed = await f.request(B.hostname, "POST", path, body, {
            ...owner(B),
            "idempotency-key": "m4-refund-crash",
          })
          assert.equal(failed.status, 500)
          module.refundPayment = original
          const repaired = await mutate(B, path, body, "m4-refund-crash")
          assert.equal(repaired.payment.refunds.length, 1)
          assert.equal(
            stripe.accounts.get(stripe.config("bravo").api_key).refunds.size,
            1
          )
          const order = (await call(B, "GET", `/admin/orders/${orderB.id}`))
            .order
          assert.equal(order.credit_lines.length, 1)
          const operation = (
            await f.db.query(
              "SELECT id FROM saas_payment_operation WHERE tenant_id=$1 AND idempotency_key='m4-refund-crash'",
              [B.id]
            )
          ).rows[0]
          assert.equal(order.credit_lines[0].reference_id, operation.id)
          // Simulate losing the final operation acknowledgement after the entire native workflow committed.
          await f.db.query(
            "UPDATE saas_payment_operation SET state='pending',result=NULL WHERE id=$1",
            [operation.id]
          )
          await mutate(B, path, body, "m4-refund-crash")
          const after = (await call(B, "GET", `/admin/orders/${orderB.id}`))
            .order
          assert.equal(after.credit_lines.length, 1)
          assert.equal(
            stripe.accounts.get(stripe.config("bravo").api_key).refunds.size,
            1
          )
        }
      )
      await check(
        "provider failure rolls back its native refund row and the same key can retry",
        async () => {
          stripe.failNext("bravo", "/v1/refunds")
          const path = `/admin/payments/${paymentB.id}/refund`,
            body = { amount: 1 }
          const failed = await f.request(B.hostname, "POST", path, body, {
            ...owner(B),
            "idempotency-key": "m4-refund-transient",
          })
          assert.equal(failed.status, 500)
          const before = (await call(B, "GET", `/admin/orders/${orderB.id}`))
            .order.payment_collections[0].payments[0]
          assert.equal(before.refunds.length, 1)
          const recovered = await mutate(B, path, body, "m4-refund-transient")
          assert.equal(recovered.payment.refunds.length, 2)
          assert.equal(
            stripe.accounts.get(stripe.config("bravo").api_key).refunds.size,
            2
          )
        }
      )
      await check(
        "a pending vendor refund is recorded only after settlement and never repeated",
        async () => {
          stripe.pendNextRefund("bravo")
          const path = `/admin/payments/${paymentB.id}/refund`,
            body = { amount: 1 }
          assert.equal(
            (
              await f.request(B.hostname, "POST", path, body, {
                ...owner(B),
                "idempotency-key": "m4-refund-pending",
              })
            ).status,
            500
          )
          const native = (await call(B, "GET", `/admin/orders/${orderB.id}`))
            .order.payment_collections[0].payments[0]
          assert.equal(native.refunds.length, 2)
          stripe.settleRefunds("bravo")
          const refund = [
            ...stripe.accounts
              .get(stripe.config("bravo").api_key)
              .refunds.values(),
          ].at(-1)
          const event = {
            id: "evt_m4refundsettled",
            type: "refund.updated",
            livemode: false,
            data: { object: refund },
          }
          const payload = JSON.stringify(event),
            header = Stripe.webhooks.generateTestHeaderString({
              payload,
              secret: stripe.config("bravo").webhook_secret,
            })
          const config = (await call(B, "GET", "/admin/saas/payments")).payment
          assert(
            f.ok(
              await f.request(
                B.hostname,
                "POST",
                new URL(config.webhook_url).pathname,
                Buffer.from(payload),
                { "stripe-signature": header }
              )
            ).processed
          )
          const complete = await mutate(B, path, body, "m4-refund-pending")
          assert.equal(complete.payment.refunds.length, 3)
          assert.equal(
            stripe.accounts.get(stripe.config("bravo").api_key).refunds.size,
            3
          )
          denied(
            await f.request(
              B.hostname,
              "POST",
              path,
              { amount: 0.001 },
              { ...owner(B), "idempotency-key": "m4-refund-precision" }
            ),
            [400]
          )
        }
      )
      await check(
        "competing native checkouts cannot reserve the last item twice",
        async () => {
          await call(
            A,
            "POST",
            `/admin/inventory-items/${A.inventory.id}/location-levels/${A.location.id}`,
            { stocked_quantity: 1 }
          )
          const [first, second] = await Promise.all([
            cart(A, buyerA),
            cart(A, buyerA),
          ])
          stripe.confirm("alpha", first.intentId)
          stripe.confirm("alpha", second.intentId)
          const results = await Promise.all([
            f.request(
              A.hostname,
              "POST",
              `/store/carts/${first.id}/complete`,
              {},
              { ...first.headers, "idempotency-key": "m4-last-first" }
            ),
            f.request(
              A.hostname,
              "POST",
              `/store/carts/${second.id}/complete`,
              {},
              { ...second.headers, "idempotency-key": "m4-last-second" }
            ),
          ])
          assert.equal(
            results.filter((r) => r.status === 200).length,
            1,
            JSON.stringify(
              results.map((r) => ({ status: r.status, code: r.body.code }))
            )
          )
          assert.equal(results.filter((r) => r.status === 409).length, 1)
          assert.equal((await level(A)).reserved_quantity, 1)
          const winner = results.find((r) => r.status === 200).body.order
          const before = stripe.calls.filter((r) =>
            r.path.endsWith("/capture")
          ).length
          await mutate(
            A,
            `/admin/orders/${winner.id}/cancel`,
            {},
            "m4-last-cancel"
          )
          assert.equal((await level(A)).reserved_quantity, 0)
          assert.equal((await level(A)).stocked_quantity, 1)
          assert.equal(
            stripe.calls.filter((r) => r.path.endsWith("/capture")).length,
            before
          )
        }
      )
      await check(
        "failed payment authorization compensates native reservations and cart completion",
        async () => {
          const pending = await cart(A, buyerA)
          const response = await f.request(
            A.hostname,
            "POST",
            `/store/carts/${pending.id}/complete`,
            {},
            { ...pending.headers, "idempotency-key": "m4-no-authorization" }
          )
          assert.equal(response.status, 409)
          assert.equal((await level(A)).reserved_quantity, 0)
          const after = (
            await call(
              A,
              "GET",
              `/store/carts/${pending.id}`,
              null,
              buyerA.headers
            )
          ).cart
          assert.equal(after.completed_at, null)
          assert.equal(
            stripe.intent("alpha", pending.intentId).amount_received,
            0
          )
        }
      )
      const webhookPath = new URL(configA.webhook_url).pathname
      const eventFor = (
        cart,
        id,
        type = "payment_intent.amount_capturable_updated"
      ) => ({
        id,
        type,
        livemode: false,
        data: {
          object: JSON.parse(
            JSON.stringify(stripe.intent("alpha", cart.intentId))
          ),
        },
      })
      const postEvent = (
        event,
        {
          secret = stripe.config("alpha").webhook_secret,
          timestamp = Math.floor(Date.now() / 1000),
          host = A.hostname,
          path = webhookPath,
          header,
        } = {}
      ) => {
        const payload = JSON.stringify(event),
          signature =
            header ||
            Stripe.webhooks.generateTestHeaderString({
              payload,
              secret,
              timestamp,
            })
        return f.request(host, "POST", path, Buffer.from(payload), {
          "stripe-signature": signature,
        })
      }
      await check(
        "cart repricing cancels obsolete Stripe sessions and late callbacks cannot create orders",
        async () => {
          await call(
            A,
            "POST",
            `/admin/inventory-items/${A.inventory.id}/location-levels/${A.location.id}`,
            { stocked_quantity: 2 }
          )
          const changed = await cart(A, buyerA),
            obsolete = eventFor(changed, "evt_m4obsolete")
          const repriced = (
            await call(
              A,
              "POST",
              `/store/carts/${changed.id}/line-items/${changed.items[0].id}`,
              { quantity: 2 },
              buyerA.headers
            )
          ).cart
          assert.equal(repriced.total, 55)
          assert.equal(repriced.payment_collection.payment_sessions.length, 0)
          assert.equal(
            stripe.intent("alpha", changed.intentId).status,
            "canceled"
          )
          const ignored = f.ok(await postEvent(obsolete))
          assert.equal(ignored.reason, "session_closed")
          const fresh = (
            await call(
              A,
              "POST",
              `/store/payment-collections/${changed.collectionId}/payment-sessions`,
              { provider_id: providerId },
              buyerA.headers
            )
          ).payment_collection.payment_sessions[0]
          const binding = (
            await f.db.query(
              "SELECT intent_id FROM saas_payment_binding WHERE id=$1",
              [fresh.id]
            )
          ).rows[0]
          assert.equal(stripe.intent("alpha", binding.intent_id).amount, 5500)
          await call(
            A,
            "POST",
            `/store/carts/${changed.id}/line-items/${changed.items[0].id}`,
            { quantity: 1 },
            buyerA.headers
          )
          assert.equal(
            stripe.intent("alpha", binding.intent_id).status,
            "canceled"
          )
          await call(
            A,
            "POST",
            `/admin/inventory-items/${A.inventory.id}/location-levels/${A.location.id}`,
            { stocked_quantity: 1 }
          )
          assert.equal((await level(A)).reserved_quantity, 0)
        }
      )
      let callbackCart, callbackEvent, callbackOrder
      await check(
        "raw Stripe signature, freshness, merchant account, mode and session are mandatory",
        async () => {
          callbackCart = await cart(A, buyerA)
          stripe.confirm("alpha", callbackCart.intentId)
          callbackEvent = eventFor(callbackCart, "evt_m4authorized")
          denied(await postEvent(callbackEvent, { header: "t=1,v1=invalid" }), [
            400,
          ])
          denied(
            await postEvent(callbackEvent, {
              timestamp: Math.floor(Date.now() / 1000) - 360,
            }),
            [400]
          )
          denied(await postEvent({ ...callbackEvent, livemode: true }), [400])
          denied(
            await postEvent({
              ...callbackEvent,
              account: stripe.config("bravo").account_id,
            }),
            [400]
          )
          const configB = (await call(B, "GET", "/admin/saas/payments")).payment
          denied(
            await postEvent(callbackEvent, {
              host: B.hostname,
              path: new URL(configB.webhook_url).pathname,
              secret: stripe.config("bravo").webhook_secret,
            }),
            [400, 404]
          )
          const otherSession = {
            ...callbackEvent,
            data: {
              object: {
                ...callbackEvent.data.object,
                metadata: { session_id: cartB.session.id },
              },
            },
          }
          denied(await postEvent(otherSession), [400])
          assert.equal((await level(A)).reserved_quantity, 0)
        }
      )
      await check(
        "an authenticated vendor callback completes the native cart and is deduplicated",
        async () => {
          const first = f.ok(await postEvent(callbackEvent))
          assert(first.processed)
          const before = (
            await f.db.query(
              'SELECT count(*)::integer AS count FROM "order" WHERE tenant_id=$1 AND deleted_at IS NULL',
              [A.id]
            )
          ).rows[0].count
          const duplicate = f.ok(await postEvent(callbackEvent))
          assert(duplicate.duplicate)
          assert.equal(
            (
              await f.db.query(
                'SELECT count(*)::integer AS count FROM "order" WHERE tenant_id=$1 AND deleted_at IS NULL',
                [A.id]
              )
            ).rows[0].count,
            before
          )
          const linked = (
            await f.db.query(
              "SELECT order_id FROM order_cart WHERE tenant_id=$1 AND cart_id=$2",
              [A.id, callbackCart.id]
            )
          ).rows[0]
          assert(linked)
          callbackOrder = (
            await call(A, "GET", `/admin/orders/${linked.order_id}`)
          ).order
          assert.equal((await level(A)).reserved_quantity, 1)
          assert.equal(
            (await complete(A, callbackCart)).order.id,
            callbackOrder.id
          )
          denied(
            await postEvent({
              ...callbackEvent,
              type: "payment_intent.created",
            }),
            [409]
          )
        }
      )
      await check(
        "out-of-order events use current vendor state and never capture twice",
        async () => {
          const payment = callbackOrder.payment_collections[0].payments[0]
          await mutate(
            A,
            `/admin/payments/${payment.id}/capture`,
            {},
            "m4-webhook-capture"
          )
          const before = stripe.calls.filter((r) =>
            r.path.endsWith("/capture")
          ).length
          const stale = {
            ...callbackEvent,
            id: "evt_m4stalecreated",
            type: "payment_intent.created",
            data: {
              object: {
                ...callbackEvent.data.object,
                status: "requires_payment_method",
              },
            },
          }
          const result = f.ok(await postEvent(stale))
          assert.equal(result.status, "captured")
          assert.equal(
            stripe.calls.filter((r) => r.path.endsWith("/capture")).length,
            before
          )
          const ignored = f.ok(
            await postEvent({
              ...stale,
              id: "evt_m4staleamount",
              data: { object: { ...stale.data.object, amount: 1 } },
            })
          )
          assert(ignored.ignored)
          await mutate(
            A,
            `/admin/orders/${callbackOrder.id}/cancel`,
            {},
            "m4-webhook-cancel"
          )
          assert.equal((await level(A)).reserved_quantity, 0)
          const closed = f.ok(
            await postEvent({ ...stale, id: "evt_m4aftercancel" })
          )
          assert(closed.ignored)
          assert(["order_closed", "payment_closed"].includes(closed.reason))
        }
      )
      await check(
        "webhook retries survive a real application restart with the same tenant credential",
        async () => {
          const retryCart = await cart(A, buyerA)
          stripe.confirm("alpha", retryCart.intentId)
          const event = eventFor(retryCart, "evt_m4restart")
          stripe.failNext("alpha", `/v1/payment_intents/${retryCart.intentId}`)
          const response = await postEvent(event)
          assert.equal(response.status, 500)
          const job = (
            await f.db.query(
              "SELECT id,state FROM saas_job WHERE tenant_id=$1 AND kind='m4.stripe.event' AND payload->'event'->>'id'=$2",
              [A.id, event.id]
            )
          ).rows[0]
          assert.equal(job.state, "pending")
          await f.restart()
          await f.db.query(
            "UPDATE saas_control.task_dispatch SET available_at=now() WHERE id=$1",
            [job.id]
          )
          const done = await f.app.m2Runtime.jobs.processNext({ jobId: job.id })
          assert.equal(done.state, "done")
          assert(f.ok(await postEvent(event)).duplicate)
          assert.equal((await level(A)).reserved_quantity, 1)
          const linked = (
            await f.db.query(
              "SELECT order_id FROM order_cart WHERE tenant_id=$1 AND cart_id=$2",
              [A.id, retryCart.id]
            )
          ).rows[0]
          await mutate(
            A,
            `/admin/orders/${linked.order_id}/cancel`,
            {},
            "m4-restart-cancel"
          )
          assert.equal((await level(A)).reserved_quantity, 0)
        }
      )
      await check(
        "credential rotation pins old sessions and publishes the new key only to new sessions",
        async () => {
          const old = await cart(A, buyerA),
            rotation = stripe.rotate("alpha")
          const updated = (
            await call(A, "POST", "/admin/saas/payments", rotation)
          ).payment
          assert.equal(updated.publishable_key, rotation.publishable_key)
          assert.notEqual(updated.webhook_url, configA.webhook_url)
          stripe.confirm("alpha", old.intentId)
          const event = eventFor(old, "evt_m4oldcredential")
          assert(f.ok(await postEvent(event)).processed)
          const linked = (
            await f.db.query(
              "SELECT order_id FROM order_cart WHERE tenant_id=$1 AND cart_id=$2",
              [A.id, old.id]
            )
          ).rows[0]
          const oldOrder = (
            await call(A, "GET", `/admin/orders/${linked.order_id}`)
          ).order
          await mutate(
            A,
            `/admin/payments/${oldOrder.payment_collections[0].payments[0].id}/capture`,
            {},
            "m4-old-credential-capture"
          )
          await mutate(
            A,
            `/admin/orders/${oldOrder.id}/cancel`,
            {},
            "m4-old-credential-cancel"
          )
          const fresh = await cart(A, buyerA)
          assert.equal(
            fresh.session.data.publishable_key,
            rotation.publishable_key
          )
          assert.equal(
            (await call(B, "GET", "/store/saas/payments", null, {})).payment
              .publishable_key,
            stripe.config("bravo").publishable_key
          )
          const credentials = (
            await f.db.query(
              "SELECT id,active FROM saas_payment_credential WHERE tenant_id=$1",
              [A.id]
            )
          ).rows
          assert.equal(credentials.filter((row) => row.active).length, 1)
          assert.equal(credentials.length, 2)
        }
      )
      await check(
        "out-of-band refunds are flagged for the correct merchant without inventing native entries",
        async () => {
          const external = await stripe
            .factory(stripe.config("bravo").api_key)
            .refunds.create({ payment_intent: cartB.intentId, amount: 100 })
          const event = {
            id: "evt_m4externalrefund",
            type: "refund.updated",
            livemode: false,
            data: { object: external },
          }
          const payload = JSON.stringify(event),
            signature = Stripe.webhooks.generateTestHeaderString({
              payload,
              secret: stripe.config("bravo").webhook_secret,
            })
          const config = (await call(B, "GET", "/admin/saas/payments")).payment
          const result = f.ok(
            await f.request(
              B.hostname,
              "POST",
              new URL(config.webhook_url).pathname,
              Buffer.from(payload),
              { "stripe-signature": signature }
            )
          )
          assert(result.review_required)
          const b = await call(B, "GET", "/admin/saas/metrics"),
            a = await call(A, "GET", "/admin/saas/metrics")
          assert.equal(b.payment_attention.review_required, 1)
          assert.equal(a.payment_attention.review_required, 0)
          assert.equal(Number(b.currency_totals[0].refunded_amount), 7)
        }
      )
      if (process.env.SAAS_M4_RESULT)
        fs.writeFileSync(
          process.env.SAAS_M4_RESULT,
          JSON.stringify(
            {
              success: true,
              transport:
                "owned loopback Stripe protocol fixture, real native provider and SDK",
              checks,
            },
            null,
            2
          ) + "\n"
        )
    } finally {
      if (f) await f.close()
      await stripe.close()
    }
  }
)
