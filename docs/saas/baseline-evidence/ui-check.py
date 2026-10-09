from pathlib import Path
import json
from playwright.sync_api import sync_playwright
root=Path('/workspace/medusa-saas-planning'); checks=[]
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 context=browser.new_context(viewport={'width':1440,'height':1050})
 page=context.new_page(); errors=[];page.on('pageerror',lambda e:errors.append(str(e))); page.on('dialog',lambda d:d.accept())
 page.goto('http://127.0.0.1:8765/saas-prototype.html');page.locator('h1').wait_for()
 assert '交互原型' in page.locator('.notice').inner_text();checks.append('prototype disclaimer')
 page.locator('[data-newtenant]').first.click(); page.locator('dialog input[name=name]').fill('测试商户');page.locator('dialog input[name=slug]').fill('test-shop');page.locator('dialog button.primary').click()
 page.locator('nav [data-page=tenants]').click(); assert '测试商户' in page.locator('#app').inner_text();checks.append('create local tenant')
 page.locator('#search').fill('北岸');assert page.locator('tbody tr').count()==1;checks.append('tenant search')
 page.locator('[data-mode=merchant]').click();page.locator('nav [data-page=products]').click();page.locator('[data-newproduct]').click()
 page.locator('dialog input[name=name]').fill('测试商品');page.locator('dialog input[name=price]').fill('12.50');page.locator('dialog input[name=stock]').fill('3');page.locator('dialog button.primary').click()
 page.locator('tr').filter(has_text='测试商品').locator('[data-publish]').click();checks.append('create and publish product')
 page.locator('#tenantpick').select_option('t_north');assert '测试商品' not in page.locator('tbody').inner_text();checks.append('local tenant data filtering')
 page.locator('#tenantpick').select_option('t_mori');page.locator('[data-mode=store]').click()
 page.locator('.productcard').filter(has_text='测试商品').locator('[data-add]').click();page.locator('nav [data-page=cart]').click();assert '¥12.50' in page.locator('#app').inner_text()
 page.locator('[data-checkout]').click();assert '购物袋为空' in page.locator('#app').inner_text();checks.append('mock checkout and clear cart')
 page.locator('[data-mode=merchant]').click();page.locator('nav [data-page=orders]').click();page.locator('[data-order]').first.click();page.locator('#ship').click();assert '已发货' in page.locator('tbody tr').first.inner_text();checks.append('mock order fulfillment')
 page.locator('[data-order]').first.click();page.locator('#refund').click();assert '已退款' in page.locator('tbody tr').first.inner_text();checks.append('mock refund')
 page.locator('[data-mode=platform]').click();page.locator('nav [data-page=tenants]').click();page.locator('[data-toggle=t_mori]').click()
 page.locator('[data-mode=store]').click();assert page.locator('[data-add]').first.is_disabled();checks.append('suspended storefront disabled')
 page.locator('#tenantpick').select_option('t_north');assert not page.locator('[data-add]').first.is_disabled();checks.append('other storefront stays active')
 page.locator('[data-mode=platform]').click();page.locator('nav [data-page=plans]').click();page.locator('[data-quota=t_mori]').click();page.locator('dialog input[name=quota]').fill('40');page.locator('dialog button.primary').click();assert '/ 40' in page.locator('#app').inner_text();checks.append('quota update')
 page.reload();page.locator('nav [data-page=tenants]').click();assert '测试商户' in page.locator('#app').inner_text();checks.append('local persistence')
 page.locator('[data-mode=platform]').click();page.screenshot(path=str(root/'prototype-desktop.png'),full_page=True)
 page.set_viewport_size({'width':390,'height':844});page.locator('[data-mode=merchant]').click();page.screenshot(path=str(root/'prototype-mobile.png'),full_page=True)
 assert page.evaluate('document.documentElement.scrollWidth <= innerWidth');checks.append('mobile layout no horizontal overflow')
 assert not errors,errors
 (root/'prototype-checks.json').write_text(json.dumps({'checks':checks,'passed':len(checks),'browser':'Chromium','errors':errors,'scope':'offline prototype; not backend isolation or real payments'},ensure_ascii=False,indent=2))
 browser.close()
print(json.dumps({'passed':len(checks),'errors':errors},ensure_ascii=False))
