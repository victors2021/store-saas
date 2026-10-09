# Store SaaS

基于 **MIT Medusa 2.18.0** 的电商 SaaS 开发版本：共享进程和 PostgreSQL，
通过 `tenant_id`、可信请求上下文、数据库 RLS 和复合约束隔离店铺。

当前已完成 **M0–M3**，并交付 **M4/M5 本地实现与验收**：独立租户 Stripe、
原生收款/退款与履约、平台管理、人工套餐/配额、暂停后已付款订单处理、
限流/审计/监控及加密备份恢复，复用原生商家 Admin 与固定商城。
实际 Stripe 沙箱/官方回调/Elements、真实异机备份恢复和 M6 发布验收仍待完成。
AI、Helpdesk、CRM、营销及行为统计均为第二阶段。

## 文件入口

| 位置 | 内容 |
|---|---|
| [saas/](saas/) | 租户隔离、迁移、认证、网关、任务、资源、启动器和测试 |
| [saas/M5-README.md](saas/M5-README.md) | 当前运行、迁移、平台管理与备份恢复 |
| [saas/M4-README.md](saas/M4-README.md) | Stripe 测试账户配置与实际渠道验收 |
| [saas/admin/](saas/admin/) | 原生 Admin 的店铺/支付设置和订单操作扩展 |
| [saas/storefront/](saas/storefront/) | 固定 Next.js 商城，含独立锁文件、MIT 许可证与上游来源 |
| [packages/](packages/) | Medusa 原生模块、核心流程及 Admin，包含 SaaS 适配 |
| [docs/saas/](docs/saas/README.md) | PRD、开发/MVP 计划、实施报告、代码评审和历史证据 |
| [M5 实施报告](docs/saas/16-M5-IMPLEMENTATION.md) | 最新交付、实际界面、验收及外部待办 |
| [M5 开发复查](docs/saas/17-M5-CODE-REVIEW.md) | 修复、故障注入和剩余发布门槛 |
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
SAAS_ARTIFACT_DIR=/tmp/store-saas-m5-results bash saas/verify-m5.sh
```

检查脚本使用固定、带 disposable marker 的本地测试数据库，串行运行原生
兼容性、M1–M5 HTTP、实际启动器/升级 CLI、独立实例恢复及浏览器测试。所启动 PostgreSQL/Redis 仅监听
loopback；测试 PostgreSQL 的 trust 认证仅用于临时开发数据。
依赖和构建产物需要在克隆后生成；本仓库不包含 node_modules、真实密钥或数据库。

部署式启动须先按 [M2](saas/M2-README.md) 准备正式迁移和非表所有者运行角色，
并按 [M3](saas/M3-README.md) 注入稳定密钥、数据库/对象目录和可信代理。
已存在的 M2 店铺通过 `node saas/initialize-m3.cjs TENANT_ID` 显式升级，
保留 M4 的独立稳定 `SAAS_PAYMENT_KEY`。停止旧写入者并做匹配备份后，运行
`node saas/migrate-m5-command.cjs`，构建后使用 `node saas/start-m5.cjs`。
M5 对已有对象校验真实字节/hash，旧应用不能连接已升级 M5 数据库；回滚需恢复
匹配数据/对象/密钥。外部流量由保存 Host 的 TLS 入口进入网关，平台 Host 限运维
网络访问。密钥通过安全环境/本店 HTTPS Payments 页面配置，禁止提交源码。
完整步骤见运维手册，迁移/恢复不会作为普通启动自动执行。

## 已验证状态

最新严格检查及截图见 [M5 证据](docs/saas/m5-evidence/summary.json)，覆盖原生
兼容性、M1–M4 回归、M5 运营/配额/暂停/恢复、实际启动器和原生后台/商城。
Stripe SDK 使用自有协议 fixture；实际渠道沙箱/官方回调/Elements 的状态
单独记录，没有用本地测试替代外部验收。备份在本机独立 PostgreSQL 实例恢复，
实际异机复制和恢复仍为 pending。历史 M0–M4 证据保持原哈希。

这些是已配置开发环境的证据；新机器安装/恢复、公网部署、独立安全审计、
完整依赖/CVE/分发许可审查和全面性能/兼容性验收仍需完成。固定商城上游已
弃用，后续升级及维护需要纳入发布计划。

## 来源与许可

Medusa 源基准：`victors2021/medusa` 提交
`1014c0337027a6087410ad3cc1da9a11fd83ca8d`；本仓库从该 MIT 快照开始独立历史。
根 [LICENSE](LICENSE)、package.json、yarn.lock 保持原值。原 Medusa README
保存在 [README.medusa.md](README.medusa.md)，安全回移记录在
[saas/BASELINE.json](saas/BASELINE.json)。参考商城的来源与许可证独立保留。
上游 GitHub 发布、通知、调度及其他自动化配置保存在
[docs/upstream-github-config/](docs/upstream-github-config/README.md)，供后续受控适配。
