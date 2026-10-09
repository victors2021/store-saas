# 试运营发布验收

当前 M6 是开发候选。以下十项由 `saas/m6-release-gate.cjs` 校验，所有项取得
实际证据后才允许 M6 生产启动。用户已经确认异机目标尚未准备，登记为
`deferred`；该状态不会因时间经过或本地恢复成功而自动转为通过。

| Gate | 验收内容 | 当前状态与所需条件 |
|---|---|---|
| tenant_isolation | 最终源码完整入口/实体/回调/任务/资源/角色负向回归 | 本地套件通过后可登记本地通过，独立审查仍另列 |
| dependency_security | 实际 runtime/build 依赖可达性、固定版本和整改 | 39 条 lock 公告仍需审查；包括 2 critical/8 high，不宣称风险已清零 |
| distribution_license | 实际服务器/浏览器/native/image 产物与对应通知/源义务 | 完整 lock/已安装 NOTICE/native 版本已整理，分发审查待完成 |
| reference_performance | 8核/32GB 参考机、10店参考数据、20RPS/30min、普通 API 整体 P95≤300ms、20并发结账、资源和队列 | 用户将原 800ms 规划目标提高为 300ms；当前机器 cgroup 4 核、历史模板/本地 Provider，保留目标机/外部等待与负载审查 |
| stripe_sandbox | 两个真实独立商户沙箱、官方 TLS 回调、Elements/3DS、重复/乱序/错误账户 | 当前没有真实 Stripe Secret/域名；自有协议 fixture 不作真实渠道验收 |
| authorized_live_payment | 用户授权的真实小额付款/退款 | 尚未授权实际资金操作，不能自动扣款作为开发测试 |
| off_host_restore | 真实异机复制、空目标恢复、tenant/order/media/key 核对、RPO/RTO | **deferred，按用户决定列入发布验收；目标尚未准备** |
| deployment_tls_and_rollback | 实际目标 TLS/SNI/Host/代理信任、人工受控发布、匹配代码/数据/对象/密钥回滚、真实报警送达 | 本地证书/配置失败/恢复和模板语法演练通过；公网目标和报警送达待验收 |
| independent_security_review | 非实施者独立检查 tenant/支付/权限/SQL/文件和严重缺陷闭环 | 开发自查和回归已登记，独立人员/结论尚未提供 |
| merchant_pilot_feedback | 2–3 家真实商户按上架→下单→收款→发货→退款走查 | 管理员开发登录已验证，不能代替真实商户操作反馈 |

## 证据记录格式

证据目录必须由发布操作者控制，不能由商户写入。先生成当前源码 SHA256
清单，再保存测试/运行报告。生产记录相对于自己的目录引用 regular 文件，
不能使用绝对、越目录或符号链接引用。

```bash
node saas/m6-release-gate.cjs manifest > /ABSOLUTE/acceptance/source.sha256
sha256sum /ABSOLUTE/acceptance/source.sha256
```

`release.json` 的最小骨架如下（`SHA256_OF_...` 仅为格式说明，需要计算真实
64 位小写 hex 值；此示例不是可发布记录）：

```json
{
  "format": 1,
  "target": "pilot",
  "source_manifest": {
    "file": "source.sha256",
    "sha256": "SHA256_OF_SOURCE_FILE"
  },
  "gates": {
    "tenant_isolation": {
      "status": "passed",
      "observed_at": "ACTUAL_OBSERVATION_TIME",
      "source_sha256": "SHA256_OF_SOURCE_FILE",
      "evidence": { "file": "tenant-report.json", "sha256": "SHA256_OF_REPORT_FILE" }
    },
    "off_host_restore": { "status": "deferred" }
  }
}
```

完整记录须包含上述十项。未登记项等同 pending，每项 passed 都要求最近七天
内且不在未来的 `observed_at`、与当前 source 清单相同的摘要、真实报告 digest。
报告共同字段是 `complete: true` 和 `source_sha256`；其他要求如下：

| 报告 | 必需事实字段 |
|---|---|
| dependency_security | `unresolved_runtime_high_critical: 0`，附逐项 reachability/整改/工具版本；这个数字不能由 lock 总数简单相减得出 |
| distribution_license | `actual_distributed_artifacts_reviewed: true`，附镜像/浏览器/native 摘要和分发通知/对应源义务结论 |
| reference_performance | 有限非负数值 `duration_seconds≥1800, rps≥20, tenants≥10, products_per_tenant≥1000, variants_per_tenant≥2000, orders_per_tenant≥10000, p95_ms≤300, error_5xx_rate<0.01, checkout_concurrent≥20`；`checkout_no_oversell, reference_hardware_verified, history_profile_reviewed, queue_converged, resource_growth_reviewed` 均 true |
| stripe_sandbox | `real_stripe: true, independent_accounts: 2, official_tls_callbacks: true, elements_3ds: true`，附两账号绑定/事件/错误账户/重放证据 |
| authorized_live_payment | `user_authorized: true, actual_payment_and_refund: true`，保留授权与脱敏交易/退款结果，不能将沙箱当作实际金额 |
| off_host_restore | `separate_physical_host: true, actual_copy_and_restore: true`，附目标标识/复制完整性/新库核对/耗时/原介质和钥匙恢复 |
| deployment_tls_and_rollback | `actual_target_tls_host_ingress, matching_code_database_objects_keys_rollback, actual_alarm_delivery` 均 true，附真实证书/头边界/失败发布及收件端确认 |
| independent_security_review | `independent_reviewer: true, unresolved_severe_findings: 0`，附人员/范围/问题闭环；开发 agent 自查不能充当独立人员 |
| merchant_pilot_feedback | `actual_merchant_walkthrough: true`，附实际商户反馈/阻塞问题处理 |

这些 JSON 是运行门槛的结构记录，不是签名的审计证书。操作者仍需审阅真实
报告、保护目录权限和记录授权来源；伪造几个 true 不会构成验收。
源码改动后须重跑受影响检查和绑定新清单。门闩包括源码/运行脚本/相关配置及
锁文件，文档证据自身不纳入清单以避免摘要自引用。

## 发布、监控与回滚顺序

1. 在独立 staging 配置真实域名/TLS、运行与迁移角色、稳定 runtime keys、
   对象卷、两商户沙箱及安全 Secrets；关闭仍未移植的业务 API。先完成当前
   源码 immutable 安装/构建和完整回归，确认目标机负载。
2. 完成官方回调/Elements/3DS，再在用户明确授权后进行真实小额支付与退款。
   记录错误商户绑定、重复/乱序事件、失败恢复、金额/库存/退款一致性。
3. 准备异机目标，离线创建加密全库/对象/运行 keyring 备份，实际复制并验证
   密文摘要，在空库和新对象目录恢复。依据规模记录 RPO/RTO；恢复后暂停
   对外写入并对账 snapshot 以来的 Stripe 外部事实。
4. 在实际目标渲染并校验 Nginx/systemd 配置，保护 operator Host。采集平台
   metrics/operations，演练 worker 停止、DB 故障、队列积压、备份过期和恢复，
   由接收人确认真实报警送达。CLI 输出和本地观察不等于报警已送达。
5. 演练失败候选→匹配已知代码/依赖/DB/对象/密钥恢复。M6 当前没有新 schema
   迁移，但旧 M5 依赖/binary 降级仍需针对该版本演练；M4 程序不能连接 M5 DB。
6. 完成独立严重问题闭环和商户走查，编制完整 release record，再执行：

```bash
node saas/m6-release-gate.cjs /ABSOLUTE/acceptance/release.json
NODE_ENV=production SAAS_RELEASE_MANIFEST=/ABSOLUTE/acceptance/release.json \
  node saas/start-m6.cjs
```

Gate 退出码 2 表示仍被阻塞，应用不会接着连库启动。源码/环境/证据绑定先
完成再发布；这不是自动发版器，也不会替代实际操作审批或持续审计。

当前普通 API 目录样本含 10 个原始受管库存变体和 19,990 个批量未受管变体；
20 并发结账只对原始库存项制造竞争。参考性能审查须覆盖真实受管 SKU、
多仓库及历史支付/履约/库存账构成，不能仅凭 1,000 商品/2,000 变体数量声明
真实店铺容量。普通 API 本机延迟也不包含完整公网/TLS/Next 页面等待。

当前 development release packet 只记录真实已执行本地检查，其余项 pending/
deferred。它应被 gate 拒绝；拒绝是本阶段预期结果，不是基础启动测试失效。
