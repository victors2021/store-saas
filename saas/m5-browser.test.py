"""Production native Admin + real platform console over owned loopback TLS.
Payment calls use the real Stripe SDK against the owned M4 protocol fixture.
"""
import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile
import time
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path(os.environ.get("SAAS_M5_EVIDENCE_DIR", "/tmp/medusa-m5-browser-evidence"))
OUTPUT.mkdir(parents=True, exist_ok=True)
checks, errors, responses = [], [], []
completed, process = False, None
private = tempfile.TemporaryDirectory(prefix="saas-m5-browser-private-")
auth_file = Path(private.name) / "auth.json"
log = (OUTPUT / "m5-browser-services.log").open("w")

def check(name, task):
    task()
    checks.append({"name": name, "passed": True})
    print("PASS", name, flush=True)

try:
    if os.environ.get("SAAS_M5_BROWSER_TEST_RESET") != "1":
        raise RuntimeError("Explicit disposable M5 browser reset required")
    environment = dict(os.environ, SAAS_BROWSER_STAGE="M5", SAAS_M3_NEXT_PORT="8015", SAAS_M5_BROWSER_AUTH_FILE=str(auth_file))
    process = subprocess.Popen(["node", "saas/m3-browser-fixture.cjs"], cwd=ROOT, env=environment,
                               stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    ready = None
    deadline = time.monotonic() + 75
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("M5 browser fixture failed; see its service log")
        for key, _ in selector.select(timeout=0.5):
            line = key.fileobj.readline()
            if line.startswith('{"ready":'):
                ready = json.loads(line)
                break
        if ready:
            break
    selector.close()
    if not ready:
        raise RuntimeError("M5 browser fixture did not become ready")
    tenants = {row["slug"]: row for row in ready["tenants"]}
    origins = {slug: f"https://{row['hostname']}:{ready['port']}" for slug, row in tenants.items()}
    platform_origin = f"https://platform.shops.example.test:{ready['port']}"
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=os.environ.get("SAAS_M3_CHROMIUM", "/usr/bin/chromium"),
            args=["--no-sandbox", "--no-proxy-server", "--host-resolver-rules=MAP *.shops.example.test 127.0.0.1"])
        context = browser.new_context(ignore_https_errors=True, timezone_id="Asia/Shanghai", viewport={"width": 1440, "height": 1100})
        owned = {row["hostname"] for row in ready["tenants"]} | {"platform.shops.example.test"}
        context.route("**/*", lambda route: route.continue_() if urlparse(route.request.url).hostname in owned else route.abort())
        alpha, bravo, platform = context.new_page(), context.new_page(), context.new_page()
        for page in [alpha, bravo, platform]:
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("response", lambda reply: responses.append({"path": urlparse(reply.url).path, "status": reply.status}) if reply.status >= 400 else None)

        def login(page, slug):
            page.goto(origins[slug] + "/app/login", wait_until="domcontentloaded")
            page.locator('input[name="email"]').fill(ready["credentials"]["email"])
            page.locator('input[name="password"]').fill(ready["credentials"]["password"])
            page.get_by_role("button", name="Continue with Email", exact=True).click()
            page.wait_for_url(lambda url: "/app/login" not in url)
        check("both native merchant sessions retain independent host-only authentication", lambda: (login(alpha, "alpha"), login(bravo, "bravo")))

        def platform_login():
            platform.goto(platform_origin + "/platform", wait_until="domcontentloaded")
            platform.get_by_label("平台管理员密钥").fill(json.loads(auth_file.read_text())["platformKey"])
            platform.get_by_role("button", name="登录平台", exact=True).click()
            expect(platform.get_by_role("heading", name="商户与试点套餐", exact=True)).to_be_visible()
            expect(platform.get_by_label("平台管理员密钥")).to_have_value("")
            expect(platform.locator("#health")).to_contain_text("正常")
            expect(platform.locator("#backup-status")).to_contain_text("异机副本与恢复尚待验证")
            expect(platform.locator("#alerts")).to_contain_text("尚无加密备份")
            platform.screenshot(path=str(OUTPUT / "m5-platform-console.png"), full_page=True)
        check("real platform console authenticates, clears its key and loads live metadata", platform_login)

        def plan():
            platform.locator("tr").filter(has_text="Alpha Shop").get_by_role("button", name="修改套餐").click()
            platform.get_by_label("商品上限", exact=True).fill("10")
            platform.get_by_label("上传空间上限（MiB）", exact=True).fill("32")
            platform.get_by_role("button", name="保存套餐", exact=True).click()
            expect(platform.get_by_role("status")).to_have_text("人工套餐已保存")
            alpha.goto(origins["alpha"] + "/app/operations", wait_until="domcontentloaded")
            expect(alpha.get_by_test_id("product-quota")).to_have_text("1 / 10")
            expect(alpha.get_by_test_id("upload-quota")).to_have_text("0.00 MiB / 32.00 MiB")
            bravo.goto(origins["bravo"] + "/app/operations", wait_until="domcontentloaded")
            expect(bravo.get_by_test_id("product-quota")).to_have_text("1 / 1000")
            platform.screenshot(path=str(OUTPUT / "m5-platform-plan.png"), full_page=True)
        check("manual platform cap changes reach only the intended merchant's native Operations page", plan)

        def capture_pause():
            alpha.goto(origins["alpha"] + "/app/orders/" + tenants["alpha"]["orderId"], wait_until="domcontentloaded")
            alpha.get_by_role("button", name="Capture full amount", exact=True).click()
            expect(alpha.get_by_text("Captured: 30 · Refunded: 0", exact=True)).to_be_visible()
            platform.locator("tr").filter(has_text="Alpha Shop").get_by_role("button", name="暂停店铺").click()
            expect(platform.get_by_role("status")).to_have_text("店铺状态已更新")
            alpha.goto(origins["alpha"] + "/app/operations", wait_until="domcontentloaded")
            expect(alpha.get_by_test_id("shop-status")).to_have_text("Status: Paused")
            expect(alpha.get_by_text("New sales are paused.", exact=False)).to_be_visible()
            bravo.reload(wait_until="domcontentloaded")
            expect(bravo.get_by_test_id("shop-status")).to_have_text("Status: Active")
            alpha.screenshot(path=str(OUTPUT / "m5-native-paused-operations.png"), full_page=True)
            assert alpha.evaluate("fetch('/store/settings').then(reply => reply.status)") == 423
        check("platform pause preserves native merchant access and leaves the sibling active", capture_pause)

        def recovery():
            alpha.goto(origins["alpha"] + "/app/orders/" + tenants["alpha"]["orderId"], wait_until="domcontentloaded")
            alpha.get_by_label("Refund amount", exact=True).fill("5")
            alpha.get_by_role("button", name="Refund payment", exact=True).click()
            expect(alpha.get_by_role("alert").first).to_be_visible()
            alpha.goto(origins["alpha"] + "/app/operations", wait_until="domcontentloaded")
            expect(alpha.get_by_test_id("recovery-operation")).to_contain_text("refund")
            alpha.screenshot(path=str(OUTPUT / "m5-native-operation-recovery.png"), full_page=True)
            alpha.get_by_role("button", name="Retry saved operation", exact=True).click()
            expect(alpha.get_by_text("No payment operations need recovery.", exact=True)).to_be_visible()
            alpha.goto(origins["alpha"] + "/app/orders/" + tenants["alpha"]["orderId"], wait_until="domcontentloaded")
            expect(alpha.get_by_text("Captured: 30 · Refunded: 5", exact=True)).to_be_visible()
        check("native Operations retries a saved failed refund with its original parameters while paused", recovery)

        def fulfill():
            alpha.get_by_role("button", name="Fulfill remaining items", exact=True).click()
            expect(alpha.get_by_role("button", name="Mark shipped", exact=True)).to_be_visible()
            alpha.get_by_role("button", name="Mark shipped", exact=True).click()
            expect(alpha.get_by_role("button", name="Mark shipped", exact=True)).to_have_count(0)
            alpha.reload(wait_until="domcontentloaded")
            expect(alpha.get_by_text("Captured: 30 · Refunded: 5", exact=True)).to_be_visible()
            alpha.screenshot(path=str(OUTPUT / "m5-native-paused-shipment.png"), full_page=True)
        check("paused paid-order fulfillment and shipment execute real native workflows", fulfill)

        def resume_audit():
            platform.locator("tr").filter(has_text="Alpha Shop").get_by_role("button", name="恢复店铺").click()
            expect(platform.get_by_role("status")).to_have_text("店铺状态已更新")
            alpha.goto(origins["alpha"] + "/app/operations", wait_until="domcontentloaded")
            expect(alpha.get_by_test_id("shop-status")).to_have_text("Status: Active")
            expect(alpha.get_by_role("heading", name="Recent audit events", exact=True)).to_be_visible()
            alpha.screenshot(path=str(OUTPUT / "m5-native-audit.png"), full_page=True)
            assert alpha.evaluate("fetch('/store/settings').then(reply => reply.status)") == 200
            assert alpha.evaluate("fetch('/platform/tenants').then(reply => reply.status)") == 401
        check("resumption restores storefront reads while native audit and platform boundaries remain enforced", resume_audit)

        def logout():
            platform.get_by_role("button", name="退出", exact=True).click()
            expect(platform.get_by_role("heading", name="平台管理员登录", exact=True)).to_be_visible()
            assert platform.evaluate("Object.keys(localStorage).length") == 0
            assert platform.evaluate("Object.keys(sessionStorage).length") == 0
        check("platform logout removes the in-memory key without browser credential storage", logout)
        assert errors == [], errors
        assert any(row["status"] == 500 and row["path"].endswith("/refund") for row in responses)
        unexpected = [row for row in responses if row["status"] >= 400 and not ((row["status"] == 500 and row["path"].endswith("/refund")) or
            (row["status"] == 423 and row["path"] == "/store/settings") or (row["status"] == 401 and row["path"] == "/platform/tenants"))]
        assert unexpected == [], unexpected
        browser.close()
    completed = True
finally:
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=25)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
    log.close()
    private.cleanup()
    (OUTPUT / "m5-browser.json").write_text(json.dumps({"milestone": "M5", "success": completed, "passed": len(checks), "checks": checks,
        "page_errors": errors, "expected_failure": "owned Stripe fixture rejects the first refund with HTTP 503; native API returns 500", "observed_failure_responses": responses}, indent=2))
