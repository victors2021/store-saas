import base64, datetime, hashlib, json, os, selectors, socket, ssl, subprocess, sys, time
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = Path(os.environ.get('SAAS_SELF_SERVICE_EVIDENCE_DIR', '/tmp/saas-self-service-browser'))
OUTPUT.mkdir(parents=True, exist_ok=True)
checks, errors, process, completed, stage = [], [], None, False, 'startup'
log = (OUTPUT / 'browser-services.log').open('w')

def check(name, task):
    global stage
    stage = name
    try:
        task()
    except Exception:
        if 'page' in globals() and not page.is_closed():
            page.screenshot(path=str(OUTPUT / 'failure-screen.png'), full_page=True, mask=[page.locator('input[type=password]')])
        raise
    checks.append({'name': name, 'passed': True})
    print('PASS', name, flush=True)

try:
    if os.environ.get('SAAS_SELF_SERVICE_BROWSER_RESET') != '1':
        raise RuntimeError('Explicit owned browser reset required')
    process = subprocess.Popen(['node', 'saas/self-service-browser-fixture.cjs'], cwd=ROOT, env=os.environ,
                               stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    ready = None
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline and process.poll() is None:
        if selector.select(1):
            line = process.stdout.readline()
            if line:
                try:
                    candidate = json.loads(line)
                    if isinstance(candidate, dict) and candidate.get('ready'):
                        ready = candidate
                        break
                except json.JSONDecodeError:
                    log.write(line)
                    log.flush()
    if not ready or not ready.get('ready'):
        raise RuntimeError('Browser services failed to start')
    port = ready['port']
    local = os.environ.get('SAAS_LOCALHOST_BROWSER_RESET') == '1'
    domain = 'localhost' if local else 'shops.example.test'
    store_domain = 'shops.localhost' if local else domain
    origin = f'https://{domain}:{port}'
    store = f'https://pine-studio.{store_domain}:{port}'
    platform_origin = f'https://platform.{store_domain}:{port}'
    email, password = 'browser-merchant@shops.example.test', 'browser-owner-password-123'
    def tls():
        trust = ssl.create_default_context(cafile=ready['certificate'])
        for hostname in [domain, f'platform.{store_domain}', f'pine-studio.{store_domain}']:
            with socket.create_connection(('127.0.0.1', port)) as raw:
                with trust.wrap_socket(raw, server_hostname=hostname) as stream:
                    stream.sendall(f'GET /saas/config HTTP/1.1\r\nHost: {hostname}:{port}\r\nConnection: close\r\n\r\n'.encode())
                    assert b'HTTP/1.1 ' in stream.recv(4096)
    check('owned TLS certificate validates apex and platform names', tls)
    with sync_playwright() as p:
        args = ['--no-sandbox', '--no-proxy-server']
        if local:
            public_key = subprocess.check_output(['openssl', 'x509', '-in', ready['certificate'], '-pubkey', '-noout'])
            spki = subprocess.check_output(['openssl', 'pkey', '-pubin', '-outform', 'DER'], input=public_key)
            args.append('--ignore-certificate-errors-spki-list=' + base64.b64encode(hashlib.sha256(spki).digest()).decode())
        else:
            args.append('--host-resolver-rules=MAP *.shops.example.test 127.0.0.1, MAP shops.example.test 127.0.0.1')
        browser = p.chromium.launch(executable_path=os.environ.get('SAAS_M3_CHROMIUM', '/usr/bin/chromium'), args=args)
        context = browser.new_context(ignore_https_errors=not local, timezone_id='Asia/Shanghai', viewport={'width': 1440, 'height': 1040})
        context.route('**/*', lambda route: route.continue_() if urlparse(route.request.url).hostname == domain or
                      (urlparse(route.request.url).hostname or '').endswith('.' + domain) else route.abort())
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)[:200]))
        def landing():
            page.goto(origin, wait_until='domcontentloaded')
            try:
                expect(page.locator('#demo-merchant')).to_be_enabled()
                expect(page.locator('.hero h1')).to_contain_text('你的品牌')
                expect(page.locator('#merchant-demo-email')).to_have_text('demo@shops.example.test')
                expect(page.locator('#notice')).to_be_hidden()
            except Exception:
                page.screenshot(path=str(OUTPUT / 'failure-screen.png'), full_page=True)
                print(json.dumps({'landing_title': page.title(), 'landing_text': page.locator('body').inner_text()[:1200]}, ensure_ascii=False), flush=True)
                raise
            page.screenshot(path=str(OUTPUT / 'saas-home.png'), full_page=True)
        check('SaaS landing displays real registration and three demo entry points', landing)
        def registration():
            page.goto(origin + '/register', wait_until='domcontentloaded')
            expect(page.locator('#auth-submit')).to_be_enabled()
            page.screenshot(path=str(OUTPUT / 'saas-register.png'), full_page=True)
            page.locator('#auth-email').fill(email)
            page.locator('#auth-password').fill(password)
            page.locator('#register-name').fill('松木生活 · 浏览器测试')
            page.locator('#register-slug').fill('pine-studio')
            page.locator('#auth-submit').click()
            expect(page.locator('#shop-list')).to_contain_text('松木生活', timeout=45000)
            expect(page.locator('#sample-count')).to_have_text('3', timeout=45000)
            expect(page.locator('#account-email')).to_have_text(email)
            expect(page.locator('#auth-password')).to_have_value('')
            assert page.evaluate('Object.keys(localStorage).length') == 0
            assert page.evaluate('Object.keys(sessionStorage).length') == 0
            page.screenshot(path=str(OUTPUT / 'saas-merchant-workspace.png'), full_page=True)
        check('email registration automatically opens a native tenant and three sample products', registration)
        def refresh():
            page.reload(wait_until='domcontentloaded')
            expect(page.locator('#account-email')).to_have_text(email)
            expect(page.locator('#shop-count')).to_have_text('1')
            cookies = [c for c in context.cookies(origin) if c['name'] == '__Host-store.saas.account']
            assert len(cookies) == 1 and cookies[0]['httpOnly'] and cookies[0]['secure'] and cookies[0]['sameSite'] == 'Strict'
        check('merchant workspace refresh restores its secure host-only session', refresh)
        storefront = context.new_page()
        storefront.on('pageerror', lambda e: errors.append(str(e)[:200]))
        def catalog():
            storefront.goto(store + '/us/store', wait_until='domcontentloaded')
            expect(storefront.get_by_text('演示 · 简约棉质 T 恤', exact=True)).to_be_visible(timeout=30000)
            expect(storefront.get_by_text('演示 · 日常陶瓷杯', exact=True)).to_be_visible()
            storefront.wait_for_function('Array.from(document.images).filter(i => i.src.includes("demo-")).every(i => i.complete && i.naturalWidth > 0)')
            storefront.screenshot(path=str(OUTPUT / 'saas-sample-storefront.png'), full_page=True)
        check('the actual fixed-template storefront renders sample prices and owned product images', catalog)
        merchant = context.new_page()
        merchant.on('pageerror', lambda e: errors.append(str(e)[:200]))
        def native_login():
            merchant.goto(store + '/app/login', wait_until='domcontentloaded')
            merchant.locator('input[name=email]').fill(email)
            merchant.locator('input[name=password]').fill(password)
            merchant.get_by_role('button', name='Continue with Email', exact=True).click()
            merchant.wait_for_url(lambda u: u.endswith('/app/orders') or u.endswith('/app/products'), timeout=30000)
            merchant.goto(store + '/app/products', wait_until='domcontentloaded')
            expect(merchant.get_by_text('演示 · 简约棉质 T 恤', exact=True)).to_be_visible()
            merchant.screenshot(path=str(OUTPUT / 'saas-native-merchant.png'), full_page=True)
        check('the registered email and password log into the existing native merchant Admin', native_login)
        def add_real():
            response = merchant.evaluate("""async body => {const r=await fetch('/admin/products',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()}}""", {
                'title': '真实商品（验收）', 'handle': 'real-browser-product', 'status': 'draft', 'metadata': {'demo': True},
                'options': [{'title': 'Size', 'values': ['One']}], 'variants': [{'title': 'One', 'manage_inventory': False,
                    'options': {'Size': 'One'}, 'prices': [{'currency_code': 'usd', 'amount': 99}]}]})
            assert response['status'] == 200
        check('a separately created merchant product is not part of the sample batch', add_real)
        def clear_samples():
            page.get_by_role('button', name='清除模拟商品', exact=True).click()
            expect(page.locator('#remove-dialog')).to_be_visible()
            page.locator('#confirm-remove').click()
            expect(page.locator('#sample-count')).to_have_text('0', timeout=30000)
            expect(page.locator('#product-count')).to_have_text('1')
            response = merchant.evaluate("""async()=>{const r=await fetch('/admin/products',{credentials:'same-origin'});return {status:r.status,data:await r.json()}}""")
            assert response['status'] == 200 and [p['title'] for p in response['data']['products']] == ['真实商品（验收）']
            page.screenshot(path=str(OUTPUT / 'saas-samples-cleared.png'), full_page=True)
        check('the confirmation dialog clears only tracked samples and preserves the ordinary product', clear_samples)
        def add_samples():
            page.get_by_role('button', name='添加模拟商品', exact=True).click()
            expect(page.locator('#sample-count')).to_have_text('3', timeout=30000)
            expect(page.locator('#product-count')).to_have_text('4')
        check('samples can be added again without replacing the real product', add_samples)
        def mobile():
            page.set_viewport_size({'width': 390, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(OUTPUT / 'saas-workspace-mobile.png'), full_page=True)
            page.set_viewport_size({'width': 1440, 'height': 1040})
        check('the merchant workspace fits a mobile viewport without horizontal overflow', mobile)
        def relogin():
            page.locator('#logout').click()
            expect(page.locator('#auth-submit')).to_have_text('登录用户后台 →')
            assert page.evaluate("fetch('/saas/shops').then(r => r.status)") == 401
            page.locator('#auth-email').fill(email)
            page.locator('#auth-password').fill(password)
            page.locator('#auth-submit').click()
            expect(page.locator('#account-email')).to_have_text(email)
            expect(page.locator('#shop-count')).to_have_text('1')
        check('logout revokes the portal session and normal email login restores the owned shop', relogin)
        def demo_merchant():
            page.goto(origin, wait_until='domcontentloaded')
            expect(page.locator('#demo-merchant')).to_be_enabled()
            page.locator('#demo-merchant').click()
            expect(page.locator('#account-email')).to_have_text('demo@shops.example.test', timeout=30000)
            expect(page.locator('#shop-list')).to_contain_text('雾森生活', timeout=30000)
            expect(page.locator('#sample-count')).to_have_text('3', timeout=30000)
            page.screenshot(path=str(OUTPUT / 'saas-demo-workspace.png'), full_page=True)
        check('merchant demo logs in and initializes its separate demonstration shop', demo_merchant)
        def demo_native():
            page.goto(origin, wait_until='domcontentloaded')
            expect(page.locator('#demo-native')).to_be_enabled()
            page.locator('#demo-native').click()
            page.wait_for_url(lambda u: f'demo-store.{store_domain}' in u and (u.endswith('/app/orders') or u.endswith('/app/products')), timeout=45000)
            page.goto(f'https://demo-store.{store_domain}:{port}/app/products', wait_until='domcontentloaded')
            expect(page.get_by_text('演示 · 简约棉质 T 恤', exact=True)).to_be_visible()
            page.screenshot(path=str(OUTPUT / 'saas-demo-native.png'), full_page=True)
        check('native Admin demo obtains a tenant-bound session without exposing its password', demo_native)
        def demo_platform():
            page.goto(platform_origin + '/platform', wait_until='domcontentloaded')
            expect(page.locator('#demo-button')).to_be_visible()
            expect(page.locator('#demo-email')).to_have_text('demo-admin@shops.example.test')
            page.locator('#demo-button').click()
            expect(page.locator('#administrator-email')).to_have_text('demo-admin@shops.example.test')
            expect(page.get_by_role('heading', name='商户与试点套餐')).to_be_visible()
            page.screenshot(path=str(OUTPUT / 'saas-demo-platform.png'), full_page=True)
            page.locator('#logout').click()
            expect(page.locator('#login-form')).to_be_visible()
            assert page.evaluate("fetch('/platform/tenants').then(r => r.status)") == 401
        check('the dedicated platform demo administrator logs in and its logout revokes access', demo_platform)
        check('all tested pages finish without JavaScript errors', lambda: (_ for _ in ()).throw(AssertionError('page errors')) if errors else None)
        context.close()
        browser.close()
    completed = True
except Exception as e:
    if 'page' in locals() and not page.is_closed():
        try:
            page.screenshot(path=str(OUTPUT / 'failure-screen.png'), full_page=True)
        except Exception:
            pass
    print(json.dumps({'complete': False, 'stage': stage, 'error_type': type(e).__name__, 'details': 'Browser verification failed; inspect the owned fixture log'}, ensure_ascii=False), flush=True)
    sys.exit(1)
finally:
    if process is not None:
        process.terminate()
        try:
            process.wait(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    log.close()
    (OUTPUT / 'browser.json').write_text(json.dumps({'complete': completed, 'passed': len(checks), 'checks': checks,
        'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'page_errors': errors,
        'access_scope': 'owned loopback test environment', 'real_email_sent': False, 'real_payment': False,
        'production_release': False}, ensure_ascii=False, indent=2) + '\n')
