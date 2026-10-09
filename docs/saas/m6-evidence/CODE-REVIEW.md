# M6 开发复查

本次是实施过程中的开发自查，覆盖新增代码和 M0–M5 回归；没有另聘独立审查
人员，也不将开发测试计为 PRD 要求的独立租户/支付/权限审查。

## 已发现并修复

| 问题 | 原因与修复 | 验证 |
|---|---|---|
| 失败结账遗留订单 | Native Link.dismiss 软删除后仍受 tenant/order 复合 FK 引用；原生 deleteOrders 无法完成。仅在同一原生模块事务中删除同租户、目标 ID、deleted_at 非空的固定四类 Link 墓碑 | 20 并发剩余两件库存只新增两单；无失联订单或失败 compensate；兄弟店和有效关联订单删除负向检查通过 |
| 并发门闩连接饥饿 | HTTP 写请求持有快照共享锁并等待 worker，worker 又索取同一已满池 | 12 HTTP 与 2 后台 fence 连接分池，同一 advisory lock；20 并发返回成功/可重试 409，没有容量超时 500；备份互斥仍由完整 M5 回归检查 |
| 编排外层 SQL 事务耗尽 native 池 | 全数据持续负载和八并发购物车更新复现：workflows.run 外层持有四个连接，业务步骤和检查点又需连接。五个显式编排入口改为仅校验租户/字段/manager，SQL 数据操作继续由模块事务和独立检查点适配保护 | 同一故障请求修复前有 60 秒超时/500，修复后八个全部 200；新增两店十二并发、四连接池及跨店读取负向回归通过；完整持续负载重新执行 |
| 大目录渠道过滤占用单进程 CPU | 每个商品列表为只取 product_id 水合大量原生 Link 实体。仅优化固定 entity/投影/过滤且无额外选项的 Query 形状，运行角色用 tenantSQL 参数绑定、FORCE RLS、deleted_at 过滤，其他形状回退原生 Query | 原 12 分钟候选有背压/P95 12.5s；优化后 60 秒诊断 1,200 次全成功但整体 P95 2.6s，不能计为通过；最终重新验证完整回归/30min，增加渠道跨店/ID 交集/软删除负向检查 |
| 单 Node 进程未利用多核 | 两个独立网关进程共用稳定 keyring/对象/数据库，Nginx least_conn 分流；每个仍使用小连接池，一个 worker 处理共享持久队列。负载固定算法将读/写形状分配到两进程，联合资源采样 | 真实跨进程 Cookie/JWT/购物车读写、同键并发结账只出一单、撤销平台身份即时拒绝、跨店实体拒绝；完整负载以用户追加整体 P95≤300ms 判定，初始冷请求不排除 |
| 不确定老退款错误响应 | 内部 native workflow 将适配器拒绝包装成 500；恢复入口缺前置不确定性检查 | 超过 23h、无 remote_id/result 的退款返回 409，不新增 vendor POST；已有 remote_id 的恢复流程保留 |
| 删除/清理跟随目录别名 | 读取已有校验，但删除/故障清理/孤儿扫描边界不一致 | 真实路径/租户 namespace/regular file/nlink 检查；符号链接注入不会触碰 B 字节或释放 A 的配额 |
| 孤儿清理一直扫描前 1,000 项 | 每次固定取最前一批，近期文件可能遮住后面的旧孤儿 | 名称排序推进游标与批量 SQL；两批测试实际到达第 1,001 个旧孤儿 |
| 依赖和安装默认安全性 | 冻结锁含已有公告，根 checksumBehavior 为 ignore | 同主版本兼容修复、Next 安全补丁、两份锁显式更新、默认 checksum throw、immutable 新目录无缓存构建、业务回归 |
| 指标/发布证据过宽 | 原有运维数据未提供可采集 histogram；外部条件只在文档描述 | 认证指标、固定标签/上限/丢弃计数、CLI 真实 API 演练、生产启动 fail-closed；缺阈值/不同源码/摘要变化/过期/本机恢复伪充异机负向检查 |

未修改已应用的 `0001`–`0007` 迁移，也没有为解决补偿而放松 tenant FK 或
删除支付/购物车恢复账。保留的原生订单实现未被临时修改方案覆盖。
编排入口不复用其他模块 EntityManager，也没有扩大 SQL 池来掩盖循环等待。

## 仍需评估的供应链公告

完整原始观察保存在 `m6-evidence/supply-chain/dependency-advisories.json`，
每条含官方公告 URL、影响版本和 lock ref。当前 39 条中仍有 2 critical 和
8 high；这不是零风险放行。初步代码/lock 上下游评估如下，仍需独立确认：

| 包/路径 | 初步评估与当前控制 |
|---|---|
| Tinypool 1.1.1，两条 critical | 唯一 lock 父项为 Vitest 3.2.6，是测试 runner；不部署 Vitest UI/server、不将租户输入送入 worker options；没有 1.x 兼容修复，后续需测试 runner 主版本升级或独立安全回移 |
| Faker 9.9.0，high | 根 devDependencies 和 fixture 使用；不得让租户控制 helpers.fake 模板；正式 runtime 镜像需要实际验证剔除测试工具 |
| GraphQL Tools utils 10/11，high | 父项为 GraphQL codegen/schema/merge 工具；不能仅凭“构建依赖”断言不可达，须核实 Query/native runtime 与实际产物是否带入攻击输入 |
| Braces 3.0.3，high | 父项 chokidar/micromatch，冻结主版本无兼容修复；需复查文件 glob/config/watch 接口，当前商户 API 不开放任意配置或模板/插件安装 |
| Redoc 2.1.5、Storybook 8.6.14，high | OAS 文档和开发工具链；未将这些服务作为公共 MVP 入口，现有 artifact 构建/环境变量泄漏仍需分发/工具升级复查 |
| Vite 5.4.21，high | 旧分支 dev server 的 Windows 路径漏洞；当前生产是 Linux 的预构建 Admin 和 Next start，没有公开 Vite dev server；仍保留 lock 告警和后续兼容升级事项 |
| Serialize JavaScript 6.0.2，high | 商城构建/minification 上下游；不接受商户传入待编译 JS/模板，实际浏览器产物和构建环境需审查；没有 6.x 修复 |

Moderate/low 仍包括路由重定向、AJV/$data、旧 telemetry、构建解析器/工具和
其他包，不按严重度自动忽略。对 Remix/React Router redirect、实际 Admin
页面、DOMPurify 配置和服务端 SSR 路径需具体评估。官方 npm bulk 查询不覆盖
嵌入 C/C++ 库、Node runtime、PG/Redis 或 OS/image CVE。

## 已验证的安全边界与限制

1. 140 张 FORCE RLS 表和运行角色不能变为 postgres/关闭 RLS。共用 runtime
   role 仍能设置 tenant GUC；RLS 阻止缺上下文/误过滤查询，无法为取得任意 SQL
   执行或 DB 凭据的攻击者证明应用身份。优先保证入口/SQL/上下文/角色边界，
   独立审查必须测试这一真实权限模型。
2. HTTP allow-list 与 native AST 探测关闭未移植入口。合法字段/关系/实体写入
   由阶段性精细测试覆盖，矩阵不会把每个业务组合都当作已枚举完毕。
3. 私有文件 namespace、目录/leaf 检查和 O_NOFOLLOW 加强正常服务边界；
   不提供对独占对象卷之外的 OS 恶意并发改名/目录替换的完整原子沙箱。
4. 孤儿 cursor 保存在进程内，重启会重置；每批处理/DB 查询限制 1,000 项，
   `readdir` 仍读取目录条目。目录巨量增长/频繁重启需要运行告警和进一步游标存储。
5. 指标 in-memory、10,000 series 封顶，counter 重启归零/溢出有丢弃计数；
   分布式聚合、留存与告警送达属于正式监控部署。CLI 观察成功不证明 Pager 实际送达。
   双实例模板将主/次进程指标分别固定到两个 TLS 路径，不轮询进程 counter；
   采集器仍须分别保留 instance 标签。目标入口/故障切换/滚动重启需实际部署验收。
6. Release gate 只是绑定当前源码、证据字节和人工评审的事实字段，不证明
   评审者身份或证据真实性；上线后不持续触发七天过期停止。保留的历史启动器
   可被有进程/源码权限的操作者调用，M6 启动路径依赖受控发布纪律。
7. 配置/恢复演练使用相同 M6 代码恢复匹配 snapshot；没有验收 M6 依赖回退
   到 M5，也没有处理 snapshot 以后外部 Stripe 已发生的财务事实。回滚要对账。
8. 30 分钟普通 API 与 native checkout conflict 在当前硬件运行；数据和支付
   fixture 限制明确披露。8 核目标机/真实商户大小分布/外部支付/历史账仍需验证。

## 许可与历史一致性

MIT 源码及根、Design System 和商城保留许可证持续核对，原 checkout 没有变更。M6 仅明确解除
依赖 manifest/lock 的原值冻结以执行安全升级；应用迁移哈希未变。完整 lock
SBOM 包含可选未安装平台项，缺 license 元数据不能推测为 MIT。记录 sharp/
libvips 原生 bundle 与 28 个嵌入版本不等于取得全部对应源/通知或漏洞结论。

保留 268 份历史已登记证据的原哈希，新增 M6 证据独立归档。源码/证据扫描
不得保存运行密钥、数据库包、TLS 私钥或浏览器 auth trace。捆绑 Yarn 的已核对
WASM 编码片段只允许严格文件/字节摘要匹配的静态误报例外，不建立宽泛忽略规则。

本批可完成开发检查和审查整改资料；不能代替正式独立审查签字。所有影响
试运营的遗留条件在 [发布验收](21-RELEASE-ACCEPTANCE.md) 中保持阻塞。
