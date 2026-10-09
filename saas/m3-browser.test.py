"""Real native Admin + production Next.js + PostgreSQL, over two TLS Hosts.

Run after build-m3.sh. Never saves browser storage, authentication traces or keys.
SAAS_M3_READY_FILE can attach to a disposable fixture for debugging; normally
this runner owns its fixture process and shuts it down in finally.
"""
import base64
import json
import os
from pathlib import Path
import selectors
import subprocess
import time
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path(os.environ.get("SAAS_M3_EVIDENCE_DIR", "/tmp/medusa-m3-browser-evidence"))
OUTPUT.mkdir(parents=True, exist_ok=True)
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=")
results, errors = [], []
completed = False


def check(name, function):
    function()
    results.append({"name": name, "passed": True})
    print("PASS", name, flush=True)


def ready_fixture():
    if os.environ.get("SAAS_M3_READY_FILE"):
        lines = Path(os.environ["SAAS_M3_READY_FILE"]).read_text().splitlines()
        return next(json.loads(line) for line in lines if line.startswith('{"ready":')), None, None
    if os.environ.get("SAAS_M3_TEST_RESET") != "1":
        raise RuntimeError("SAAS_M3_TEST_RESET=1 is required for the marked disposable M3 database")
    log = (OUTPUT / "browser-services.log").open("w")
    process = subprocess.Popen(["node", "saas/m3-browser-fixture.cjs"], cwd=ROOT, env=os.environ.copy(),
                               stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("Browser fixture startup failed; see browser-services.log")
        for key, _ in selector.select(timeout=0.5):
            line = key.fileobj.readline()
            if line.startswith('{"ready":'):
                selector.close()
                return json.loads(line), process, log
    process.terminate()
    raise RuntimeError("Browser fixture startup timed out")


ready, process, fixture_log = ready_fixture()
origins = {tenant["slug"]: f"https://{tenant['hostname']}:{ready['port']}" for tenant in ready["tenants"]}
email, password = ready["credentials"]["email"], ready["credentials"]["password"]


def api(page, method, path, data=None, headers=None):
    return page.evaluate("""async ({method,path,data,headers}) => {
        const response = await fetch(path, {method, credentials:'same-origin',
            headers:{...headers,...(data === null ? {} : {'content-type':'application/json'})},
            ...(data === null ? {} : {body:JSON.stringify(data)})});
        return {status:response.status,body:await response.json()};
    }""", {"method": method, "path": path, "data": data, "headers": headers or {}})


def login_owner(page, slug):
    page.goto(origins[slug] + "/app/login", wait_until="domcontentloaded")
    page.locator("input[name=email]").fill(email)
    page.locator("input[name=password]").fill(password)
    page.get_by_role("button", name="Continue with Email", exact=True).click()
    page.wait_for_url(lambda url: url.endswith("/app/orders") or url.endswith("/app/products"))
    page.goto(origins[slug] + "/app/orders", wait_until="domcontentloaded")
    expect(page.get_by_text("No records", exact=True)).to_be_visible()


def signup_buyer(page, slug):
    page.goto(origins[slug] + "/us/account", wait_until="domcontentloaded")
    page.get_by_test_id("register-button").click()
    page.get_by_test_id("first-name-input").fill("Browser")
    page.get_by_test_id("last-name-input").fill("Buyer")
    page.get_by_test_id("email-input").fill("browser-buyer@example.test")
    page.get_by_test_id("password-input").fill(password)
    page.get_by_test_id("register-page").get_by_test_id("register-button").click()
    expect(page.get_by_test_id("account-nav")).to_be_visible()


def checkout(page, slug):
    page.goto(origins[slug] + "/us/products/cotton-shirt", wait_until="domcontentloaded")
    expect(page.get_by_test_id("product-price")).to_have_attribute("data-value", "25" if slug == "alpha" else "37")
    page.get_by_test_id("add-product-button").click()
    expect(page.get_by_test_id("add-product-button")).to_be_enabled()
    page.goto(origins[slug] + "/us/cart", wait_until="domcontentloaded")
    expect(page.get_by_test_id("cart-container")).to_be_visible()
    page.get_by_test_id("checkout-button").click()
    page.wait_for_url("**/checkout?step=address")
    for key, value in {"shipping-first-name-input": "Browser", "shipping-last-name-input": "Buyer",
                       "shipping-address-input": "1 Test St", "shipping-postal-code-input": "02110",
                       "shipping-city-input": "Boston"}.items():
        page.get_by_test_id(key).fill(value)
    page.get_by_test_id("shipping-country-select").select_option("us")
    page.get_by_test_id("shipping-email-input").fill("browser-buyer@example.test")
    page.get_by_test_id("submit-address-button").click()
    expect(page.get_by_test_id("delivery-options-container")).to_be_visible()
    page.get_by_test_id("delivery-option-radio").first.click()
    try:
        expect(page.get_by_test_id("submit-delivery-option-button")).to_be_enabled(timeout=15000)
    except AssertionError:
        # Never print cookie/JWT values. Compare persisted shipping state to UI.
        jar = page.context.cookies(origins[slug])
        cart_id = next(cookie["value"] for cookie in jar if cookie["name"] == "_medusa_cart_id")
        jwt = next(cookie["value"] for cookie in jar if cookie["name"] == "_medusa_jwt")
        response = api(page, "GET", "/store/carts/" + cart_id, headers={"authorization": "Bearer " + jwt})
        print("Delivery failure state:", json.dumps({"status": response["status"],
            "persistedShippingMethods": len(response["body"].get("cart", {}).get("shipping_methods", [])),
            "uiError": page.get_by_test_id("delivery-option-error-message").all_text_contents()}), flush=True)
        raise
    page.get_by_test_id("submit-delivery-option-button").click()
    expect(page.get_by_test_id("submit-payment-button")).to_be_visible()
    page.get_by_role("radio", name="Test payment", exact=False).click()
    page.get_by_test_id("submit-payment-button").click()
    expect(page.get_by_test_id("submit-order-button")).to_be_enabled()
    page.get_by_test_id("submit-order-button").click()
    page.wait_for_url("**/order/*/confirmed", timeout=30000)
    expect(page.get_by_test_id("order-complete-container")).to_be_visible()
    order_id = page.url.split("/order/")[1].split("/")[0]
    expect(page.get_by_test_id("order-email")).to_have_text("browser-buyer@example.test")
    expect(page.get_by_test_id("shipping-method-summary")).to_contain_text("$5.00")
    expect(page.get_by_test_id("payment-amount")).to_contain_text("Authorized")
    expect(page.get_by_test_id("payment-amount")).to_contain_text("no funds transferred")
    expect(page.get_by_test_id("payment-amount")).not_to_contain_text("paid at")
    page.reload(wait_until="domcontentloaded")
    expect(page.get_by_test_id("order-complete-container")).to_be_visible()
    page.screenshot(path=str(OUTPUT / f"{slug}-order-confirmed.png"), full_page=True)
    page.goto(origins[slug] + "/us/account/orders", wait_until="domcontentloaded")
    expect(page.get_by_text("Cotton Shirt", exact=False).first).to_be_visible()
    return order_id


try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get("SAAS_M3_CHROMIUM", "/usr/bin/chromium"),
            args=["--no-sandbox", "--no-proxy-server", "--host-resolver-rules=MAP *.shops.example.test 127.0.0.1"])
        context = browser.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 1000})
        alpha, bravo = context.new_page(), context.new_page()
        for page in [alpha, bravo]:
            page.on("pageerror", lambda error: errors.append(str(error)))
        alpha.goto(origins["alpha"] + "/app/login", wait_until="domcontentloaded")
        # Wait for the production Next child, independently of backend readiness.
        for attempt in range(30):
            response = bravo.goto(origins["bravo"] + "/us", wait_until="domcontentloaded")
            if response.status == 200:
                break
            bravo.wait_for_timeout(300)
        else:
            raise RuntimeError("Production storefront failed to start")

        check("native Admin login over HTTPS and Secure host-only owner sessions", lambda: login_owner(alpha, "alpha"))
        owner_cookie = next(cookie for cookie in context.cookies(origins["alpha"]) if cookie["name"] == "medusa.saas.sid")
        assert owner_cookie["secure"] and owner_cookie["httpOnly"] and owner_cookie["domain"] == "alpha.shops.example.test"
        check("sibling Admin is unauthenticated before its own login", lambda: (
            bravo.goto(origins["bravo"] + "/app/products", wait_until="domcontentloaded"),
            expect(bravo.locator("input[name=email]")).to_be_visible()))
        check("second native Admin login using the same email", lambda: login_owner(bravo, "bravo"))

        def owner_products():
            alpha.goto(origins["alpha"] + "/app/products", wait_until="domcontentloaded")
            expect(alpha.get_by_text("Alpha Cotton Shirt", exact=True)).to_be_visible()
            expect(alpha.get_by_text("Bravo Cotton Shirt", exact=True)).to_have_count(0)
            alpha.goto(origins["alpha"] + "/app/products/" + ready["tenants"][0]["productId"], wait_until="domcontentloaded")
            expect(alpha.get_by_role("heading", name="Alpha Cotton Shirt", exact=True)).to_be_visible()
            expect(alpha.get_by_text("SHARED-SKU", exact=True)).to_be_visible()
        check("native product list/detail and variant rows display only their store", owner_products)

        def native_product_create():
            alpha.goto(origins["alpha"] + "/app/products/create", wait_until="domcontentloaded")
            alpha.locator('input[name="title"]').fill("Alpha Browser Product")
            alpha.locator('input[name="handle"]').fill("browser-product")
            alpha.locator('input[type="file"]').set_input_files({"name": "product.png", "mimeType": "image/png", "buffer": PNG})
            alpha.get_by_role("button", name="Continue", exact=True).click()
            expect(alpha.get_by_role("tab", name="Organize", exact=True)).to_have_attribute("aria-selected", "true")
            alpha.get_by_role("button", name="Continue", exact=True).click()
            expect(alpha.get_by_role("tab", name="Variants", exact=True)).to_have_attribute("aria-selected", "true")
            alpha.locator('[role="gridcell"][data-column-index="2"]').dblclick()
            alpha.locator('input[data-field="variants.0.sku"]').fill("BROWSER-SKU")
            alpha.locator('[role="gridcell"][data-column-index="6"]').dblclick()
            alpha.locator('input[data-field="variants.0.prices.usd"]').fill("19")
            alpha.get_by_role("button", name="Publish", exact=True).click()
            alpha.wait_for_url(lambda url: "/app/products/prod_" in url)
            expect(alpha.get_by_role("heading", name="Alpha Browser Product", exact=True)).to_be_visible()
            expect(alpha.get_by_text("BROWSER-SKU", exact=True)).to_be_visible()
            alpha.screenshot(path=str(OUTPUT / "native-admin-created-product.png"), full_page=True)
            alpha.goto(origins["alpha"] + "/us/products/browser-product", wait_until="domcontentloaded")
            expect(alpha.get_by_role("heading", name="Alpha Browser Product", exact=True)).to_be_visible()
            expect(alpha.get_by_test_id("product-price")).to_have_attribute("data-value", "19")
            media = alpha.locator('img[src^="/store/media/"]')
            expect(media.first).to_be_visible()
            assert media.first.evaluate("image => image.complete && image.naturalWidth > 0")
            bravo.goto(origins["bravo"] + "/us/products/browser-product", wait_until="domcontentloaded")
            expect(bravo.get_by_role("heading", name="Alpha Browser Product", exact=True)).to_have_count(0)
        check("native product wizard publishes a variant, price and own image into its storefront", native_product_create)

        def native_inventory():
            alpha.goto(origins["alpha"] + "/app/inventory/create", wait_until="domcontentloaded")
            alpha.locator('input[name="title"]').fill("Browser Inventory")
            alpha.locator('input[name="sku"]').fill("BROWSER-STOCK")
            alpha.get_by_role("button", name="Next", exact=True).click()
            alpha.locator('[role="gridcell"][data-column-index="1"]').dblclick()
            alpha.locator('input[data-field="locations.' + ready["tenants"][0]["locationId"] + '"]').fill("11")
            alpha.locator('input[data-field="locations.' + ready["tenants"][0]["locationId"] + '"]').press("Tab")
            with alpha.expect_response(lambda response: response.request.method == "POST" and "/location-levels/batch" in response.url) as stock_response:
                alpha.get_by_role("button", name="Save", exact=True).click()
            stock = stock_response.value
            assert stock.status == 200, "Native inventory stock request: " + stock.text()
            alpha.wait_for_url(lambda url: url.endswith("/app/inventory"))
            expect(alpha.get_by_text("BROWSER-STOCK", exact=True)).to_be_visible()
            response = api(alpha, "GET", "/admin/inventory-items?sku=BROWSER-STOCK")
            assert response["status"] == 200 and len(response["body"]["inventory_items"]) == 1
            item = response["body"]["inventory_items"][0]
            levels = api(alpha, "GET", "/admin/inventory-items/" + item["id"] + "/location-levels")
            assert levels["status"] == 200 and levels["body"]["inventory_levels"][0]["stocked_quantity"] == 11, str(levels)
            alpha.goto(origins["alpha"] + "/app/inventory/" + item["id"] + "/locations/" + ready["tenants"][0]["locationId"], wait_until="domcontentloaded")
            alpha.locator('input[name="stocked_quantity"]').fill("23")
            alpha.get_by_role("button", name="Save", exact=True).click()
            expect(alpha.locator('input[name="stocked_quantity"]')).to_have_count(0)
            response = api(alpha, "GET", "/admin/inventory-items/" + item["id"] + "/location-levels")
            assert response["status"] == 200 and response["body"]["inventory_levels"][0]["stocked_quantity"] == 23
            location_row = alpha.get_by_role("row").filter(has_text=ready["tenants"][0]["locationName"])
            expect(location_row.get_by_text("23", exact=True)).to_have_count(2)
            expect(location_row.get_by_text("11", exact=True)).to_have_count(0)
            alpha.reload(wait_until="domcontentloaded")
            expect(location_row.get_by_text("23", exact=True)).to_have_count(2)
            alpha.screenshot(path=str(OUTPUT / "native-admin-inventory.png"), full_page=True)
            bravo.goto(origins["bravo"] + "/app/inventory", wait_until="domcontentloaded")
            expect(bravo.get_by_text("BROWSER-STOCK", exact=True)).to_have_count(0)
        check("native inventory form creates and adjusts single-warehouse stock", native_inventory)

        def brand_settings():
            alpha.goto(origins["alpha"] + "/app/storefront", wait_until="domcontentloaded")
            alpha.get_by_label("Store name", exact=True).fill("Alpha Browser Brand")
            alpha.get_by_label("Primary color", exact=True).fill("#135790")
            alpha.get_by_label("SEO description", exact=True).fill("Alpha browser tenant only")
            alpha.get_by_label("Logo", exact=True).set_input_files({"name": "logo.png", "mimeType": "image/png", "buffer": PNG})
            expect(alpha.locator('img[alt="Store logo"]')).to_be_visible()
            alpha.get_by_role("button", name="Save settings", exact=True).click()
            expect(alpha.get_by_text("Storefront settings saved", exact=True)).to_be_visible()
            alpha.reload(wait_until="domcontentloaded")
            expect(alpha.get_by_label("Store name", exact=True)).to_have_value("Alpha Browser Brand")
            alpha.screenshot(path=str(OUTPUT / "native-admin-storefront-settings.png"), full_page=True)
        check("native Admin extension saves brand, Logo, color and SEO with real uploads", brand_settings)

        def public_brands():
            alpha.goto(origins["alpha"] + "/", wait_until="domcontentloaded")
            expect(alpha).to_have_url(origins["alpha"] + "/us")
            expect(alpha.get_by_role("heading", name="Alpha Browser Brand", exact=True)).to_be_visible()
            assert alpha.title() == "Alpha Browser Brand"
            assert alpha.locator('meta[name="description"]').get_attribute("content") == "Alpha browser tenant only"
            assert alpha.locator('body').evaluate("element => getComputedStyle(element).getPropertyValue('--store-primary').trim()") == "#135790"
            bravo.goto(origins["bravo"] + "/us", wait_until="domcontentloaded")
            expect(bravo.get_by_role("heading", name="Bravo Shop", exact=True)).to_be_visible()
            expect(bravo.get_by_text("Alpha Browser Brand", exact=True)).to_have_count(0)
            alpha.screenshot(path=str(OUTPUT / "alpha-storefront-home.png"), full_page=True)
        check("Host-based root redirect, branding, SEO and image rendering differ between stores", public_brands)

        def catalog_cache():
            for _ in range(2):
                alpha.goto(origins["alpha"] + "/us/products/cotton-shirt", wait_until="domcontentloaded")
                bravo.goto(origins["bravo"] + "/us/products/cotton-shirt", wait_until="domcontentloaded")
                expect(alpha.get_by_test_id("product-price")).to_have_attribute("data-value", "25")
                expect(bravo.get_by_test_id("product-price")).to_have_attribute("data-value", "37")
                expect(alpha.locator('link[rel="canonical"]')).to_have_attribute("href", origins["alpha"] + "/us/products/cotton-shirt")
                expect(bravo.locator('link[rel="canonical"]')).to_have_attribute("href", origins["bravo"] + "/us/products/cotton-shirt")
                expect(alpha.get_by_role("heading", name="Alpha Cotton Shirt", exact=True)).to_be_visible()
                expect(bravo.get_by_role("heading", name="Bravo Cotton Shirt", exact=True)).to_be_visible()
        check("same-handle catalog and prices remain isolated across repeated server rendering", catalog_cache)

        # Separate consumer context proves customer and owner sessions are distinct.
        buyers = browser.new_context(ignore_https_errors=True, viewport={"width": 1280, "height": 1000})
        buyer_a, buyer_b = buyers.new_page(), buyers.new_page()
        for page in [buyer_a, buyer_b]:
            page.on("pageerror", lambda error: errors.append(str(error)))
        check("consumer registration through native server actions on Alpha", lambda: signup_buyer(buyer_a, "alpha"))
        check("same-email consumer registration on Bravo creates its own account", lambda: signup_buyer(buyer_b, "bravo"))
        consumer_cookie = next(cookie for cookie in buyers.cookies(origins["alpha"]) if cookie["name"] == "_medusa_jwt")
        assert consumer_cookie["secure"] and consumer_cookie["httpOnly"] and consumer_cookie["domain"] == "alpha.shops.example.test"
        order_a = checkout(buyer_a, "alpha")
        results.append({"name": "Alpha browser cart/address/shipping/test-payment/confirmation/history/reload", "passed": True})
        order_b = checkout(buyer_b, "bravo")
        results.append({"name": "Bravo browser checkout uses its own price, payment and order", "passed": True})
        assert order_a != order_b

        def owner_orders():
            alpha.goto(origins["alpha"] + "/app/orders", wait_until="domcontentloaded")
            expect(alpha.locator('a[href="/app/orders/' + order_a + '"]').first).to_be_visible()
            alpha.goto(origins["alpha"] + "/app/orders/" + order_a, wait_until="domcontentloaded")
            expect(alpha.get_by_text("Alpha Cotton Shirt", exact=True).first).to_be_visible()
            expect(alpha.get_by_text("Bravo Cotton Shirt", exact=True)).to_have_count(0)
            alpha.screenshot(path=str(OUTPUT / "native-admin-order-detail.png"), full_page=True)
            alpha.goto(origins["alpha"] + "/app/customers", wait_until="domcontentloaded")
            expect(alpha.get_by_text("browser-buyer@example.test", exact=True)).to_be_visible()
        check("native Admin order/customer lists and order details reflect browser checkout", owner_orders)

        def negative_sessions():
            stolen = browser.new_context(ignore_https_errors=True)
            stolen.add_cookies([{**consumer_cookie, "domain": "bravo.shops.example.test"}])
            page = stolen.new_page()
            page.goto(origins["bravo"] + "/app/login", wait_until="domcontentloaded")
            response = api(page, "GET", "/store/orders/" + order_a, headers={"authorization": "Bearer " + consumer_cookie["value"]})
            assert response["status"] in [401, 403, 404]
            page.goto(origins["bravo"] + "/us/account", wait_until="domcontentloaded")
            expect(page.get_by_test_id("login-page")).to_be_visible()
            stolen.close()
            owner_copy = browser.new_context(ignore_https_errors=True)
            owner_copy.add_cookies([{**owner_cookie, "domain": "bravo.shops.example.test"}])
            page = owner_copy.new_page()
            page.goto(origins["bravo"] + "/app/products", wait_until="domcontentloaded")
            expect(page.locator("input[name=email]")).to_be_visible()
            owner_copy.close()
            response = api(buyer_a, "GET", "/store/orders/" + order_b, headers={"authorization": "Bearer " + consumer_cookie["value"]})
            assert response["status"] == 404
        check("copied consumer JWT, copied owner cookie and foreign order ID fail across stores", negative_sessions)

        def mobile_store():
            mobile = browser.new_context(ignore_https_errors=True, viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
            page = mobile.new_page()
            page.goto(origins["alpha"] + "/us/store", wait_until="domcontentloaded")
            expect(page.get_by_text("Alpha Cotton Shirt", exact=True)).to_be_visible()
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
            page.goto(origins["alpha"] + "/us/products/cotton-shirt", wait_until="domcontentloaded")
            expect(page.get_by_test_id("add-product-button")).to_be_visible()
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
            page.screenshot(path=str(OUTPUT / "mobile-product.png"), full_page=True)
            mobile.close()
        check("fixed theme catalog and product page work at mobile width without overflow", mobile_store)

        def logout_login():
            buyer_a.goto(origins["alpha"] + "/us/account", wait_until="domcontentloaded")
            buyer_a.get_by_test_id("account-nav").get_by_test_id("logout-button").click()
            expect(buyer_a.get_by_test_id("login-page")).to_be_visible()
            buyer_a.get_by_test_id("email-input").fill("browser-buyer@example.test")
            buyer_a.get_by_test_id("password-input").fill(password)
            buyer_a.get_by_test_id("sign-in-button").click()
            expect(buyer_a.get_by_test_id("account-nav")).to_be_visible()
        check("consumer logout and subsequent login retain access only to the owning store", logout_login)
        assert not errors, "Unexpected browser runtime errors: " + "; ".join(errors)
        completed = True
        browser.close()
finally:
    (OUTPUT / "m3-browser.json").write_text(json.dumps({"milestone": "M3", "success": completed, "checks": results, "passed": len(results),
        "browserErrors": errors, "tlsIngress": True, "testPaymentOnly": True}, indent=2))
    if process:
        process.terminate()
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    if fixture_log:
        fixture_log.close()
