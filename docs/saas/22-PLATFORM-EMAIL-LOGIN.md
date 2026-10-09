# 平台管理员邮箱登录

已按用户指定的开发邮箱 `admin@shops.example.test` 更新平台运营后台，并在独立
持久开发库 `medusa_saas_preview` 的现有 `platform_admin` 身份上配置邮箱/密码。
登录后右上角显示管理员邮箱；刷新可恢复会话，退出会删除服务端会话。
实际页面见 [登录页](platform-email-login-evidence/platform-email-login.png) 和
[已登录平台](platform-email-login-evidence/platform-email-dashboard.png)。

## 访问与凭据

平台路径为 `/platform`，入口 Host 必须是 `platform.<SAAS_BASE_DOMAIN>`。
当前开发服务的内部地址是 `https://platform.shops.example.test:9443/platform`，
只监听云执行环境的 loopback，由验证浏览器显式映射该保留域名；这不是公网 URL。
外网访问还需要用户的实际域名/服务器和 HTTPS 入口，目前没有配置或验证。

本次随机管理员密码保存在 checkout 外的
`/workspace/.store-saas-preview/platform-password.txt`，文件权限 0600，目录 0700。
数据库只保存 scrypt 哈希；该文件、稳定运行 keyring、TLS 私钥和会话 cookie
未加入 Git 或交付证据。邮箱是登录标识，不执行邮箱收信验证或邮件发送。

## 迁移与创建管理员

新增加法迁移 `0008-platform-login`，只增加控制域的 `platform_credential` 和
`platform_login_session` 两张表。0001–0007 历史迁移与共享 checksum 依赖保持原字节。
当前 M5/M6 启动器校验 0008 的 checksum、schema fingerprint 和实际表权限；
旧库须用管理连接执行更新后的 `node saas/migrate-m5-command.cjs`。

完成原生和 SaaS 迁移后，配置明确的管理连接、操作者 ID、邮箱和受限密码文件路径。
例如（数据库连接与原有运行 keys 从安全环境配置提供）：

```bash
source /workspace/.store-saas-environment/activate.sh
install -d -m 700 /workspace/.store-saas-preview
SAAS_PLATFORM_EMAIL=admin@shops.example.test \
SAAS_PLATFORM_PASSWORD_FILE=/workspace/.store-saas-preview/platform-password.txt \
node saas/provision-platform-login.cjs
```

还须有 `SAAS_MIGRATION_DATABASE_URL` 和 `SAAS_PLATFORM_ACTOR_ID`。密码文件不存在时
离线命令生成随机密码；存在时检查它是私有普通文件。重复运行不改密码或提升已
撤销管理员的状态。修改邮箱/密码需要明确设置 `SAAS_PLATFORM_RESET_PASSWORD=true`；
新密码应使用新的受限文件路径。重置提升 credential version 并删除该操作者的所有
平台会话。应用角色不能插入/修改管理员凭据或授予平台身份；没有 HTTP 自助注册、
密码重置或提权接口。已撤销身份需要运维另行显式处理。

原 `SAAS_PLATFORM_KEY` 保留用于受控脚本和监控。平台网页改用邮箱/密码和 cookie，
不再输入或在页面内保存这个 key；现有五项稳定运行 keys 没有旋转。
商户原生 Admin 的租户邮箱身份不能成为平台管理员。

## 会话与安全边界

- scrypt 参数 N=32768、r=8、p=1，每个密码有独立随机盐；认证在异步线程执行，
  每个 API 进程最多同时四次哈希。未知邮箱执行同成本的哈希校验并返回相同错误。
- 登录会话为 256-bit 随机 opaque token，数据库存 HMAC 摘要；会话固定一小时到期，
  读取不延长。正式 cookie 为 `__Host-store.saas.platform`，Secure、HttpOnly、
  SameSite=Strict、Path=/，不设置 Domain。非 Secure cookie 仅用于标记测试 fixture。
- cookie 请求每次都查询会话、credential version 和持久管理员状态；跨 API 进程
  立即共享登录和退出结果。再次登录会旋转当前 cookie，旧 cookie 失效。
- 登录要求 HTTPS 和精确 Origin；cookie 写操作还校验 CSRF token。平台 Host、
  客户端 tenant/forwarded-host headers 和原有租户边界继续强制校验。
- 登录尝试通过共享数据库限流：全平台 30/min、IP 10/min、邮箱 5/min；作用域采用
  HMAC，不将邮箱或原始 IP写入限流 key。返回 429 和 Retry-After。
- 审计使用实际登录的平台 actor；人工套餐、暂停及开店均支持管理员会话。
  过期会话由现有 worker 按批清理；完整备份保留密码哈希，恢复时清空平台会话。

应用 DB 角色仍属于可信后端；RLS 和本次认证不抵御拥有任意 SQL 执行能力的已失陷
后端。可信入口必须保留 Host、剥离外来转发声明，并按原运维要求限制平台访问。

## 实际验证

| 验证 | 已通过的记录检查 |
|---|---:|
| 新增邮箱认证、权限、双进程、退出/重置/撤销、限流、schema drift | 18 |
| M5 HTTP 配额/暂停/恢复/审计回归 | 28 |
| M4→M5 升级和幂等迁移 | 4 |
| M5 加密备份、独立 PostgreSQL 恢复与原生流程 | 11 |
| 实际迁移 CLI 和启动器 | 7 |
| M6 全入口矩阵、140 张 FORCE RLS 表与资源边界 | 11 |
| 验证证书的 TLS、Secure 登录和恢复后旧 cookie 失效 | 8 |
| 原生商户后台和平台实际浏览器操作 | 9 |

共 96 项记录检查通过，另有发布门禁测试通过。持久开发库的实际登录、邮箱显示、
清空密码输入、刷新、退出和再次登录均通过；实际内部 TLS 证书由独立 Node 请求
验证。浏览器允许该自签开发证书，不能作为公网正式证书验收。没有重跑完整历史
M0–M6 构建/测试或 30 分钟性能负载；当前追加修改的验证范围以上表及证据为准。

## 开发复查与交付范围

开发者自行复查了平台身份来源、只读凭据权限、密码文件/日志、cookie 范围、
会话撤销和备份恢复。第一次接口验证发现运行角色的只读凭据权限与行共享锁不兼容，
已改为只读条件查询和有版本条件的会话插入；保持应用角色不能修改凭据。
该修复后 18 项认证检查及相关回归通过。没有安排独立安全审查。

MIT LICENSE、原生包版本和历史迁移保持原字节，无新依赖；现有商户界面继续使用
原生 Admin。M0–M6 已提交证据作为历史记录保留，本次结果单独归档于
`platform-email-login-evidence`。旧 M6 发布记录绑定旧源码摘要，不能直接用于此次
追加修改；正式发布需要重新登记当前源码和全部发布验收。本次只是开发登录更新，
原有实际 Stripe/异机恢复/公网 TLS/独立审查等发布门槛仍保留。
