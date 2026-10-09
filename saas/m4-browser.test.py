"""Native Admin merchant actions and fixed storefront DTOs over owned TLS hosts.
Stripe SDK uses the owned protocol fixture; this never substitutes for vendor sandbox or Elements acceptance.
"""
import json
import os
from pathlib import Path
import selectors
import subprocess
import time
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path(os.environ.get("SAAS_M4_EVIDENCE_DIR", "/tmp/medusa-m4-browser-evidence"))
OUTPUT.mkdir(parents=True, exist_ok=True)
checks, errors = [], []
failures = []
completed = False
process = None
log = (OUTPUT / "m4-browser-services.log").open("w")

def check(name, task):
    task()
    checks.append({"name": name, "passed": True})
    print("PASS", name, flush=True)

try:
    if os.environ.get("SAAS_M4_TEST_RESET") != "1":
        raise RuntimeError("SAAS_M4_TEST_RESET=1 is required for the marked disposable M4 database")
    environment = dict(os.environ, SAAS_BROWSER_STAGE="M4", SAAS_M3_NEXT_PORT="8014")
    process = subprocess.Popen(["node", "saas/m3-browser-fixture.cjs"], cwd=ROOT, env=environment,
        stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    ready = None
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("M4 browser fixture failed; see m4-browser-services.log")
        for key, _ in selector.select(timeout=0.5):
            line = key.fileobj.readline()
            if line.startswith('{"ready":'):
                ready = json.loads(line)
                break
        if ready:
            break
    selector.close()
    if not ready:
        raise RuntimeError("M4 browser fixture timed out")
    origins = {row["slug"]: f"https://{row['hostname']}:{ready['port']}" for row in ready["tenants"]}
    tenants = {row["slug"]: row for row in ready["tenants"]}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get("SAAS_M3_CHROMIUM", "/usr/bin/chromium"),
            args=["--no-sandbox", "--no-proxy-server", "--host-resolver-rules=MAP *.shops.example.test 127.0.0.1"])
        context = browser.new_context(ignore_https_errors=True, viewport={"width": 1440, "height": 1150})
        # This direct browser connects exclusively to our owned loopback TLS fixtures.
        context.route("**/*", lambda route: route.continue_() if urlparse(route.request.url).hostname in
            {row["hostname"] for row in ready["tenants"]} else route.abort())
        alpha, bravo = context.new_page(), context.new_page()
        for page in [alpha, bravo]:
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("response", lambda response: failures.append({"path": urlparse(response.url).path, "status": response.status}) if response.status >= 400 else None)
        def login(page, slug):
            page.goto(origins[slug] + "/app/login", wait_until="domcontentloaded")
            page.locator('input[name="email"]').fill(ready["credentials"]["email"])
            page.locator('input[name="password"]').fill(ready["credentials"]["password"])
            page.get_by_role("button", name="Continue with Email", exact=True).click()
            page.wait_for_url(lambda url: "/app/login" not in url)
        check("native owner login uses independent Secure host-only sessions", lambda: (login(alpha, "alpha"), login(bravo, "bravo")))

        def configure():
            alpha.goto(origins["alpha"] + "/app/payments", wait_until="domcontentloaded")
            expect(alpha.get_by_text("Account: acct_alphaalphaalpha", exact=True)).to_be_visible()
            alpha.get_by_label("Stripe account ID", exact=True).fill("acct_alphaalphaalpha")
            alpha.get_by_label("Test secret key", exact=True).fill("sk_test_" + "alpha" * 6)
            alpha.get_by_label("Test publishable key", exact=True).fill("pk_test_" + "alpha" * 6)
            alpha.get_by_label("Webhook signing secret", exact=True).fill("whsec_" + "alpha" * 6)
            alpha.get_by_role("button", name="Rotate test credentials", exact=True).click()
            expect(alpha.get_by_text("Stripe test account saved", exact=True)).to_be_visible()
            expect(alpha.get_by_label("Test secret key", exact=True)).to_have_value("")
            alpha.screenshot(path=str(OUTPUT / "m4-native-payments-settings.png"), full_page=True)
            bravo.goto(origins["bravo"] + "/app/payments", wait_until="domcontentloaded")
            expect(bravo.get_by_text("Account: acct_bravobravobravo", exact=True)).to_be_visible()
            expect(bravo.get_by_text("Account: acct_alphaalphaalpha", exact=True)).to_have_count(0)
        check("native Payments form verifies and rotates the current store's test credentials", configure)

        def capture_refund():
            alpha.goto(origins["alpha"] + "/app/orders/" + tenants["alpha"]["orderId"], wait_until="domcontentloaded")
            try:
                expect(alpha.get_by_role("heading", name="Order operations", exact=True)).to_be_visible()
            except Exception:
                print("Order page state:", json.dumps({"headings": alpha.get_by_role("heading").all_text_contents(), "alerts": alpha.get_by_role("alert").all_text_contents(), "failures": failures}), flush=True)
                raise
            try:
                alpha.get_by_role("button", name="Capture full amount", exact=True).click(timeout=10000)
            except Exception:
                print("Order action state:", json.dumps({"alerts": alpha.get_by_role("alert").all_text_contents(), "buttons": alpha.get_by_role("button").all_text_contents(), "failures": failures}), flush=True)
                raise
            expect(alpha.get_by_text("Captured: 30 · Refunded: 0", exact=True)).to_be_visible()
            alpha.get_by_label("Refund amount", exact=True).fill("5")
            alpha.get_by_role("button", name="Refund payment", exact=True).click()
            expect(alpha.get_by_text("Captured: 30 · Refunded: 5", exact=True)).to_be_visible()
            alpha.screenshot(path=str(OUTPUT / "m4-native-order-refund.png"), full_page=True)
        check("native order widget captures and partially refunds its own Stripe payment", capture_refund)

        def fulfill_ship():
            alpha.get_by_role("button", name="Fulfill remaining items", exact=True).click()
            expect(alpha.get_by_role("button", name="Mark shipped", exact=True)).to_be_visible()
            alpha.get_by_role("button", name="Mark shipped", exact=True).click()
            expect(alpha.get_by_role("button", name="Mark shipped", exact=True)).to_have_count(0)
            alpha.reload(wait_until="domcontentloaded")
            expect(alpha.get_by_text("Captured: 30 · Refunded: 5", exact=True)).to_be_visible()
            expect(alpha.get_by_role("button", name="Fulfill remaining items", exact=True)).to_have_count(0)
            alpha.screenshot(path=str(OUTPUT / "m4-native-order-shipped.png"), full_page=True)
        check("native order actions fulfill and ship managed stock and persist on reload", fulfill_ship)

        def cancel():
            bravo.goto(origins["bravo"] + "/app/orders/" + tenants["bravo"]["orderId"], wait_until="domcontentloaded")
            bravo.get_by_role("button", name="Capture full amount", exact=True).click()
            expect(bravo.get_by_text("Captured: 42 · Refunded: 0", exact=True)).to_be_visible()
            bravo.get_by_role("button", name="Cancel order and release stock", exact=True).click()
            expect(bravo.get_by_role("button", name="Cancel order and release stock", exact=True)).to_have_count(0)
            bravo.reload(wait_until="domcontentloaded")
            expect(bravo.get_by_text("Canceled", exact=True).first).to_be_visible()
            bravo.screenshot(path=str(OUTPUT / "m4-native-order-canceled.png"), full_page=True)
        check("canceling the sibling store's captured order automatically refunds and releases its stock", cancel)

        def totals():
            for page, slug, amounts in [(alpha, "alpha", "Captured: 30 · Refunded: 5 · Net received: 25"),
                (bravo, "bravo", "Captured: 42 · Refunded: 42 · Net received: 0")]:
                page.goto(origins[slug] + "/app/payments", wait_until="domcontentloaded")
                expect(page.get_by_test_id("commerce-total")).to_contain_text(amounts)
            alpha.screenshot(path=str(OUTPUT / "m4-native-commerce-totals.png"), full_page=True)
        check("merchant totals reconcile native financial entries separately for both stores", totals)

        def consumer():
            alpha.goto(origins["alpha"] + "/us/account", wait_until="domcontentloaded")
            expect(alpha.get_by_test_id("login-page")).to_be_visible()
            alpha.get_by_test_id("email-input").fill(ready["buyer"]["email"])
            alpha.get_by_test_id("password-input").fill(ready["buyer"]["password"])
            alpha.get_by_test_id("sign-in-button").click()
            expect(alpha.get_by_test_id("account-nav")).to_be_visible()
            alpha.goto(origins["alpha"] + "/us/order/" + tenants["alpha"]["orderId"] + "/confirmed", wait_until="domcontentloaded")
            expect(alpha.get_by_test_id("order-complete-container")).to_be_visible()
            expect(alpha.get_by_test_id("payment-amount")).to_contain_text("Refunded: $5.00")
            expect(alpha.get_by_test_id("shipping-method-summary")).to_contain_text("$5.00")
            alpha.screenshot(path=str(OUTPUT / "m4-storefront-order-details.png"), full_page=True)
        check("fixed storefront displays actual refund state and the native shipping amount", consumer)
        assert not errors, "Unexpected browser errors: " + "; ".join(errors)
        completed = True
        context.close()
        browser.close()
finally:
    (OUTPUT / "m4-browser.json").write_text(json.dumps({"success": completed, "transport": "owned TLS and Stripe protocol fixtures",
        "checks": checks, "browser_errors": errors}, ensure_ascii=False, indent=2) + "\n")
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    log.close()
