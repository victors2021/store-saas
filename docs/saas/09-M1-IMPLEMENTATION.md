# M1 六步实施与验收

2026-10-08。用户授权实施 M1 六个步骤。开发源为独立 MIT Medusa 2.18.0：`/workspace/.medusa-baseline/mit-source`，基准 `1014c0337027a6087410ad3cc1da9a11fd83ca8d`。原仓库保持未修改。AI、Helpdesk/CRM 和新商家界面不进入本批。

## 1. 已实现的六步

| 步骤 | 交付 | 范围与验收 |
|---|---|---|
| 1 归属与接口清单 | `M1-SCOPE.md`、`m1-ownership.json`、可复跑 AST 生成器 | 枚举 129 个 DML 定义、322 个原生路由文件/479 个方法路径、22 个物理 Link/14 个只读 Link；M2 未审查项明确标记。清单不会自动开放接口 |
| 2 原生模型与迁移 | DML `.tenantScoped()`、隐式 pivot、Link 元数据、0002/0003 版本迁移 | 必填租户列、租户内唯一约束、复合外键和强制 RLS；无默认租户。新库重建与重跑通过；未归属旧数据拒绝自动迁移 |
| 3 真实租户数据 | `saas_control` 的 tenant/membership/domain/platform_identity/audit_event | 固定店主、平台子域名、公钥、初始化租约和 HMAC 输入指纹；并发幂等、失败重试和过期租约恢复；替换先前 fixture 成员关系 |
| 4 原生身份接入 | 原生 Auth/User/Customer、emailpass、JWT 和 Session | 同邮箱跨店及店主/消费者身份分开；账号绑定验证邮箱与租户归属；原生认证查询传递事务上下文 |
| 5 HTTP 上下文与守卫 | `m1-application.cjs` 的默认关闭路由和字段清单 | 店铺 Host 在服务端解析；Token/Cookie 再查实际身份、店主与成员关系；body/query/header 不能提供租户；Session 登录轮换 SID |
| 6 真实双租户验收 | `m1-http.test.cjs`、`verify-m1.sh` | 原生登录、Admin me、商品工作流 CRUD、Store 商品读取、消费者注册；跨租户 ID/关系、伪造会话、连接池和并发读写检查 |

可复跑和启动说明见 [M1 开发说明](../.medusa-baseline/mit-source/saas/M1-README.md)。实际应用是受限的 M1 HTTP 网关：启动真实原生模块并接入原生 HTTP Handler/Validator 和同步工作流。消费者创建使用原生 Customer/Auth 服务及确定性重试 ID。

## 2. 实现中的关键修正

- 原生 Auth provider 查找、创建、更新和 MFA 检查此前没有完整传递 sharedContext；现已沿原生事务传递，标准单租户行为保留。
- 原生库存校验对空集合提前返回，商品不启用库存时不解析未启用的仓库域。M1 对实际库存操作仍明确拒绝。
- 原生 catalog 工作流查询空关联 ID 集合时，M1 Legacy RemoteQuery 适配器直接返回空集合；非空查询保留原生行为。
- 公共查询字段限定在 Product/Pricing 范围，Graph 缓存关闭，不能展开到尚未改造的库存、渠道或配送域。
- 应用账号除了不能 superuser/BYPASSRLS 或拥有表，还不能成为普通表所有者角色的成员，避免 SET ROLE 后关闭 RLS。
- 开店初始化先尝试受原密码校验保护的注册，再回退已绑定身份登录；实测认证 identity 已提交而 metadata 绑定中断时，相同请求可以恢复。
- 商品关联先校验本租户对象，已知外来集合/变体不会导致部分更新；客户注册 token 不能绑定另一邮箱。

## 3. 验证证据

最终整体验证脚本退出码为 0，74 个构建任务通过。结果与原始日志保存到 [m1-evidence](m1-evidence/summary.json)。本报告仅使用成功完成的执行记录；失败调试轮次不计入通过。

- 原生 HTTP 双租户验收：20 个业务检查；Node TAP 包含一个父用例，共 21 项。包括 40 个并发读取、40 个并发写入、相同 handle/SKU、计数与价格关系展开、会话轮换和中断恢复。
- 真实 PostgreSQL 控制数据检查：16 项。
- 原生 catalog 版本迁移检查：8 项；41 张表（含未开放的空 Link）、13 个业务唯一索引、24 个租户复合外键。
- 身份迁移：12 张 Auth/User/Customer 相关表。与 catalog 合计 53 张受保护业务/pivot/Link 表；不表示其他交易域已经隔离。
- 原生 Auth 模块数据库回归：51 项；认证适配器单元检查：11 项，数据库事务部分使用 mock。
- Utils 原生回归：102 套、543 通过、1 跳过；最终 DML/多对多针对性回归：82 项。两组存在覆盖重叠，不相加为独立用例数。
- 原生交易 HTTP 回归：246 项通过、10 项跳过；商品变体 17 项、价格 49 项、Framework 35 项、emailpass 11 项、首批 ORM 试点 20 项在最终验证脚本中重新执行。这些原生回归关闭 SaaS 模式，不替代 M1 双租户验收。

完整复跑脚本：`source /workspace/.medusa-baseline/activate.sh` 后在开发目录执行 `bash saas/verify-m1.sh`。脚本保留失败退出码，只重置固定名称并带标记的本地测试数据库。

## 4. 数据与生成器边界

`MEDUSA_SAAS_MODE=true` 必须在模型加载前设置；普通原生回归显式关闭此模式。租户列只读取当前事务的 `app.tenant_id`，没有缺失时的默认归属。

复合 FK/RLS 由独立版本迁移和 checksum ledger 管理。原生 Link 重复生成计划全部 noop，保留租户约束。ORM 无法表达所有外部 RLS/FK，故不声称原始模块 schema diff 完全为空；破坏性生成器操作拒绝并要求版本迁移审查。启动前验证实际列、RLS 策略、唯一性、FK 和角色，不能只凭 ledger 判定就绪。

已存在且归属不明的数据不会自动分给首个租户。此次只创建带标记的临时本地测试库，没有迁移未知生产数据。

平台身份通过离线迁移连接预置；Runtime 只有其 SELECT 权限，商户成员不能获取平台权限。开店请求从平台凭据得到操作者，服务端生成 owner ID，冻结凭据 HMAC 指纹；原密码和密钥不写入控制表或代码。

M1 店主成员身份不可转移/撤销；暂停租户会停止所有 M1 店铺接口。普通成员撤销的存储授权检查已经验证，但商户员工登录和管理界面未开放。已付款订单、回调、履约和退款的暂停例外属于 M4/M5，尚未实现。

## 5. 当前开放范围与后续工作

开放原生 emailpass 登录、消费者注册、绑定的 Session、Admin me、商品列表/创建/详情/更新/删除和 Store 商品读取；其余 method/path 默认拒绝。商品变体要求 `manage_inventory=false`；库存、渠道和配送配置不能借商品接口调用。上传、批量、导入导出、MFA/OAuth/重置/刷新、订单、购物车和支付接口保持关闭。

M1 验证了原生 Admin 的已开放 HTTP 操作，没有进行完整 Admin 浏览器导航、整套表单或参考店面 E2E。两者的适配仍是 M3，独立用户后台界面稿继续暂停。

HTTP Session 当前为进程内存，事件总线为原生 local。共享持久化 session、worker/retry、事件租户恢复、缓存/锁/文件和部署 TLS/代理配置仍待后续阶段；M1 的同步工作流通过不代表这些路径通过。

下一步 M2：按归属矩阵实施客户扩展、购物车/订单/支付/库存/仓库/渠道/配送/税费/区域及其 Link、事务旁路和持久任务隔离，再进入 M3 后台/店面适配。Region Country 的 ISO 主键与可变 Region 归属需单独设计，不能直接当共享字典。

完整 SaaS MVP 尚未完成；真实支付、恢复/回滚、性能、完整 Store 安全、依赖漏洞核验、SBOM/NOTICE 与独立审查仍是发布门槛。本批没有发布应用、推送仓库或产生真实支付。

云环境启动说明草稿已加入 M1 开发与复跑说明，状态为已保存、待发布。后续云任务复用仍需在环境设置中保存/发布；新环境完整恢复本批未提交源码与证据尚未验证。
