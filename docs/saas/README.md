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
14. [源码与文档交付](13-REPOSITORY-DELIVERY.md)：GitHub 分支、来源和环境恢复要求。
15. [M4 实施与界面](14-M4-IMPLEMENTATION.md)：租户 Stripe、原生收款/退款、库存/履约、回调、经营数据和本批验收。
16. [M4 开发复查](15-M4-CODE-REVIEW.md)：支付/恢复/越权边界、M3 修正及当前发布门槛。
17. [M5 实施与界面](16-M5-IMPLEMENTATION.md)：平台、人工套餐/配额、暂停、审计、任务/监控及加密恢复验收。
18. [M5 开发复查](17-M5-CODE-REVIEW.md)：并发、暂停/恢复、备份安全边界和剩余发布门槛。
19. [运维手册](18-OPERATIONS-RUNBOOK.md)：部署/迁移、密钥、离机复制、空库恢复和匹配版本回滚。
20. [M6 实施与验收](19-M6-IMPLEMENTATION.md)：全入口/安全修复、供应链、安装重建、持续负载和管理员开发登录。
21. [M6 开发复查](20-M6-CODE-REVIEW.md)：并发补偿、资源/退款边界、剩余公告和发布限制。
22. [试运营发布验收](21-RELEASE-ACCEPTANCE.md)：十项外部/本地门槛、当前状态、证据格式和受控启动。

## 工时摘要

| 范围 | 基础 Codex 会话工时 | 含约 25% 余量 |
|---|---:|---:|
| 基础隔离（包含在 MVP 中） | 120–240h | 150–300h |
| **第一阶段MVP：原生Medusa SaaS改造** | **360–600h** | **450–750h** |
| 第二阶段增量：电商增强＋全部AI＋客户运营 | 1,604–2,736h | 2,005–3,420h |
| **完整V1（含Helpdesk/电商CRM/营销/行为统计）** | **1,964–3,336h** | **2,455–4,170h** |

以上为项目规划预算，不能按测试用例数量直接扣减。当前包括 M0–M5 和 M6 本地开发验收/发布准备；实际独立 Stripe 沙箱、官方回调、Elements、授权小额付款退款、真实异机恢复、目标部署/报警、独立审查和商户试点仍需完成。Codex 工时不等于人工工时或 token 费用。

关键假设：复用原生后台和现成参考店面、单支付渠道、MVP仅店主、人工试点收费、接受核心fork、无未知生产数据迁移。第一阶段只做原生电商的tenant隔离与SaaS必要功能。全部AI及其指标/检索/工具/审批底座、Helpdesk/CRM/营销/行为统计在第二阶段。AM和HM是第二阶段内部切片，不重复相加。完整ERP/销售商机CRM、实时全渠道客服、拖拽建站和广告自动投放不包含。

原 checkout 是 open-core，保留不修改；开发基线已冻结为独立的 MIT Medusa 2.18.0。构建范围与尚待完成的依赖/分发检查见实施报告。

本次工作区规划原稿位于 `/workspace/medusa-saas-planning`，源码开发目录为独立 MIT fork；GitHub 整理版将规划、实施和证据集中在 `docs/saas/`。原仓库保持未修改，MIT 根 LICENSE 与原生版本保持不变；M6 明确更新安全依赖 manifest/lock 和 checksum 默认值。历史报告中的本地绝对路径、冻结 manifest/lock 和未提交状态是当时的记录；当前交付以 Git 分支和提交为准。云环境复用配置为草稿，后续任务恢复仍需环境设置保存发布并验证。
