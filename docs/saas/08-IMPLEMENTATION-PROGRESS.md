# 第一批代码实施与验证结果

2026-10-08。用户已授权按顺序开始代码处理；暂停独立用户后台界面稿，复用 Medusa Admin。AI/Helpdesk/CRM/营销/行为分析保持第二阶段。

**本批完成了交易基线问题闭环、MIT 开发基线冻结、四项安全回移，以及真实原生 ORM 的双租户隔离试点。完整 SaaS MVP 尚未完成，完整 M0 验收也不能用本次有限试点替代。**

## 1. 已关闭的失败

此前信用额度测试的 HTTP 200/400 不一致，根因是 Loyalty 插件没有编译：通用 Turbo build 不会执行插件单独的 build:plugin，插件解析器遇到缺失目录跳过，退款校验 Hook 未加载。

补齐 `yarn workspace @medusajs/loyalty-plugin build:plugin` 后，原订单和 Loyalty 两组测试 60/60 通过。没有向核心信用额度工作流添加不适用于一般信用额度的校验，也没有删除失败断言。

现已添加 `saas/check-baseline.cjs` 预检查编译后的 Hook 和 store-credit 模块。`saas/verify-baseline.sh` 在测试前显式构建插件，以避免复发。

## 2. 实际代码位置与 MIT 基线

- 开发源：`/workspace/.medusa-baseline/mit-source`，分支 `saas-mvp`。此前源快照已初始化为可查看差异的独立 Git 开发目录，没有创建 Git worktree。
- 基准：Medusa 2.18.0，`1014c0337027a6087410ad3cc1da9a11fd83ca8d`，根 MIT 保持不变。
- 原 `/workspace/medusa` 保持 HEAD 和工作区未修改；本批没有推送、部署或发布应用。
- 修改尚未 commit。交付补丁覆盖本批新增文件和原生源码修改，见 evidence。

新增可信租户 session/ALS 上下文、原生模块事务适配器、原生表隔离试验、启动/验证脚本与基线记录。详见 [开发说明](../.medusa-baseline/mit-source/saas/README.md) 与 [基线记录](implementation-evidence/BASELINE.json)。

四项安全回移逐文件选择 generic MIT 路径，未引入后续企业源码或其编译包：

| 原始提交 | 本批变更 |
|---|---|
| e607b4f7f9 | actor-less identity 再注册必须匹配已有密码，防止覆盖密码 |
| f373c17dd6 | 查询字段限制不再依赖开启 RBAC flag |
| 847612908f | 允许字段数组按请求复制，避免复用中间件时污染后续请求 |
| 7479b07071 | Store 订单关系展开限制，阻止绕入其他订单/购物车 |

完整 Store 严格允许字段、MFA/OAuth 条件加固、依赖漏洞核验及更新仍是后续发布门槛。后续提交存在 morgan/svgo/multer 安全更新线索；本批未独立核验全部官方公告或升级锁文件。

15 个缺少 license 元数据的包已经逐项补查：10 个第三方包都含实际 MIT 许可，5 个 Medusa workspace 源码可依据候选根 MIT。`exit` 实际包含 LICENSE-MIT，之前清单的 license_file:false 是文件名扫描漏检。见 [许可证据与 SHA256](implementation-evidence/DEPENDENCY-LICENSE-NOTES.md)。此项仍不是完整传递依赖 SBOM、浏览器/容器/分发产物 NOTICE 审查。

## 3. 本次真实执行结果

| 验证 | 最终结果 |
|---|---|
| Turbo 依赖与服务构建 | 74/74 成功 |
| Loyalty server/admin 插件构建 | 成功，产物预检查通过 |
| 交易 HTTP：购物车、商品、订单、客户、支付、Store 订单字段及 Loyalty | 7 个套件全部通过；246 通过、0 失败、10 跳过 |
| Framework 字段回归 | 35 通过 |
| Auth emailpass 回归 | 11 通过 |
| 原生价格计算回归 | 49 通过 |
| 原生商品变体回归 | 17 通过 |
| 租户身份/模块适配器单元检查 | 10 通过；事务部分使用 mock |
| 真实原生 ORM 隔离检查 | 20/20 通过，实际 PostgreSQL 与原生模块 |

全部最终源码修改完成后，可复跑验证脚本已完整执行成功，退出码为 0。上述结果来自这次最终执行；没有把之前失败的运行计为通过，也没有通过删除断言消除失败。

详见 [汇总](implementation-evidence/summary.json)、[HTTP 结果](implementation-evidence/http.json)、[原生隔离结果](implementation-evidence/native-catalog.json) 和对应日志。10 个跳过项保留为跳过，外部支付仍未验收。

## 4. 20 项原生隔离检查的范围

原生 Product/Pricing/Link 模块在专用 `medusa_saas_catalog_probe` 数据库运行。管理员只用于初始化原生迁移和隔离约束；原生服务使用独立 NOSUPERUSER/NOBYPASSRLS 角色。表数量包括标准 Link 空表，不能理解为订单、支付或库存域已经实现隔离。

实际检查包括：

- 两租户使用相同 handle/SKU，各自读、count、关系展开；越权 retrieve/update/delete 不能影响对方。
- 相同租户重复 handle 仍触发明确唯一约束错误。
- 伪造输入 tenant 字段、无上下文、伪造 JWT 或不匹配成员关系被明确错误码拒绝。
- 原生变体归属、PriceSet/Price/规则及原生价格计算，复杂上下文的规则属性读取按当前事务执行。
- 原生跨模块 Link；数据库直接 SQL 返回 23503，证明租户复合外键生效。
- Query Graph 展开只返回本租户商品、变体和价格；Graph 缓存显式关闭。
- 实际同步 Workflow 调用原生模块仍保持可信租户上下文。
- 深层商品的 options/values/images 双向读取隔离；图片 pivot 的外来 variant 和 image 均被复合外键拒绝。
- 同租户变体图片添加、读取、list/count 和移除正常；移除外来租户图片不会影响对方。
- 40 个交替租户并发读取、40 个并发写入；两条实际原生池连接上的 tenant setting 被清理，无上下文可见行数为 0。

修正了原生 PricingRepository 的两处事务旁路：价格计算与规则属性发现使用 transaction-bound Knex；规则属性集合不再跨租户共享缓存。49 项原生价格回归通过，但没有做生产吞吐量比较。

修正了原生变体图片处理在事务中的两处问题：图片移除时内部查询传递同一 sharedContext；图片展示在 DTO 序列化后调整，避免把普通 DTO 数组写入托管 ORM 集合造成事务提交失败。17 项原生商品变体回归和包含图片操作的 20 项隔离检查均通过。

## 5. 明确的剩余边界

当前 tenant_id 是在原生迁移后对专用空库添加的列及约束，**尚未同步进入全部 DML 模型、DTO 和 Link 生成器**。不能把该脚本作为生产迁移，也不能在增强后的库直接运行原生 schema sync。已有生产数据的归属迁移未实施。

本批成员关系查找使用服务端固定测试 fixture，而非已实现 tenant/membership 数据表；session 验证不是原生 Admin/消费者 HTTP 登录改造。未开放 SaaS HTTP 服务。

同步 Workflow 的 ALS 保持不等于持久化 worker/retry 的租户恢复；跨模块使用独立事务，不提供跨模块原子提交。业务事件总线在探针中为测试替身。完整缓存、对象存储、锁、导出、支付回调、暂停租户处理及备份恢复仍未实施。

本批没有单标准服务器容量结论，也没有真实沙箱商户支付、真实资金流或完整多租户结账 E2E。

## 6. 下一批按顺序执行

1. 同步商品/价格 tenant 字段、唯一约束和关联元数据到 DML/Link/版本化迁移，消除 schema drift，并定义已有数据处理规则。
2. 建立实际 tenant、membership、域名和初始化流程；接入原生店主认证后的可信 TenantContext，消费者上下文按服务端店铺域名/密钥绑定解析。
3. 在 HTTP 中验证两租户创建/读取/更新及伪造 body/header/token 的拒绝；不能只在直接模块调用中验证。
4. 按归属矩阵扩展 Cart/Customer/Order/Payment/Inventory/Shipping/Tax、Link、任务、缓存和文件，完成原有 MVP 验收清单。

下一批对应计划 M1；M2–M6 保持原 MVP 范围。独立后台界面稿保持暂停，不新增 AI 和客户运营功能。

## 7. 云环境复用

已确认保存 install_script 与 start_skill 草稿，保留原工具链及原仓库工作流，追加 MIT fork 构建、单独插件构建、固定镜像服务启动与验证指令；未修改网络策略、凭据或仓库成员配置。启动脚本已重复执行，SELECT 1 和 Redis PONG 通过。

工具返回 requires_publish:true：需要在环境设置中检查、保存并发布，才能将当前准备状态用于后续任务。保存草稿未发布应用；新任务恢复尚未独立验证，当前本地开发目录及补丁需要保留。
