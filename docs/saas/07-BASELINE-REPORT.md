# 第一轮基线验证报告

后续更新：订单失败已由插件构建补齐关闭，真实 ORM 隔离试点已执行；最新结果见 [第一批代码实施报告](08-IMPLEMENTATION-PROGRESS.md)。本报告保留首轮历史结果。

验证日期：2026-10-08。范围：原生 Medusa → tenant_id SaaS 的第一阶段；AI、Helpdesk、CRM、营销和行为分析增强不在本轮范围内。

## 结论

**第一轮验证与证据整理完成，但尚未达到完整基线就绪条件。** 找到可构建、可运行核心交易测试的历史 MIT 候选版本；原生 Medusa 并没有租户隔离。订单信用额度测试存在可重复失败，需要解释或修复后关闭交易基线问题。RLS 机制验证支持继续做 Medusa ORM 试点，不能替代实际 SaaS 隔离验收。

本轮没有改造业务源码、加入 tenant_id、实现真实 SaaS 或接通外部支付。原仓库保持未修改。交互 HTML 是独立产品原型。

## 1. 版本与许可

| 项目 | 实际证据与判断 |
|---|---|
| 用户提供分支 | victors2021/medusa，develop；现有 HEAD `340da77f722a5a53c48bf35276f96ec261a65736`，版本 2.21.1 |
| 当前许可风险 | 存在 ENTERPRISE-LICENSE.md，RBAC/SSO 指定路径及其构建转换产物有企业许可范围；不能以关闭开关代替许可审查 |
| 本轮测试候选 | `1014c0337027a6087410ad3cc1da9a11fd83ca8d`，Medusa 2.18.0；用 git archive 在仓库外建立源快照，没有重置原分支 |
| 候选选择依据 | 位于许可变更提交 `21abe66783ce5eac6a982dc5304f02231a9c3fa6` 之前；候选根 LICENSE 为 MIT，没有 ENTERPRISE-LICENSE；新许可说明未撤销此前授予的 MIT 权利 |
| 依赖扫描 | 顶层安装目录扫描 1,899 个包；15 个没有 license 元数据，部分包含许可文件或受工作区根许可覆盖。尚未完成所有传递依赖、分发产物和 NOTICE 的逐项复核 |

建议先冻结上述候选作为隔离试点输入，再确认最终产品基线。使用较旧版本意味着需要评估之后的安全修复与功能差异；此项尚未完成。不能直接把现有 develop 整体视作 MIT 版本。

版本、源文件 SHA256 见 [源码清单](baseline-evidence/source-inventory.json)，依赖扫描见 [许可元数据](baseline-evidence/dependency-license-inventory.json)。这是工程许可范围检查，不是完整法律审查。

## 2. 环境、构建与运行

| 检查 | 结果 | 实际范围 |
|---|---|---|
| Node / Yarn | 通过 | Node 22.23.3、Yarn 3.2.1，使用候选仓库自带 Yarn |
| 依赖安装 | 通过 | immutable 安装；保留完整性检查与 TLS 验证 |
| PostgreSQL / Redis | 通过 | PostgreSQL 16.15、Redis 7；数据库查询及 Redis PONG |
| 核心依赖构建 | 通过 | Turbo 74/74 任务成功，包含 HTTP 测试依赖 |
| 原生 Admin 前端构建 | 通过 | Dashboard Vite build:preview 成功；存在大于 500 KB chunk 警告 |
| 工具层单元测试 | 通过 | 101 个套件；539 项通过，1 项跳过；23 个快照通过 |
| 服务启动、迁移与 HTTP | 部分通过 | 集成测试实际启动 Medusa 并执行交易 API；不是生产部署或浏览器端原生 Admin 全流程验收 |

PostgreSQL 为仅绑定 loopback 的一次性测试容器，使用 trust 认证；不能复用为生产安全配置。Redis 同样仅绑定 loopback。日志在本目录 evidence 下保存。

运行交易测试必须使用 `DB_HOST=localhost`：仓库测试帮助函数对 localhost 采用本地数据库路径。第一次使用 127.0.0.1 触发该帮助函数的非本地 SSL 分支，与本地容器配置不符，已停止并更正后重新执行；没有通过关闭 TLS 验证绕过远程连接检查。

## 3. 核心交易测试结果

执行了五个仓库自带 HTTP 集成测试文件：

| 文件 | 结果 |
|---|---|
| cart/store/cart.spec.ts | 通过 |
| product/store/product.spec.ts | 通过 |
| payment/admin/payment.spec.ts | 通过 |
| customer/store/customer.spec.ts | 通过 |
| order/admin/order.spec.ts | 失败：1 项 |

汇总：**238 通过、1 失败、9 跳过，共 248 项；4 个套件通过、1 个失败。** 支付测试使用测试环境的系统/模拟 Provider；没有接通 Stripe 等真实商户账户或验证真实资金流。

失败项：`POST /orders/:id/credit-lines should successfully create credit lines`。测试在 `order.spec.ts:4164` 期望匿名客户的负信用额度请求返回 HTTP 400 及 “Store credit refunds can only be issued to registered customers”，却在读取 `error4.response.status` 时得到 undefined。该断言把成功响应/无 response 的错误当作 HTTP 错误响应读取，不能仅由此 TypeError 判定服务崩溃。

**对该测试单独重跑，仍在同一行失败。** 使用仓库外候选快照中的临时诊断测试副本记录返回状态，确认该请求实际返回 **HTTP 200**，而非测试预期的 400；诊断副本执行后已删除，原测试保持不变。仍需确认是功能契约变化、测试过时还是业务校验缺陷。候选信用额度工作流的静态检查没有发现这句匿名客户校验；需继续沿实际路由与工作流确认。不得删掉失败断言或把重跑失败算作通过。

下一步：确认是否允许匿名客户负信用额度；明确目标版本的预期行为，修复后跑对应订单编辑/退款回归。相关功能需要在上线前闭环。

测试日志另有 `Connection ended unexpectedly` 输出；通过套件中也出现，尚未完成连接关闭顺序诊断，不将其直接认定为生产故障。

证据：[完整交易结果](baseline-evidence/http-results.json)、[单项复测](baseline-evidence/credit-line-retest.json)、[交易日志](baseline-evidence/http-tests.log)、[响应诊断日志](baseline-evidence/credit-line-diagnostic.log)。本轮不是全仓库测试，也没有外部物流、邮件发送或真实支付验收。

## 4. 租户隔离源码盘点

- 35 个模块目录；154 个模型目录 TS 文件（计数包含 index 导出文件），扫描没有发现 tenant_id 字段。该计数不等于实际数据库表数。
- 322 个 API route.ts 文件：Admin 259、Store 46、Auth 14、Cloud 2、Hooks 1。清单不是逐个权限/旁路审计的完成证明。
- 52 个模型文件包含唯一约束；商品 handle、客户 email/has_account 等全局约束需按业务归属重新设计。
- Link 中间表、Query Graph/索引、Workflow、任务、缓存和对象存储必须携带可信租户上下文，不能只给主要业务表加字段。
- Payment Provider 由容器按注册标识解析；逐租户配置不能通过修改共享单例的密钥实现。需要逐租户配置解析、连接/实例策略以及回调账户归属验证。

交付 [模型归属初表](baseline-evidence/model-inventory.csv) 与 [API 入口清单](baseline-evidence/api-entrypoints.csv)。行状态仍为“需要审查”，不假设所有国家/币种等参考数据都必须归属租户。

## 5. PostgreSQL RLS 机制试验

对独立合成 product/variant/link 表执行 9 项检查，全部通过：

1. 两租户可使用相同商品 handle。
2. 跨租户读取不可见。
3. 跨租户更新/删除影响 0 行。
4. 伪造租户写入被拒绝。
5. 跨租户外键被拒绝。
6. 跨租户 Link 被拒绝。
7. 连接池复用后无上下文读取 0 行、写入被拒绝。
8. 40 个并发任务使用事务局部上下文，结果按租户隔离。
9. 应用角色非超级用户、无 BYPASSRLS。

采用 FORCE RLS、组合租户外键以及事务局部 `set_config`。这个试验只证明本 PostgreSQL 环境的机制可行，**没有接入 Medusa MikroORM、Query Graph、跨模块工作流或后台任务**。它也不是攻击者可任意执行 SQL 时的隔离证明：应用必须控制 tenant 上下文及数据库权限。

独立合成数据库执行 dump/restore，恢复后 2 条商品数据和 3 条 RLS 策略存在。未验证完整 Medusa 数据备份、租户粒度恢复或生产恢复时限。

证据：[机制结果](baseline-evidence/rls-results.json)、[可复跑试验脚本](baseline-evidence/rls-probe.cjs)。

## 6. 基线矩阵状态与剩余工作

| ID | 本轮状态 | 仍需完成 |
|---|---|---|
| B01 版本 | 已完成识别 | 最终基线冻结与新旧版本差异评估 |
| B02 许可 | 找到 MIT 候选，部分完成 | 依赖/分发产物 NOTICE 复核 |
| B03 环境 | 本地测试环境通过 | 生产安全配置 |
| B04 构建/启动 | 构建通过，集成服务可启动 | 原生 Admin/参考 Storefront 浏览器验收 |
| B05 交易 | 238 通过，1 失败，9 跳过 | 信用额度失败解释或修复，未覆盖交易场景 |
| B06 并发/异常 | 测试覆盖部分场景 | 原生交易竞争/重试/幂等性专项；不可用合成 RLS 并发替代 |
| B07 数据归属 | 静态初表完成 | 逐表/Link/索引迁移设计与确认 |
| B08 入口 | 静态入口清单完成 | 路由、Graph、Workflow、订阅者、任务的逐项旁路审计 |
| B09 ORM/RLS | 合成机制 9 项通过 | 实际 Medusa ORM/连接池/跨模块试点与负向测试 |
| B10 Provider | 解析方式初查 | 逐租户支付配置和验签/账户归属测试 |
| B12 运维/容量 | 合成数据库恢复通过 | 完整 Medusa 恢复、任务重启、10 租户负载与服务器容量测量 |

目前没有“单标准服务器能承载多少租户”的实测结论。没有部署 10 个真实租户，也没有完成商品→购物车→订单→支付→库存的 tenant_id 试点。完整基线原估 24–40 Codex 会话工时仍需按上述剩余项修正，本轮构建和执行耗时不能外推为整个 SaaS 改造工时。

## 7. 交互原型交付

[打开 SaaS 交互 HTML](saas-prototype.html)：平台运营、商家工作台、消费者店面三种视角。可演示商户创建/搜索/暂停/恢复/配额、商品发布、购物袋、模拟下单、发货和退款。浏览器 localStorage 保存模拟状态，设置页可以恢复初始数据；无需外部服务。

[桌面预览](prototype-desktop.png) · [手机预览](prototype-mobile.png) · [13 项浏览器检查结果](prototype-checks.json)。

该原型说明信息架构和流程，不是已接入 Medusa 的 SaaS 应用，也不是生产 tenant_id 隔离。客户端商户切换用于演示，不代表真实系统允许未授权切换。真实 MVP 仍优先复用原生 Admin 和参考店面，按原型审核所需页面，而不是另造完整电商后台。AI 与客户运营保持第二阶段。
