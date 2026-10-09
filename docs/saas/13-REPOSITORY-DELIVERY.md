# SaaS 源码与文档交付说明

整理日期：2026-10-09。目标仓库 `https://github.com/victors2021/store-saas`，
交付分支 `saas-mvp`。当前版本包含 M0–M3、M4/M5 本地实现/验收与开发复查。
Stripe 独立测试账户接入、原生收款/退款、履约/取消已实现；实际 Stripe 沙箱
账户、官方回调投递、Elements、真实异机备份恢复及 M6 仍待验收。

## 组织和来源

- 仓库根是可继续开发的完整 Medusa MIT 2.18.0 源码，不只是一份增量补丁。
- 第一个提交导入源提交 `1014c0337027a6087410ad3cc1da9a11fd83ca8d` 的 MIT
  快照；后续 SaaS 提交集中保存租户改造、原生后台/商城和文档。原始开发 checkout
  保持不变，没有把新代码提交到原 Medusa 仓库。
- `saas/` 集中自有适配与测试，`packages/` 保留原生模块改动；商城原样保留
  独立 MIT 许可证、上游提交、捆绑 Yarn 和锁文件。
- PRD、MVP/开发计划、第二阶段规划、M0–M3 报告、评审、静态原型和证据集中在
  本目录。原型与早期报告保留为历史记录，当前交付复用原生 Admin。
- 上游 GitHub 工作流、Dependabot/CODEOWNERS（如存在）移至参考目录，不在新仓库
  注册原 Medusa 的发布、外部通知或调度流程。尚未配置本项目专用 GitHub CI。

历史报告中的绝对路径、未提交/未推送状态和先前阶段限制描述的是当时的工作区。
当前进度以仓库根 README、M5 报告及 Git 提交为准。历史证据文件没有重写，
可按各目录 `SHA256SUMS.json` 核对。

## 验证与保留文件

M3 源码先完成严格验证，再生成累计/增量补丁，应用到本交付仓库。交付源码与
已验证开发目录按 `m3-evidence/source-SHA256SUMS.json` 逐文件比对，根 MIT
LICENSE、package.json、yarn.lock 另按证据中的冻结哈希核对。
目录整理和根 README/参考工作流位置变化没有改变受验收的应用源码。

`m3-evidence/` 保存 43 份结果文件及其 SHA256 清单，包含 8 张选定界面截图。
历史 bootstrap/M1/M2 的 20/34/44 个已登记证据文件也保持原哈希。
本次没有保存浏览器认证 trace、storage state、TLS 私钥、真实支付/邮件凭据，
也没有将依赖目录、构建缓存、上传对象或数据库转储加入交付。
测试 fixture 的固定假账号、假密钥和临时数据库角色仅用于本地测试。

新克隆先按根 README 安装并构建；不要把旧报告中的本地 activate 路径当成仓库
内文件。正式实例还需要独立迁移账户、受限运行角色、稳定密钥、对象目录和 TLS
配置；实际支付渠道、真实异机恢复和 M6 发布验收继续待办。M4 在交付 checkout
`/workspace/store-saas` 继续开发，新增证据单独归档 `m4-evidence/`，历史
M0–M3 文件不重写。M4 复现和运行配置见 `saas/M4-README.md`。

## 保存状态核对

源码保存到 GitHub 与云环境配置发布是两项操作。可用以下只读命令核实远端：

```bash
git rev-parse HEAD
git ls-remote origin refs/heads/saas-mvp
git status --short
```

远端分支 SHA 与本地 HEAD 相同、工作区干净，才构成提交推送完成的证据。
M3 云环境 `install_script` 和 `start_skill` 已保存为 revision 5 草稿，并读回
验证；原仓库列表、网络和凭据设置保留。草稿仍需环境设置保存/发布才生效，
新任务快照恢复尚未独立验证。

M4 更新后的配置草稿状态见 `m4-evidence/cloud-config-draft.json`。保存草稿不
应用网络、生成密钥、启动应用或发布环境；须在环境设置保存/发布后才生效。
没有为替换仓库列表而改写旧 origin 或删除历史 checkout。

M5 源码在同一交付 checkout 继续开发，新增独立 `m5-evidence/`，保存当前
验收日志/JSON、6 张实际界面截图、源码补丁和哈希。运行入口为
`saas/M5-README.md`，迁移/备份/恢复/回滚步骤见 `18-OPERATIONS-RUNBOOK.md`。
M5 备份测试使用本机独立 PG 实例；未保存数据库包、恢复密钥或浏览器认证数据。
实际异机复制/恢复状态单独为 pending。M5 云配置草稿见该目录
`cloud-config-draft.json`，原仓库、安装脚本、网络规则和既有 secret 设置保持。
草稿保存不代表已发布或新任务已恢复验证。
