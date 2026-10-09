# SaaS MVP 运维、备份与回滚手册

适用于 M5 `saas-mvp`，保留 MIT Medusa 2.18.0 和固定商城基线。
当前测试为已安装工作区；新机安装、公网部署和真实异机演练仍待执行。
操作角色为可信平台运维。不要把管理连接、密钥或恢复文件放入 Git、聊天或普通日志。

## 1. 部署前准备

1. 固定应用 Git SHA，按根 README 安装/构建；检查根及商城 LICENSE/锁文件哈希。
2. 准备 PostgreSQL 16、单独迁移/备份管理连接与受限应用角色。应用角色须
   NOSUPERUSER、NOBYPASSRLS、NOCREATEDB、NOCREATEROLE 且非业务表所有者；
   禁止公开本地测试 trust 数据库。正式 PostgreSQL 连接使用验证证书的 TLS。
3. 为对象目录、数据库和临时运维盘配置持久卷、权限、容量/磁盘报警；对象目录绝对
   路径且不含符号链接。部署对象与密钥要和数据库一起备份。
4. 在秘密管理系统保存稳定的 JWT、context、identity、platform 和 payment keys。
   payment key 为独立 32-byte hex；另设独立 32-byte hex backup key，单独托管
   恢复权限及离线恢复副本。勿启动时随机替换任何现有持久 key。
5. 按 M2 控制表流程由授权迁移管理员显式登记 platform identity，运行变量
   `SAAS_PLATFORM_ACTOR_ID` 指向该身份。平台 key 不能绕过持久身份校验。
6. TLS 入口保留经过验证的 Host，剥离外来 tenant/forwarding authority headers，
   仅信任 `SAAS_TRUSTED_PROXY` 明确列出的节点。平台 Host 限运维网访问；
   公网只转发审查后的店铺网关，Next 的 8000 和 gateway 的 9000 保持 loopback。

运行值与 M4 相同，额外只在离线运维进程注入 backup/restore 变量。
Stripe 商户配置经本店 HTTPS 原生 Payments 页面写入，每店独立测试账户。
不把 Stripe 后端 keys 交给 Next 子进程。环境配置草稿须在设置页保存/发布才生效。

## 2. M4 → M5 升级

1. 安排维护窗，在 TLS 入口停止业务写入，停止所有旧 gateway、worker 和直接写库
   的运维进程，等待已启动的交易结束。记录未确认渠道操作和队列状态。
2. 用现有 M4 管理备份流程保存完整数据库、对象和稳定密钥，并确认可恢复的匹配
   M4 Git SHA。M5 加密工具要求 `0007-operations`，不能用于未升级的 M4 数据库。
3. 配置 `SAAS_MIGRATION_DATABASE_URL`、`SAAS_APPLICATION_ROLE`、
   `SAAS_JWT_SECRET`、实际 `SAAS_OBJECT_ROOT`，运行：

   ```bash
   node saas/migrate-m5-command.cjs
   ```

4. 若历史 M2 店铺尚未 M3 初始化，显式运行
   `SAAS_ENABLE_OPERATIONS=true node saas/initialize-m3.cjs TENANT_ID`。
   不对已初始化店铺反复播种。未知无归属数据或破坏性原生 Link 计划先停下调查。
5. 构建后运行 `node saas/start-m5.cjs`。默认 worker 开启，检查 `/health/ready`
   返回 200；验证两个店铺身份、商品、订单和原生 Operations。
6. 先做本地加密备份，再完成离机复制和验证，最后按发布流程开放试点流量。

迁移以事务验证对象真实字节/hash/归属和已有配额。失败不留下部分 0007 schema。
更早原生/M1–M4 的加法迁移可能已经成功，仍要查看实际 ledger；不能认为整条升级
链自动撤销。禁止旧 M4 writer 与 M5 writer 同时运行，禁止删约束或改迁移 checksum
来绕过启动保护。旧应用拒绝 M5 数据库属于预期保护。

## 3. 日常平台管理与监控

访问 `https://platform.<SAAS_BASE_DOMAIN>/platform`，安全输入平台 bearer key。
修改 pilot 商品/上传/request cap 时使用当前版本，额度低于实际使用量返回 409。
暂停前查看未 capture 授权；暂停会禁止新 capture，未付款订单需恢复后处理或取消。
暂停中的足额已付款订单可发货/退款，旧回调可以处理，不能新建 checkout 订单。
固定消费者页面关闭，店主后台保留处理路径。

原生 Admin Operations 的 Retry 使用服务器保存的操作和 key；未知结果不可通过
换 key 重做。已保存 remote refund ID 会取回核验；未保存 ID 且超保守窗口的
旧不确定结果交人工渠道核对。不修改业务 financial entry 来强行“修好”状态。

监控采集 `/health/ready`、受保护 `/platform/operations`、磁盘/DB/对象盘容量。
连续 readiness 503、worker 超过 30s 不新鲜、失败任务、超过 5min pending 积压、
清理失败、备份缺失/超过 36h 需要处理。控制台不是外部通知系统；上线时将采集
规则接入已有报警渠道并演练。无需从源码新增 Slack/邮件发送。

每分钟清理有限租户批次，保留所有金融恢复记录/原生 workflow checkpoint。
定期核对完整对象清单；当前孤儿扫描有界，不保证每轮扫到所有文件。
处理 failed jobs 前核验原始签名、租户当前身份和真实业务结果。未知命令不启用
通用执行 fallback。已暂停普通 command 保持待执行并保留重试预算。
应用与入口日志不能记录 Authorization、付款 keys、客户正文、地址或回调 payload。

## 4. 加密全备份与离机复制

通常使用宿主 PostgreSQL 16 `pg_dump`/`pg_restore` 与 GNU tar。测试才使用明确
匹配 loopback 端口、无密码、由本项目创建的 Docker 工具容器。
`SAAS_BACKUP_PG_CONTAINER` 不是正式数据库通用入口。

通过安全运行环境注入以下变量；不把带密码 URL 写在 shell 命令行或 shell history：

| 变量 | 含义 |
|---|---|
| `SAAS_BACKUP_DATABASE_URL` | 完整备份管理员连接，须能绕过 RLS 读取全库 |
| `SAAS_APPLICATION_ROLE` | 当前受限运行角色名字 |
| `SAAS_OBJECT_ROOT` | 实际对象根目录绝对路径 |
| `SAAS_BACKUP_OUTPUT` | 新的、尚不存在的加密包绝对路径 |
| `SAAS_BACKUP_KEY` | 与 runtime keys 不同的 32-byte hex 加密密钥 |
| 五个运行 keys | JWT/CONTEXT/IDENTITY/PLATFORM/PAYMENT，原值供加密恢复 |

```bash
node saas/m5-backup.cjs create
```

备份握排他维护锁，网关业务变更、worker、清理握共享锁；忙时拒绝并留待重试。
稳妥的操作窗口仍需停止写流量/worker，特别是绕过网关的直接 CLI/DB 写入。
全库、对象和密钥应是一致 snapshot。后台 heartbeat/会话等非业务临时数据在
恢复时清除，不能用它们判断恢复 worker 存活。单个 HTTP 断开不会取消已启动
workflow；锁保持到实际异步变更结束。

输出文件 0600，AES-256-GCM 认证加密，内部数据库/对象/密钥有 hash。
短暂明文 dump/tar 在受限临时目录中，结束后清除；临时卷用访问隔离/盘加密，
预留至少完整备份数倍空间。包最大 8 GiB，达到上限需要扩展备份方案，不能截断。
保留 JSON receipt 的 SHA256、大小、对象数和完成时间。数据库本地 receipt
只表示创建成功，**不代表离机副本**。

运维配置每日至少一次调度和保留策略；本批没有新增调度守护服务。把加密包通过
经审批的加密通道复制到真实独立主机/持久存储，复核远端 SHA256，记录目的地、
复制时间、保留期和恢复演练记录。托管密钥与备份分开，不将备份 key 放在包旁。
实际目的地的网络规则/凭据须在环境设置配置；当前没有目标，不能写成功凭证。
删除旧备份前先核验新的离机副本和可恢复性。

## 5. 空目标恢复与切换

在隔离目标先部署相同 Git SHA、PG 16 工具及运行依赖。数据库、对象目录和
可选 key output 都必须尚不存在，目标库名不能与来源同名。不把恢复程序用于
覆盖生产数据库。安全注入：

| 变量 | 含义 |
|---|---|
| `SAAS_BACKUP_INPUT`, `SAAS_BACKUP_KEY` | 校验后的加密包绝对路径及独立解密 key |
| `SAAS_RESTORE_DATABASE_URL` | 有建库/建角色权限的明确目标管理员连接 |
| `SAAS_RESTORE_EMPTY_DATABASE` | 与 URL 中目标库名完全一致的显式确认 |
| `SAAS_APPLICATION_ROLE` | 与备份一致的受限应用角色名字 |
| `SAAS_RESTORE_OBJECT_ROOT` | 新的对象根目录绝对路径 |
| `SAAS_RESTORE_KEYS_OUTPUT` | 可选，新 0600 文件，绝对路径且在源码仓库之外 |

远程 PostgreSQL 连接默认 `sslmode=verify-full`；工具和控制连接都拒绝弱 TLS。
私有 CA 通过 URL `sslrootcert` 指向绝对证书路径，验证目标主机名，不能使用
`require`、`no-verify` 或忽略证书错误的开关。

```bash
node saas/m5-backup.cjs restore
```

先验证包认证、USTAR 类型/路径、manifest/hash，再建新库和单事务导入；
以受限角色验证迁移、模式指纹、权限/RLS、原生归属。恢复清除 HTTP sessions
和原 worker heartbeat，将过期 lease 交 worker 重领。原签名密钥必须保持，
30 天签名 envelope 有效期超过时需审核式重建，不能跳过验证。

恢复出的 keyring 字段对应：`jwtSecret`→JWT，`contextSecret`→CONTEXT，
`namespaceSecret`→IDENTITY，`platformKey`→PLATFORM，`paymentKey`→PAYMENT。
运维导入秘密管理后保护/移除临时 0600 文件。角色密码、Redis、Host/TLS/代理、
域名设置和环境 secret store 本身不在数据库包里，须分别配置。

失败目标留在隔离状态供调查；程序不 DROP 或覆盖。选择新的空库/对象目录重试。
不得直接把半恢复库指向入口。对照 tenant/domain/membership、全业务表数量与
关键订单内容、对象 SHA256、配额、受限角色双租户负向请求、退款/队列 replay。
启动后 actual worker heartbeat 与 readiness 均通过才进入切换流程。

**切换前核对供应商从 snapshot 之后的授权/capture/refund/webhook。** 恢复数据
不是渠道回滚；防止丢失记录导致重复扣款/退款，处理保留 endpoint/版本凭据及
回调队列。已授权的真实沙箱和实际异机演练须单独留下结果。再安排短维护窗、
最后差异核对、入口切换、观察告警。记录实际 RPO/RTO；本批不承诺数值。

## 6. 版本回滚

优先修复向前；如果必须回到 M4，停止 M5 gateway/worker/直接写入，隔离当前库，
保留新数据备份与渠道未确认操作，恢复升级前匹配的 M4 数据库、对象和原密钥到
新的目标，部署原 M4 SHA。不能仅 git checkout M4 后连接已有 M5 schema。
M5 加法迁移没有 destructive down SQL；禁止手工删表/触发器“降级”。

旧 snapshot 之后的订单和渠道动作不会自动保留；需要对账/差异迁移和明确业务
切换决策。实际生产切换、覆盖或删除数据库属于另行批准的发布操作；本次用户
“开发 M5”授权只完成代码、测试、文档和既有仓库提交，不替代线上切换授权。

## 7. 发布验收记录

本机独立 PG 实例恢复结果在 `m5-evidence/m5-backup.json`。
实际异机验收记录需填写来源/目标独立主机、应用/数据库版本、加密包与远端
hash、订单/对象/隔离校验、密钥恢复、渠道对账、告警/回滚、实际 RPO/RTO、
执行人与时间。用户已确认目标尚未准备，真实异机验收列入发布验收；当前该外部
结果为 pending。真实 Stripe 和 M6 审查同样 pending。
