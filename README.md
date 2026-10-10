# Store SaaS

基于 **MIT Medusa 2.18.0** 的电商 SaaS 开发版本：共享进程和 PostgreSQL，
通过 `tenant_id`、可信请求上下文、数据库 RLS 和复合约束隔离店铺。

当前包含 **M0–M5** 和 **M6 本地开发验收/发布准备**：租户交易、Stripe 适配、
原生商家 Admin/固定商城、平台管理、人工套餐/配额、加密备份恢复，以及完整
入口/RLS 检查、并发补偿修复、依赖升级、指标/报警演练、持续负载和发布门闩。
实际 Stripe 沙箱/官方回调/Elements、授权真实付款退款、真实异机恢复、目标
部署/报警、独立审查和商户试点仍需实际验收；当前不能宣称生产可用。
AI、Helpdesk、CRM、营销及行为统计均为第二阶段。
现已增加 SaaS 官网、商家邮箱注册/登录、自助开店和模拟商品添加/清除，
以及开发环境的商家/平台演示登录；详情与截图见
[自助开店交付](docs/saas/24-SELF-SERVICE-ONBOARDING.md)。

## 文件入口

| 位置 | 内容 |
|---|---|
| [saas/](saas/) | 租户隔离、迁移、认证、网关、任务、资源、启动器和测试 |
| [saas/M6-README.md](saas/M6-README.md) | 当前安装、严格验证、指标、管理员与受控启动 |
| [saas/M5-README.md](saas/M5-README.md) | 现有迁移、套餐/配额与备份恢复 |
| [saas/M4-README.md](saas/M4-README.md) | Stripe 测试账户配置与实际渠道验收 |
| [saas/admin/](saas/admin/) | 原生 Admin 的店铺/支付设置和订单操作扩展 |
| [saas/portal/](saas/portal/) | SaaS 官网、邮箱账号和网店工作台 |
| [saas/storefront/](saas/storefront/) | 固定 Next.js 商城，含独立锁文件、MIT 许可证与上游来源 |
| [packages/](packages/) | Medusa 原生模块、核心流程及 Admin，包含 SaaS 适配 |
| [docs/saas/](docs/saas/README.md) | PRD、开发/MVP 计划、实施报告、代码评审和历史证据 |
| [M6 实施报告](docs/saas/19-M6-IMPLEMENTATION.md) | 最新开发交付、性能/构建证据与管理员登录 |
| [M6 开发复查](docs/saas/20-M6-CODE-REVIEW.md) | 修复、供应链问题和安全边界 |
| [发布验收](docs/saas/21-RELEASE-ACCEPTANCE.md) | 十项门槛、外部证据格式与发布/恢复顺序 |
| [运维手册](docs/saas/18-OPERATIONS-RUNBOOK.md) | 部署、监控、离机备份、恢复和版本回滚 |
| [M0–M3 历史评审](docs/saas/12-CODE-REVIEW.md) | 原阶段评审记录 |
| [交付说明](docs/saas/13-REPOSITORY-DELIVERY.md) | 整理方式、来源、验证和恢复要求 |

## 开发和验证

需要 Node **22.23.3**，根工作区捆绑 Yarn **3.2.1**，Docker，Python Playwright
和系统 Chromium。本次验证用 Playwright 1.62.0、Chromium 151。确保 `yarn`
命令在本仓库使用捆绑的 Yarn 3.2.1；商城构建脚本直接使用其捆绑 Yarn 4.12.0。

从仓库根目录准备原生后端依赖，再运行当前完整检查：

```bash
export NODE_OPTIONS=--max-old-space-size=4096
export YARN_CHECKSUM_BEHAVIOR=throw
export YARN_NM_MODE=hardlinks-local
yarn install --immutable --inline-builds
yarn turbo run build --filter=integration-tests-http... --filter=@medusajs/payment-stripe... --concurrency=3 --no-daemon
yarn workspace @medusajs/loyalty-plugin build:plugin
SAAS_ARTIFACT_DIR=/tmp/store-saas-m6-results bash saas/verify-m6.sh
```

检查脚本使用固定、带 disposable marker 的本地测试数据库，串行运行原生
兼容性、M1–M6 HTTP、实际启动器/升级 CLI、独立实例恢复、浏览器、安全和持续负载测试。
完整 M6 检查含 30 分钟负载，另需构建、数据生成和冲突结账时间。PostgreSQL/Redis 仅监听
loopback；测试 PostgreSQL 的 trust 认证仅用于临时开发数据。
依赖和构建产物需要在克隆后生成；本仓库不包含 node_modules、真实密钥或数据库。

部署式启动须先按 [M2](saas/M2-README.md) 准备正式迁移和非表所有者运行角色，
并按 [M3](saas/M3-README.md) 注入稳定密钥、数据库/对象目录和可信代理。
已存在的 M2 店铺通过 `node saas/initialize-m3.cjs TENANT_ID` 显式升级，
保留 M4 的独立稳定 `SAAS_PAYMENT_KEY`。停止旧写入者并做匹配备份后，运行
`node saas/migrate-m5-command.cjs`。当前还追加 0008 平台登录和 0009 自助开店迁移，
旧迁移保持原字节；受控生产启动使用
`NODE_ENV=production SAAS_RELEASE_MANIFEST=/ABSOLUTE/acceptance/release.json node saas/start-m6.cjs`。
证据不足时在连库之前返回退出码 2；开发复现入口见 M6 README。
M5 对已有对象校验真实字节/hash，旧应用不能连接已升级 M5 数据库；回滚需恢复
匹配数据/对象/密钥。外部流量由保存 Host 的 TLS 入口进入网关，平台 Host 限运维
网络访问。密钥通过安全环境/本店 HTTPS Payments 页面配置，禁止提交源码。
完整步骤见运维手册，迁移/恢复不会作为普通启动自动执行。

## 已验证状态

最新严格检查及截图见 [M6 证据](docs/saas/m6-evidence/summary.json)，覆盖原生
兼容性、M0–M5 回归、M6 安全/并发/部署恢复/门槛和 30 分钟参考数据负载。
Stripe SDK 使用自有协议 fixture；实际渠道沙箱/官方回调/Elements 的状态
单独记录，没有用本地测试替代外部验收。备份在本机独立 PostgreSQL 实例恢复，
实际异机复制和恢复按用户决定为发布 deferred。历史 M0–M5 证据保持原哈希。
自助开店的当前追加验证单独保存在
[自助开店证据](docs/saas/self-service-evidence/summary.json)，未重复历史完整构建或容量测试。

已完成同一主机新目录的 immutable 安装和无缓存重建，以及本地 TLS/匹配 M6
快照恢复。新云任务恢复、公网部署、独立安全审计、剩余依赖/CVE/分发许可
审查、参考硬件与真实渠道验收仍需完成。固定商城上游已
弃用，后续升级及维护需要纳入发布计划。

## 来源与许可

Medusa 源基准：`victors2021/medusa` 提交
`1014c0337027a6087410ad3cc1da9a11fd83ca8d`；本仓库从该 MIT 快照开始独立历史。
根 [LICENSE](LICENSE)、原生 2.18.0 模块版本与已应用迁移保持原值。M6 为安全
升级明确修改根/商城 manifest 和 lockfile，并将根 checksum 默认改为 throw。
原 Medusa README
保存在 [README.medusa.md](README.medusa.md)，安全回移记录在
[saas/BASELINE.json](saas/BASELINE.json)。参考商城的来源与许可证独立保留。
上游 GitHub 发布、通知、调度及其他自动化配置保存在
[docs/upstream-github-config/](docs/upstream-github-config/README.md)，供后续受控适配。
