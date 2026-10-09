# M2 交易隔离与异步恢复实施

2026-10-08。开发源：独立 MIT Medusa 2.18.0，`/workspace/.medusa-baseline/mit-source`，基准 `1014c0337027a6087410ad3cc1da9a11fd83ca8d`。M2 延续共享实例、共享 PostgreSQL 的 tenant_id/RLS 方案。AI、Helpdesk/CRM/营销仍在第二阶段，新商家界面继续暂停。

## 1. 交付范围

| M2 工作 | 已交付 | 验收边界 |
|---|---|---|
| 交易模型与配置 | Cart、Order、Payment、Inventory、Stock Location、Sales Channel、Fulfillment、Region、Tax、Promotion、API Key、Store、Workflow 模型及关联 | 0004 迁移纳入 M1 模型，共保护 130 张原生业务/pivot/Link 表；0005 增加 4 张租户运行表。未归属旧业务数据拒绝自动迁移 |
| CRUD/批量/关系 | 原生服务事务守卫、租户内唯一、复合 FK、软删恢复、list/count、Graph/Link | 库存批量跨租户引用整批回滚；商品文本搜索只查本店。Index 模块关闭，不声称已验收原生索引搜索 |
| 购物车到订单 | 原生 Handler/Validator、Workflow、服务端计价、优惠、Payment Collection/Session、订单 | 两店同邮箱/handle/SKU/优惠码/幂等键，分别下单；支付仅用原生系统测试提供者，无外部收款 |
| 工作流/事件/重试 | SQL checkpoint、签名任务、分组事件、持久化 retry/timeout、失败补偿 | 进程重启后恢复原租户；工作流完成后丢失任务确认不会再建购物车；实际异步步骤重试和原生补偿通过 |
| 缓存/锁/文件/会话 | SQL 缓存与锁、任务租约续期与旧确认隔离、本地私有对象、签名读取、加密 PostgreSQL Session | 相同资源键跨店独立；文件和 Cookie 跨 Host 被拒绝；未接 S3/CDN，HTTP 上传/导出仍关闭 |
| 回调及未开放入口 | 服务端凭据映射、原始请求体验签、账户校验、重放幂等的内部契约；明确 API 白名单 | 不接收 body tenant 作为授权；真实渠道适配、密钥生命周期和支付业务在 M4。HTTP 回调/退款/导出等未验收入口直接拒绝 |

应用仍是显式 SaaS 网关，复用原生 Medusa 服务、HTTP Handler/Validator 和工作流；不是直接启动不受限制的原生服务器。后台浏览器和参考店面尚未完成，M2 并不表示完整 SaaS MVP 已可试运营。

可复跑、迁移、环境变量和启动说明见 [M2 开发说明](../.medusa-baseline/mit-source/saas/M2-README.md)。

## 2. 关键实现与修正

Region Country 带有可变 Region 归属，不能把全局 ISO 字典直接共享。原生全局初始化被关闭，国家按租户初始化，主键变为 `(tenant_id, iso_2)`。原生 Workflow Execution 同样改为包含租户的组合主键。

Payment/Tax/Fulfillment Provider 是共享只读的提供者定义，业务账户和支付记录属于租户。运行角色不能写这些目录，也不能 SET ROLE 到具有写权限的角色。商户密钥尚未配置；当前使用系统测试支付、系统税费和手动配送定义。

原生库存数量查询和促销规则 SQL 改为使用真实事务连接，避免 SET LOCAL 与查询落在不同连接。模块调用禁止输入 tenant/外来 manager，输出去掉归属列，原生 Auth 的服务端 metadata 保留用于 JWT 绑定。Graph 经过同一模块守卫，Graph 缓存关闭。

原生 Link 没有全部建立数据库外键。M2 固定清单补上两端归属约束；验证中发现的 FulfillmentSet 命名映射缺口已修复并加入跨店配送关联负向验收。清单包含隐式多对多表，不依赖运行时可变的生成报告。原生生成器对正式共享 Provider 外键的识别也已修正；20 个 Link 重复生成计划全部为 noop，执行后启动约束检查仍通过，其他未审查 schema 变更继续拒绝自动执行。

原生 Payment migration 会预置三条无租户退款原因。默认拒绝转换；只有显式开启窄范围标志、数据严格等于原生未修改种子且没有退款时，才移除这三条引用种子并在每店初始化时重建。该路径不是旧业务数据自动归属方案。

持久任务的 envelope 绑定租户、操作者、job ID、kind 和数据指纹。Worker 查真实租户/成员或本店客户后恢复不透明上下文，SKIP LOCKED 领取，续期租约，重试并隔离旧 worker 的确认。业务副作用仍是至少一次交付语义，每个处理器必须使用持久幂等；原生购物车/下单已使用 SQL checkpoint。异步工作流可能产生后续 resume job，需要 worker 持续处理，不能把第一次确认当作工作流完成。

本地私有文件路径按租户哈希分区，元数据经 RLS，下载签名仍绑定当前租户上下文。Session 按 Host/SID 生成 HMAC 键，并用 AES-GCM 加密持久化，登录 SID 轮换延续 M1。

启动不仅查 migration ledger，还查实际 RLS、主键、FK、提供者权限、缓存/锁组合主键以及 dispatch/session 表结构和授权。禁用 RLS、改成全局缓存主键、给 PUBLIC 开会话表或使共享提供者可写，都会拒绝启动。RLS 不限制 TRUNCATE，因此运行角色直接、继承或通过 SET ROLE 取得清空表等额外权限也会拒绝；NOINHERIT 成员角色的旁路已有负向验收。

## 3. 验证记录

完整验证脚本退出码为 0，74 个构建任务通过。补修 Link 重复迁移后，针对性构建 13 项、M1 迁移 8 项及 M2 验收再次通过；加强为独立 Node 进程验收后，M2 再次退出 0。结果见 [M2 证据摘要](m2-evidence/summary.json)。M1 历史证据保持在原目录；本批 44 份报告/日志/结果/补丁另加 SHA256 清单单独归档，不把失败调试记录计入通过。

- M2：27 项业务检查，Node TAP 含父用例共 28 项通过、0 失败；包含 40 个并发交易读取、两次应用重建及三个独立 Node worker 进程。步骤重试在新进程完成；购物车完成但任务未确认时实际 SIGKILL，再启动另一进程重放，购物车数量不增加。20 个原生 Link 重复生成计划全部 noop。
- 真实数据库：134 张强制 RLS 表，其中原生业务/pivot/Link 为 130 张、运行表为 4 张；142 个租户复合 FK、8 个共享只读 Provider FK，100 个含 tenant 的非主键唯一索引。0004 报告的 45 个业务索引已包含其中，不能重复相加。
- M1：20 项业务 HTTP 检查（TAP 21 项）、16 项控制数据检查、8 项迁移检查、11 项认证适配器检查；首批原生 ORM 试点 20 项重跑通过。适配器的事务单元测试使用 mock，不替代真实 HTTP/数据库证据。
- 原生模式关闭：交易 HTTP 246 通过、10 跳过；Pricing 49、Product Variant 17、Framework 35、emailpass 11 全部通过。
- Utils：102 套、544 通过、1 跳过、23 个快照通过。单独 DML 租户 metadata 检查 5 项也通过；它与 Utils 覆盖重叠，不能当作额外独立用例累计。

复核补丁：[M2 增量补丁](m2-evidence/03-m2-incremental.patch)；重建补丁：[M0–M2 累计补丁](m2-evidence/02-m0-m1-m2-cumulative.patch)。增量补丁以前一批归档的 M1 为基础，累计补丁以前述 MIT commit 为基础；已分别完成正向临时 index 和反向工作树检查，没有创建 commit 或改动原仓库。

验收使用真实原生模块、PostgreSQL 和 HTTP 请求，覆盖两个实际开通店铺。测试目标包括：双店原生下单、跨店已知 ID/字段/关系拒绝、价格输入拒绝、批量回滚、库存 raw SQL、地区/税费独立配置、运费价格 Link、并发读取、资源隔离、签名任务篡改、租约争抢及续期、回调账户契约、重试/补偿及两次应用重启。

邮件/导出验证是受签名 worker 约束的原生查询处理器：收件人从本店客户查询，导出集合从本店订单查询。没有实际发邮件、生成可下载导出或开放相关 API。回调验签使用参考 HMAC 契约，不代表 Stripe/PayPal 等渠道已适配。

完整复跑命令：

```bash
source /workspace/.medusa-baseline/activate.sh
cd /workspace/.medusa-baseline/mit-source
SAAS_ARTIFACT_DIR=/tmp/medusa-m2-results bash saas/verify-m2.sh
```

脚本先执行原生模式关闭时的交易回归和全部 M1 验收，再执行 M2 DML 与双租户验收。数据库 reset 只接受固定名称和精确标记的本地一次性测试库。没有重置或迁移未知数据。

## 4. 当前开放与关闭边界

延续 M1 的原生登录、消费者注册、商品 CRUD 和 Store 商品读取。新增已认证消费者购物车创建/读取/修改、商品/优惠/配送添加、系统测试支付会话、下单与自己的订单详情；店主可读取本店订单、地区、渠道、仓库、库存、配送、税费及优惠列表。创建购物车和下单要求幂等键。

消费者必须拥有本店购物车/订单；地址只接收新地址数据，不接收已有地址 ID。当前不开放游客结账。商品允许引用本店渠道、配送模板和库存对象，但完整库存结账并发及失败释放仍需 M4 验收。

完整原生 Admin 表单/导航、店面页面和新增配置 CRUD 属于 M3；未审查 method/path 仍拒绝。HTTP 回调、退款、上传、导出、工作流管理/SSE、循环工作流、API Key 管理、OAuth/MFA 等保持关闭。原生 Redis workflow 只补模型 metadata，未通过其 Redis 存储与调度路径验收；当前启用 in-memory engine + SQL checkpoint + 持久任务。

Graph 缓存、Index 搜索、S3/CDN、循环清理暂未启用。本地文件后端已经验证服务层边界，但不能作为多台服务器共享对象存储的验收。自定义事件处理器必须在每次启动注册；没有处理器的恢复任务拒绝执行。内部上下文五分钟过期，长任务需分片，租约续期不会扩张授权。

暂停租户仍停止全部店铺业务访问；已付款订单履约、回调和退款例外待 M4/M5。共享订单显示号序列仅供显示，不是授权依据，不能承诺每店连续编号。队列公平性、配额、死信和积压监控属于 M5。

## 5. 后续里程碑与工时口径

接下来进入 M3：复用实际原生 Admin 和参考店面，补齐所需 API 白名单/字段与配置 CRUD，完成双域名浏览器商品、购物车、结账和会话验收。继续暂停独立商家界面稿。

随后 M4 实施逐店商户账户和安全凭据、真实供应商验签、金额/重复/乱序回调、库存竞争、发货/取消/退款；M5 做人工套餐、配额、监控和异机恢复；M6 完成性能、安全、依赖/许可、部署回滚及真实支付验收。

原计划 M2 的 64–104h 是开发预算，不是本会话实际工时，也不能按通过用例数扣减。M3–M6 原计划合计 224–376h，含约 25% 余量为 280–470h；实际剩余仍受 Admin/店面集成、Provider 差异和发布审查影响，应在对应阶段细化，不承诺已获得生产就绪证据。

本批保留原 MIT LICENSE、package.json 和 yarn.lock；原 `/workspace/medusa` 未修改。源码及补丁留在工作区，没有 commit/push、部署、邮件发送或真实支付。云环境 M2 复用说明已保存并读回为 revision 4 草稿；原安装脚本、网络和仓库设置保留。需要在环境设置保存并发布后激活；新任务恢复尚未独立验证。
