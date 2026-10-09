# M3 实施与验收：原生后台及固定主题商城

2026-10-09。开发基线为 MIT Medusa **2.18.0**，源提交
`1014c0337027a6087410ad3cc1da9a11fd83ca8d`。本批在既有 M1/M2 租户隔离上
接入原生 Admin 和现成参考商城，范围为已审查、已验证的后台及消费者流程。
完整 SaaS MVP 还需要 M4–M6，当前支付仅为 **Test payment**。

## 交付内容

| 工作包 | 本批行为 | 边界 |
|---|---|---|
| 原生商家后台 | 每店 `/app/` 登录、商品/变体/价格/图片、单仓库存创建与调整、订单和客户查询；增加原生 Storefront 设置扩展 | 订单/客户只读；导入导出、员工管理、预留管理和未接受的订单动作隐藏且接口关闭 |
| 固定主题商城 | 首页、列表、商品详情、登录购物车、地址、配送、测试支付、订单确认/历史、账户、移动端 | 不做新主题引擎、拖拽装修或游客结账；不重做已暂停的用户后台 |
| 店铺配置 | 名称、Logo、主色、简介/SEO；按当前 Host 的地区重定向；商品/分类/集合 canonical 使用本店域名 | 平台子域名；不包含自定义域名或主题市场 |
| 浏览器隔离 | 逐请求 Host、客户凭证与公共/私有 API 分离；独立 Owner Session 和客户 Cookie；同源写入检查、有限代理信任 | 不共享身份、商城响应缓存或租户静态页面；不能直连原生无限制服务器绕过网关 |
| 启动与升级 | 严格构建脚本、网关和内部商城生产启动器、显式单店幂等升级命令、可选持久 Worker | 只验证本地构建和临时 TLS；不等于公网部署、生产数据迁移或异机恢复 |

原生 Admin 保留已有 UI，SaaS 模式使用 Session 和当前站点 origin，不内嵌
全局管理员 Token。Storefront 设置是原生 Admin 扩展，不是另一套商家后台。
有限 API 绑定以 `saas/m3-runtime.cjs` 和 HTTP 验证输出 `routeContract` 为准，
不宣称所有原生配置页面和动作都已验收。

商城来源是 MIT `medusajs/nextjs-starter-medusa`，冻结提交
`9818886f06e493cb2249733d114d339aa216ef00`。来源、许可证及捆绑 Yarn 哈希保留在
`saas/storefront/UPSTREAM.json`，使用独立锁文件。根 MIT LICENSE、package.json、
yarn.lock 保持原值。

## 主要实现

- `m3-runtime.cjs`：经审查的原生 method/path/schema 绑定、字段与分页限制、
  写入前对象归属检查、库存批量原子预校验、单仓默认配置。
- `m3-store-products.cjs`：原生销售渠道、计价和税上下文；只返回本店默认启用
  渠道中已发布商品，公共 DTO 不带价格表或内部分类信息。
- `m3-custom-routes.cjs`：后台/公共店铺设置、内容签名校验的图片上传、本店
  明确公开的对象读取。支持 PNG/JPEG/WebP，最多五文件合计 5 MiB，SVG 关闭。
- `m3-frontend.cjs`、`browser-security.cjs`：原生 Admin 资源、固定商城代理、
  Host 与 Origin 检查、转发头过滤、明确 IP/CIDR 代理信任、private/no-store。
- `storefront/src/lib/config.ts`、`lib/tenant.ts`：固定后端地址和有限路径；
  Node HTTP 保留原 Host；逐请求认证；不使用 SDK 的共享身份状态和响应缓存。
- `start-m3.cjs`、`m3-config.cjs`：生产构建检查、内部 Next.js 子进程、稳定
  密钥要求、关闭时清理；数据库和签名密钥不传给商城子进程。
- `initialize-m3.cjs`：核实活跃平台操作员、租户和店主成员关系后，一次明确
  初始化一个租户；重复执行保留店铺配置并记录审计，不处理未知数据归属。

M1/M2 的原生业务模型、Link、RLS/复合 FK、运行角色和持久任务边界继续复用。
历史数据库清单和 Worker 恢复结果见 [M2 报告](10-M2-IMPLEMENTATION.md)，
本批又执行 M1/M2 HTTP 回归；没有把历史原生单租户测试算成本批重新运行。

## 验证结果与复现

最终机器结果在 [m3-evidence/summary.json](m3-evidence/summary.json)，原始日志、
JSON、八张流程截图及 SHA256 清单一起归档。

| 检查 | 本批验收 |
|---|---|
| 原生 Admin 依赖构建 | 12/12 Turbo 任务通过 |
| 原生 Admin 与扩展 | 各自类型检查、生产 Vite 构建通过 |
| 参考商城 | 独立 immutable 安装、类型检查、独立 ESLint、生产 Next.js 构建通过；既有 lint 警告单独记录 |
| M1 HTTP 回归 | 20 项业务检查；21 TAP 含父测试；零失败、零跳过 |
| M2 HTTP 回归 | 27 项业务检查；28 TAP 含父测试；包含独立进程恢复/重放；零失败、零跳过 |
| M3 HTTP | 19 项业务检查；20 TAP 含父测试；零失败、零跳过 |
| 真实启动器/升级 CLI | 3 项行为检查；实际独立进程启动/退出，非只验证测试 fixture |
| Chromium 浏览器 | 17 项检查，两店完整下单；零页面运行错误 |
| 完整入口 | `bash saas/verify-m3.sh` 严格串行完成，退出码 0 |

浏览器使用实际生产 Admin/Next.js、PostgreSQL、原生 API/工作流和双 HTTPS
Host，验证同邮箱独立店主/客户、同 handle 不同价格、原生商品向导发布、图片
渲染、库存创建和调整、品牌设置、canonical、购物车→地址→配送→测试支付→
确认→历史→刷新，以及复制 Cookie/JWT 和异店订单 ID 的拒绝。移动端验证
390×844 的商品/列表无横向溢出。只保存选定界面截图，不保存登录表单、
认证 trace 或浏览器 storage state。

已有测试数据库均为 loopback、固定命名且有 disposable marker。M3 HTTP、
启动器和浏览器测试共享同一测试数据库，必须顺序执行。M1/M2 历史证据经哈希
核对保持不变；本批累计和 M3 增量补丁都执行可应用检查。

本次已配置的云环境中：

```bash
source /workspace/.medusa-baseline/activate.sh
cd /workspace/.medusa-baseline/mit-source
SAAS_ARTIFACT_DIR=/tmp/medusa-m3-results bash saas/verify-m3.sh
```

GitHub 整理版保留相同源码，文档集中到 `docs/saas/`。新克隆须先完成根工作区
immutable 安装、后端依赖和 Loyalty 构建，再运行 M3 检查；具体命令见仓库根
README。需要 Node 22、捆绑 Yarn 3.2.1/4.12.0、Docker、Python Playwright 和
Chromium。新任务恢复与全新机器安装尚未独立验收。

## 已完成代码评审

完整记录见 [12-CODE-REVIEW.md](12-CODE-REVIEW.md)。本批修复标准 SDK 公钥头
校验、规范化 Session Host、Node fetch 改写 Host、参考商城共享状态、原生
重复商品创建表单、Express batch 路由抢占、细粒度归属验证、公共分类字段、
图片上传失败提示、单店 metadataBase 覆盖及配送保存后显式刷新等问题。
这是开发复查与回归验证，不能替代独立安全审计和上线许可检查。

## 配置和后续门槛

稳定数据库/身份密钥、运行角色、对象目录和可信代理由部署环境注入，禁止把
实际值写入源码。现有 M2 店铺先运行 `node saas/initialize-m3.cjs TENANT_ID`；
新增店铺自动初始化。构建后 `node saas/start-m3.cjs` 启动网关默认
`127.0.0.1:9000` 和内部商城 `127.0.0.1:8000`，公网 TLS 入口必须保存 Host
并剥离客户端转发头。完整变量、迁移及单店升级要求见 `saas/M3-README.md`。

单仓配送须配置渠道/Provider 关联、履约集合、国家服务区域和配送选项；
验证 fixture 通过同一原生 API 配置，不虚构免费配送。

| 下一阶段 | 必须补齐 |
|---|---|
| M4 | 商户独立支付沙箱账户/凭据、渠道验签、重复/乱序回调、库存竞争/释放、发货/取消/退款 |
| M5 | 人工套餐与配额、限流/公平性、暂停后的合法履约退款、清理/监控、备份恢复 |
| M6 | 独立安全审查、依赖/CVE/完整分发许可、React/UI 全面兼容、性能与部署/回滚、试点发布 |

参考商城上游已弃用，当前固定 fork 需要持续维护。React 19 与所用 Medusa UI
声明的 React 18 peer range 不完全一致，已测流程通过不代表全部组件已兼容。
本次没有真实扣款、发邮件、公网部署或迁移生产库。AI、Helpdesk、CRM、营销和
网站行为统计继续第二阶段；新增用户后台仍暂停。

M3 原规划预算 80–136 Codex 会话小时；剩余 M4–M6 基础预算合计 144–240h，
加约 25% 余量为 180–300h。以上是范围预算，不能当成本次实测消耗，且不包含
供应商等待或未知生产数据迁移。
