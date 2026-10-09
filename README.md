# Store SaaS

基于 **MIT Medusa 2.18.0** 的电商 SaaS 开发版本：共享进程和 PostgreSQL，
通过 `tenant_id`、可信请求上下文、数据库 RLS 和复合约束隔离店铺。

当前已完成 **M0–M3** 的已审查范围，包含租户/身份、原生交易隔离、持久任务，
以及原生商家 Admin 和固定主题商城。双店铺商品、库存和浏览器下单已验证。
支付方式为 **Test payment**，完整 MVP 的商户真实支付、履约/退款和发布门槛
仍在 M4–M6。AI、Helpdesk、CRM、营销及行为统计均为第二阶段。

## 文件入口

| 位置 | 内容 |
|---|---|
| [saas/](saas/) | 租户隔离、迁移、认证、网关、任务、资源、启动器和测试 |
| [saas/M3-README.md](saas/M3-README.md) | 当前运行配置、原生 Admin/商城边界及单店升级 |
| [saas/admin/](saas/admin/) | 原生 Admin 的 Storefront 设置扩展 |
| [saas/storefront/](saas/storefront/) | 固定 Next.js 商城，含独立锁文件、MIT 许可证与上游来源 |
| [packages/](packages/) | Medusa 原生模块、核心流程及 Admin，包含 SaaS 适配 |
| [docs/saas/](docs/saas/README.md) | PRD、开发/MVP 计划、实施报告、代码评审和历史证据 |
| [M3 实施报告](docs/saas/11-M3-IMPLEMENTATION.md) | 最新交付、验证及下一步 M4 |
| [代码评审](docs/saas/12-CODE-REVIEW.md) | 已修复问题和剩余发布门槛 |
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
yarn turbo run build --filter=integration-tests-http... --concurrency=3 --no-daemon
yarn workspace @medusajs/loyalty-plugin build:plugin
SAAS_ARTIFACT_DIR=/tmp/store-saas-m3-results bash saas/verify-m3.sh
```

检查脚本使用固定、带 disposable marker 的本地测试数据库，串行运行 M1/M2/M3
HTTP、实际启动器/升级 CLI 及浏览器测试。所启动 PostgreSQL/Redis 仅监听
loopback；测试 PostgreSQL 的 trust 认证仅用于临时开发数据。
依赖和构建产物需要在克隆后生成；本仓库不包含 node_modules、真实密钥或数据库。

部署式启动须先按 [M2](saas/M2-README.md) 准备正式迁移和非表所有者运行角色，
并按 [M3](saas/M3-README.md) 注入稳定密钥、数据库/对象目录和可信代理。
已存在的 M2 店铺通过 `node saas/initialize-m3.cjs TENANT_ID` 显式升级，
构建后使用 `node saas/start-m3.cjs`。外部流量由保存 Host 的 TLS 入口进入
SaaS 网关。

## 已验证状态

M3 严格检查退出码 0：原生 Admin 依赖 12/12 构建任务、Admin/扩展类型检查、
商城安装/类型/lint/生产构建通过；M1/M2/M3 HTTP 分别通过 20/27/19 项业务
检查；实际启动器/升级通过 3 项，真实浏览器通过 17 项且零页面运行错误。
日志、截图、补丁及哈希清单见 [M3 证据](docs/saas/m3-evidence/summary.json)。

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
