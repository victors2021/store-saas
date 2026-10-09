# Medusa tenant_id 电商 SaaS 规划包

目标：以 Medusa 许可允许的核心构建共享实例、共享数据库的电商 SaaS，tenant_id为隔离边界。第一阶段只改造原生Medusa为SaaS；AI运营及客户运营扩展全部第二阶段。

## 文档

1. [PRD](01-PRD.md)：用户、功能、数据与租户隔离、安全和验收目标。
2. [详细开发计划](02-DEVELOPMENT-PLAN.md)：工作包、依赖、阶段门槛、完整 V1 与 Codex 工时。
3. [独立 MVP 计划](03-MVP-PLAN.md)：精简范围、里程碑、隔离测试和试运营条件。
4. [第二阶段AI智能运营PRD与计划](04-AI-NATIVE-OPERATIONS.md)：目标/诊断/行动/审批/执行/复盘、业务场景、AI治理与工时。
5. [详细基线验证](05-BASELINE-VALIDATION.md)：验证矩阵、通过标准、首批只读证据与工时。
6. [第二阶段客户运营底座](06-CUSTOMER-OPERATIONS-FOUNDATION.md)：Helpdesk、电商CRM、营销/行为统计及本次新增公共底座，全部在MVP后实施。

7. [第一轮基线验证报告](07-BASELINE-REPORT.md)：实际版本、测试结果、可重复失败与未完成项。
8. [SaaS 交互 HTML 原型](saas-prototype.html)：平台运营、商家后台、消费者店面；本地模拟数据。

9. [第一批代码实施与验证](08-IMPLEMENTATION-PROGRESS.md)：订单问题闭环、安全回移及真实原生 ORM 的双租户隔离试点。
10. [M1 实施与验收](09-M1-IMPLEMENTATION.md)：正式模型与迁移、真实租户数据、认证及 HTTP 隔离。
11. [M2 实施与验收](10-M2-IMPLEMENTATION.md)：原生交易隔离、完整下单测试、持久任务与重试/补偿及资源边界。
12. [M3 实施与验收](11-M3-IMPLEMENTATION.md)：原生 Admin、固定商城、双店 HTTPS 浏览器流程、生产启动器与单店升级。
13. [已完成代码评审](12-CODE-REVIEW.md)：M0–M3 复查、修复证据和剩余发布门槛。

## 工时摘要

| 范围 | 基础 Codex 会话工时 | 含约 25% 余量 |
|---|---:|---:|
| 基础隔离（包含在 MVP 中） | 120–240h | 150–300h |
| **第一阶段MVP：原生Medusa SaaS改造** | **360–600h** | **450–750h** |
| 第二阶段增量：电商增强＋全部AI＋客户运营 | 1,604–2,736h | 2,005–3,420h |
| **完整V1（含Helpdesk/电商CRM/营销/行为统计）** | **1,964–3,336h** | **2,455–4,170h** |

以上为项目规划预算，不能按测试用例数量直接扣减。当前已实施首批隔离试点、M1、M2 及 M3，实际范围与验收见实施报告；完整 SaaS MVP 尚未完成，商户真实支付及后续门槛仍在 M4–M6。Codex 工时不等于人工工时或 token 费用。

关键假设：复用原生后台和现成参考店面、单支付渠道、MVP仅店主、人工试点收费、接受核心fork、无未知生产数据迁移。第一阶段只做原生电商的tenant隔离与SaaS必要功能。全部AI及其指标/检索/工具/审批底座、Helpdesk/CRM/营销/行为统计在第二阶段。AM和HM是第二阶段内部切片，不重复相加。完整ERP/销售商机CRM、实时全渠道客服、拖拽建站和广告自动投放不包含。

原 checkout 是 open-core，保留不修改；开发基线已冻结为独立的 MIT Medusa 2.18.0。构建范围与尚待完成的依赖/分发检查见实施报告。

本次工作区规划原稿位于 `/workspace/medusa-saas-planning`，源码开发目录为独立 MIT fork；GitHub 整理版将规划、实施和证据集中在 `docs/saas/`。原仓库保持未修改，MIT 根 LICENSE/manifest/lockfile 保持不变。历史报告中的本地绝对路径和未提交状态是当时的记录；当前交付以 Git 分支和提交为准。云环境复用配置为草稿，后续任务恢复仍需环境设置保存发布并验证。
