# SaaS 官网、自助开店与演示登录

更新日期：2026-10-10。已完成本地开发、真实浏览器流程和持久开发环境验证。
本次是第一阶段体验完善，复用 MIT Medusa 原生交易模块、Admin 和固定商城；
AI、Helpdesk、CRM、营销、行为统计和通用模块管理仍属于第二阶段。

## 实际功能

| 入口 | 功能 |
|---|---|
| 平台主域名 `/` | SaaS 官网、注册开店、三个演示入口 |
| 平台主域名 `/register` | 邮箱/密码注册，填写店名、子域名，自动初始化网店，可勾选三款模拟商品 |
| 平台主域名 `/login`、`/dashboard` | 邮箱登录、自己的网店列表、创建/重试、进入商城与商家后台、添加/清除模拟商品 |
| `<店铺>.<主域名>/` | 现有响应式商城，已初始化品牌配置、默认地区/币种、仓库、配送等 |
| `<店铺>.<主域名>/app/` | 现有 Medusa 商家 Admin，用开店时的注册邮箱和密码登录 |
| `platform.<主域名>/platform` | 原有平台管理，邮箱登录、租户状态、人工套餐/配额、服务运行信息 |

商家公开注册不能创建平台管理员。平台管理员继续通过离线运维命令创建，
租户内消费者账号仍由各店原生 Account 页面管理。官网工作台是轻量账号/网店入口，
商品、订单、库存和支付业务继续使用原生 Admin。

邮箱目前是登录标识，**未实现邮箱验证、验证邮件、找回密码或邮件发送**。
原 PRD 的邮箱验证要求仍待完成，不能视为 TEN-01 全项验收。普通账号在开店时
确认登录密码，原生店主使用同一邮箱/密码；没有新增正常账号的跨域 SSO。
当前一个账号最多保留三个开店请求，每个成功请求创建独立租户；失败请求可按
原幂等请求重试。固定主题已有品牌配置，本次没有模板市场、拖拽编辑器或自定义域名。

## 模拟商品与租户边界

可添加 T 恤、陶瓷杯和帆布袋三款商品，价格分别为 USD 29、18、39。
图片使用仓库自有 SVG，商品标记为演示用途，库存采用原生 unmanaged 模式。
加入商品不配置 Stripe、不收款、不生成订单。真正营业前仍须配置真实商品、库存、
配送和独立支付账户，并执行原有发布验收。

新控制域记录按 `tenant_id` 保存本次生成的商品 ID。清除只遍历这份记录，
调用原生删除工作流；不按标题、handle 或 metadata 搜索并删除其他商品。
原生软删除释放商品配额，保留历史订单语义。重复添加/清除可重试，手动删除
模拟商品后也可重新添加，真实商品即使带 `demo: true` metadata 也不受清除影响。

门户账号与开店映射由服务端确定店主 actor；native 开店幂等键按账号隔离。
接口从当前账号的映射查店铺，不能由请求提交 tenant/owner/role。
模拟商品工作流进入已验证 TenantContext 和店主身份，遵循现有模块守卫、
事务级 RLS、配额和暂停规则，并与支付/暂停操作使用同一个租户锁。
HTTP 路由仍位于原有备份维护门闩之后，不绕过快照写入栅栏。

## 追加迁移与认证

`0009-self-service` 增加四张控制表：`portal_account`、`portal_session`、
`portal_shop`、`portal_demo_product`。没有修改 0001–0008，公开业务表数量与
140 张 FORCE RLS 边界保持原值。应用角色不能修改账号状态、凭据或开店映射。
迁移校验 checksum、实际列/约束/索引、表所有者、PUBLIC 授权和运行角色权限；
缺失或漂移拒绝启动。旧库按原停写、备份与迁移流程执行：

```bash
node saas/migrate-m5-command.cjs
```

管理连接、运行角色、稳定 JWT key 和对象目录由安全环境提供；启动不自动迁移。
当前持久开发库只追加了 0009，没有 reset 或重建现有数据。

注册密码至少 12 位，使用独立盐的 scrypt N=32768/r=8/p=1；共享数据库限流，
每个进程最多同时四次密码计算。正式门户 cookie 为
`__Host-store.saas.account`，Secure、HttpOnly、SameSite=Strict、Path=/、无 Domain。
256-bit 随机会话固定一小时到期，数据库存 HMAC；每次验证账号状态/version/expiry。
写操作要求精确 Origin 和 CSRF。门户、商家和平台 cookie 分开；没有把密码、
平台密钥或门户会话写入浏览器 localStorage/sessionStorage。

门户账号撤销/version 变更使门户会话失效；已有原生店主会话仍由原生租户身份、
成员和租户状态控制。全店停用使用原有平台暂停流程，不能把门户账号撤销当作
原生店主的全域撤销。备份保留账号哈希、店铺映射和商品记录，恢复清空门户会话，
需要重新登录。

## 已准备的开发演示

| 身份 | 演示邮箱 | 快捷入口 |
|---|---|---|
| 商家工作台 | `demo@shops.example.test` | 官网“一键登录用户后台” |
| 原生商家 Admin | `demo@shops.example.test` | 官网“一键登录商家后台”，绑定 `demo-store` |
| 平台管理员 | `demo-admin@shops.example.test` | 平台登录页“一键登录平台演示” |
| 现有普通平台管理员 | `admin@shops.example.test` | 原邮箱/密码方式，原凭据保持不变 |

演示密码由离线脚本生成，保存到 checkout 外 0700 目录中的 0600 私有文件；
浏览器不需要知道演示密码。`provision-demo.cjs` 拒绝将已有普通商家邮箱接管为
演示账号，重复执行校验原凭据，不重置原管理员。平台演示使用独立 actor
`demo_platform_admin`；用户后台和原生商家快捷认证只绑定专用演示账号。

演示功能要求显式私有配置、非 production、无发布 manifest，以及保留域名
`example.test`。生产或实际公网域名启动时拒绝启用，不内置公开的固定密码。
本地离线准备（管理连接通过安全环境配置）：

```bash
install -d -m 700 /workspace/.store-saas-preview
NODE_ENV=development SAAS_BASE_DOMAIN=shops.example.test \
  SAAS_DEMO_DIRECTORY=/workspace/.store-saas-preview node saas/provision-demo.cjs
```

网关用 `SAAS_DEMO_CONFIG_FILE` 指向私有 `demo-config.json` 才开启快捷登录。
正式部署去掉该配置，保留普通邮箱登录；稳定的五项运行 keys 不需要旋转。

当前演示使用独立持久库 `medusa_saas_preview` 和原非 bypass 角色。
准备了覆盖主域名与一级子域名的自签开发证书；原平台证书/私钥未覆盖。
保留的运行 keyring、密码、证书、迁移前私有备份和对象目录全部在 checkout 外，
不提交 Git。快照恢复后的进程需要重新启动：

```bash
source /workspace/.store-saas-environment/activate.sh
cd /workspace/store-saas
NODE_ENV=development SAAS_PREVIEW_DIRECTORY=/workspace/.store-saas-preview \
  node saas/start-demo-preview.cjs
```

该启动器核对持久开发库 marker，只绑定 loopback：TLS 9443、API 9130、
Next 8130；三个端口可通过对应环境变量调整。Next 子进程仍以 production
模式运行且移除后台密钥。检查 `localhost` API `/health/ready` 和带正确 Host、
信任自有证书的功能请求；不要同时启动两个占用相同端口的 supervisor。
当前 `shops.example.test` 仅由验证浏览器映射到本环境，**没有公网 URL、
实际域名或转发入口**。这份本地演示不能替代正式 TLS、部署或发布验收。
在 Cursor Cloud Agent 中若需端口转发到本机浏览器，启动时加
`SAAS_CLOUD_LOCAL_BROWSE=1`；无需完整栈时可先用
[远程本地浏览](25-REMOTE-LOCAL-BROWSE.md) 的 8080 原型。

后续已新增 `https://localhost:9443/dashboard` 开发入口及自动生成的店铺跳转，
详见 [localhost 开发入口](25-LOCALHOST-DEVELOPMENT.md)。服务须在本机运行或已建立转发。

## 验证与开发复查

| 本次实际执行 | 记录检查数 |
|---|---:|
| 新增账号/开店/模拟商品、Origin/CSRF、跨账号、幂等命名空间、并发限额、撤销与 demo 限制 | 19 |
| 原平台邮箱认证回归 | 18 |
| M5 HTTP 配额、暂停、恢复、审计 | 28 |
| M4→M5 升级与实际迁移/启动器 | 4 + 7 |
| 加密备份、独立 PostgreSQL 实例恢复；含门户账号/归属/模拟商品与旧会话失效 | 13 |
| M6 全入口、140 张 FORCE RLS 与资源边界 | 11 |
| M6 并发交易/双 API 进程/补偿/指标 | 8 |
| TLS 与匹配快照恢复、发布门闩 | 8 + 7 |
| 真实浏览器注册到开店、原生后台、清除保留真实商品、三个 demo、手机布局 | 15 |
| 持久环境、原管理员保持不变、三个 demo 与监督进程重启 | 6 + 4 |
| **合计** | **148** |

全部执行通过，浏览器页面没有 JavaScript 错误。结果与实际截图见
[证据目录](self-service-evidence/summary.json)。新增测试使用明确标记的 disposable
开发库，未将 reset 标志用于持久开发库。独立 PostgreSQL 恢复仍在同一物理主机，
不是异机恢复验收。本次复用已构建的原生/Admin/Next 产物；这些编译源、依赖和
lockfile 未变化，未重跑完整历史构建或 30 分钟容量测试。

自查修复了 apex 路由误拦截健康检查、官网演示区 DOM 标识错误，以及客户端
幂等键跨账号冲突。复查覆盖账号到租户映射、服务端 actor、工作流上下文、
Cookie/CSRF、demo 受控启用、样品删除清单、备份会话失效和敏感文件边界。
这是开发者复查，没有新增独立安全审计。

M0–M6 历史证据、平台邮箱登录历史证据、根 MIT LICENSE、原生包版本和旧迁移
保持原字节。旧发布记录绑定旧源码，当前代码必须重新登记/验证发布证据。
真实 Stripe/Elements、实际异机恢复、参考硬件容量、正式部署/报警、独立审查和
商户试点等原发布门槛继续保留；详见 [发布验收](21-RELEASE-ACCEPTANCE.md)。
