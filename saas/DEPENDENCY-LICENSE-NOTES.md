# 依赖许可元数据补充核查

核查日期：2026-10-08。Medusa 原始 MIT 源码基线：
`1014c0337027a6087410ad3cc1da9a11fd83ca8d`，版本 `2.18.0`。

本记录只复核 `/workspace/.medusa-baseline/dependency-license-inventory.json`
中没有顶层 `license` 字段的 15 项：10 个第三方包和 5 个 Medusa workspace。
原清单覆盖 1,899 个顶层 hoisted 包，其自身声明为
“top-level hoisted package metadata; not a complete transitive legal clearance”。
本记录不是完整 SBOM，也没有完成生产依赖树、发布包或浏览器分发产物的许可验收。

## 核查结论与原清单纠正

10 个第三方包在当前安装目录中均有 MIT 许可正文；5 个 Medusa workspace
源码可由上述候选提交的根 MIT 覆盖。缺少 `package.json.license` 字段不等于
没有许可；部分包使用旧式 `licenses` 数组。

原清单把 `exit@0.1.2` 标为 `license_file: false`，实际存在
`node_modules/exit/LICENSE-MIT`。这是原文件名匹配的漏检，不是授权缺口。
`duplexer@0.1.1` 的文件名是英式拼写 `LICENCE`，后续扫描应覆盖
`LICENSE*`、`LICENCE*`、`COPYING*` 和 README 许可段落。

本次仅读取已安装文件、候选提交及原仓库的 Git 历史，并记录文件摘要。
没有联网读取发布包或官方公告，没有运行安装或构建，也没有修改清单、
lockfile、package manifest 或依赖文件。

## 10 个第三方包的随包证据

表内路径相对于 `/workspace/.medusa-baseline/mit-source/`。
每项许可正文均包含 MIT 的授权、保留版权和免责声明条款；短引仅用于定位，
分发时应保留完整许可正文，不能用短引替代。

| 包及版本 | 实际证据路径 | 原文短引 / 版权主体 | 结论 |
| --- | --- | --- | --- |
| parent-require 1.0.0 | `node_modules/parent-require/LICENSE`；`README.md:106`；`package.json` 的 `licenses` 数组 | “(The MIT License)”；“Copyright (c) 2013 Jared Hanson” | 随包正文确认 MIT |
| connect-dynamodb 3.0.5 | `node_modules/connect-dynamodb/LICENSE.txt`；`README.md:167` | “connect-dynamodb is licensed under the [MIT license.]”；“Copyright (c) 2025 introvert.com LLC” | 随包正文确认 MIT |
| browser-assert 1.2.1 | `node_modules/browser-assert/LICENSE`；`README.md:108` | “Everything is [MIT]”；“Copyright (c) 2015 Social Ally” | 随包正文确认 MIT |
| decko 1.2.0 | `node_modules/decko/LICENSE`；`README.md:117` | “The MIT License (MIT)”；“Copyright (c) 2017 Jason Miller” | 随包正文确认 MIT |
| streamsearch 1.1.0 | `node_modules/streamsearch/LICENSE`；`package.json` 的 `licenses` 数组 | “Copyright Brian White. All rights reserved.”；“Permission is hereby granted, free of charge” | 全文为 MIT 条款；首行的 rights reserved 不抵消后面的明确授权 |
| stickyfill 1.1.1 | `node_modules/stickyfill/LICENSE`；`Readme.md:29` | “MIT License”；“Copyright (c) 2014 Oleg Korsunsky”；“Copyright (c) 2014 Automattic Inc.” | 随包正文确认 MIT；两项版权均需保留 |
| exit 0.1.2 | `node_modules/exit/LICENSE-MIT`；`README.md:73`；`package.json` 的 `licenses` 数组 | “Copyright (c) 2013 \"Cowboy\" Ben Alman”；“Licensed under the MIT license.” | 随包正文确认 MIT；纠正原清单漏检 |
| limiter 1.1.5 | `node_modules/limiter/LICENSE.txt`；`README.md:117`；`package.json` 的 `licenses` 数组 | LICENSE：“Copyright (C) 2011 by John Hurliman”；README：“Copyright (c) 2013 John Hurliman” | 两处均为 MIT，但版权年份不同；分发时保留原声明，不自行统一年份 |
| duplexer 0.1.1 | `node_modules/duplexer/LICENCE`；`README.md:39`；`package.json` 的 `licenses` 数组 | “Copyright (c) 2012 Raynos.”；“## MIT Licenced” | 随包正文确认 MIT；文件名不是 LICENSE |
| busboy 1.6.0 | `node_modules/busboy/LICENSE`；`package.json` 的 `licenses` 数组 | “Copyright Brian White. All rights reserved.”；“Permission is hereby granted, free of charge” | 全文为 MIT 条款 |

`exit@0.1.2` 的安装包 `package.json` 指明源仓库
`git://github.com/cowboy/node-exit.git`，homepage 为
`https://github.com/cowboy/node-exit`，旧式许可链接为
`https://github.com/cowboy/node-exit/blob/master/LICENSE-MIT`。
这些是安装包内的来源声明，本次未对远端仓库或对应 tag 进行独立验证。
本地完整 `LICENSE-MIT` 与 README 的明确声明已足以闭环原“未发现文件”的问题。

### 已读取许可文件的 SHA-256

摘要用于复核本轮实际读取的文件，不代表 npm 发布包签名或完整依赖树认证。

```text
parent-require/LICENSE
063497f3f26821fa7249e3b869392075a65b3127a11afc42150ea048e18e8f61
connect-dynamodb/LICENSE.txt
7ff09f4f71f0ea2fcd346ea65a8457837a9b414c2d562ea3467cb03d85ca3379
browser-assert/LICENSE
69861e91ccd3b3ed6410c971e2f94cfc1e7e618fba81723399b64f9e136e6de8
decko/LICENSE
d20ef4c192faa3c560bc50bdd780f686804e355957d4146ddf8cbb58eb2e3dba
streamsearch/LICENSE
7c28463b739e2e73a49bf127d0bda427f8c55f0b37365a044c3c3f254716118b
stickyfill/LICENSE
82183d79743926de3202987112039cda376a447a07422d45de1392cd85e40d07
exit/LICENSE-MIT
65bd93f75d6c0cdc1c9e1a39bd1814e2e34355c665e1564a1517f27c1523ab7e
limiter/LICENSE.txt
a3aebd11ea5598ef12949bf793311bf155ab7727181e3d373bd0b47813d41111
duplexer/LICENCE
19338d17a974d1c747b3f6c618f08975b8908fdebccbc047c0e72b09daf6ddd3
busboy/LICENSE
d06b5d27bbbbe22c36b1fd88406b1208876e2d37d795f5b8eaed951a459a3111
```

## 5 个 Medusa workspace 的根 MIT 证据

当前 `node_modules/@medusajs/…` 均解析到候选源码的相应 workspace，而非独立
npm tarball；五者 `package.json` 的版本均为 `2.18.0`，没有单独的许可文件。
五个 README 也逐个读取：四个只有包名标题，Dashboard 为 React/TypeScript/Vite
模板说明，均未声明额外许可或许可例外；因此许可证据来自根文件及候选历史。

| 包 | 解析后的源码目录 | 许可依据 |
| --- | --- | --- |
| @medusajs/admin-shared | `packages/admin/admin-shared/` | 候选根 `LICENSE` |
| @medusajs/admin-vite-plugin | `packages/admin/admin-vite-plugin/` | 候选根 `LICENSE` |
| @medusajs/dashboard | `packages/admin/dashboard/` | 候选根 `LICENSE` |
| @medusajs/admin-sdk | `packages/admin/admin-sdk/` | 候选根 `LICENSE` |
| @medusajs/admin-bundler | `packages/admin/admin-bundler/` | 候选根 `LICENSE` |

根 `LICENSE:3` 写明 “Copyright (c) 2021 Medusajs”；`LICENSE:5–10`
授予 use、copy、modify、merge、publish、distribute、sublicense、sell 权利；
`LICENSE:12–13` 要求保留版权和许可声明。根文件 SHA-256：
`f792b19e548b936c2a9a8e489e2f21e3b5a91e482910c57d9c9508f8933789af`。

用原仓库 `git ls-tree -r --name-only 1014c0337027a6087410ad3cc1da9a11fd83ca8d`
检查候选，当时只有根许可与三个 design-system 独立许可文件，没有
`ENTERPRISE-LICENSE.md`，也没有上述五个目录的许可例外。
后续 `21abe66783ce5eac6a982dc5304f02231a9c3fa6` 引入的企业声明明确写明：
“This notice applies prospectively and does not withdraw rights already granted
for earlier versions … under the MIT License.”

此结论限定于候选源码。不能据此将最新版 Dashboard/RBAC/SSO 产物认定为 MIT；
新版企业目录的 compiled/bundled/transformed 文件也受新版企业声明限制。
发布自有产物时应携带候选 MIT，并分别保留实际打入产物的第三方声明。

## 后续依赖安全升级线索

以下只从 `/workspace/medusa` 的 Git 提交正文和锁文件提取，
没有独立核验官方 advisory，也没有判断所有依赖的运行时可达性。

| 依赖 | 候选锁定版本 | 后续提交及升级 | 提交正文中的线索 |
| --- | --- | --- | --- |
| morgan | 1.11.0 | `7431388f4f`：1.11.0 → 1.12.0；framework manifest 同步升级 | “Security fix for CVE-2026-15603 (GHSA-jxfw-x594-9x9m)” |
| svgo | 3.3.2 | `7431388f4f`：3.3.2 → 3.3.5 | “addresses GHSA-4vpr-x523-8j87 and GHSA-w27v-7q3p-w38r”；SVG 的 URL / foreignObject 清理加固 |
| multer | 2.2.0 | `337386d29b`：2.2.0 → 2.3.0；medusa manifest 同步升级 | “security-updates group”；该提交没有提供具体漏洞编号 |

复核来源命令（只读）：

```bash
git -C /workspace/medusa show 1014c033:yarn.lock
git -C /workspace/medusa show --no-patch --format=%B 7431388f4f
git -C /workspace/medusa show --no-patch --format=%B 337386d29b
```

本轮没有升级以上依赖。生产开放前仍需确认公告的受影响范围、实际固定版本、
本项目使用路径，并在独立变更中完成兼容性和回归验证。

## 尚未完成的分发核查

- 完整锁文件依赖图，包括嵌套、多版本、可选依赖与平台依赖，尚未生成和核对。
- 本轮 15 项的本地许可证据明确；没有验证对应 npm tarball 的完整来源链或签名。
- workspace 源码结论没有自动覆盖独立发布的 npm 包及其实际携带的许可文件。
- 容器运行镜像、生产裁剪后的依赖和浏览器 bundle 尚未逐项核对版权、NOTICE、
  LICENSE 保留情况，也没有核验其他非 MIT 依赖的具体义务。
- 原 inventory 保持原样；使用清单时应同时读取本记录中对 `exit/LICENSE-MIT`
  和 `duplexer/LICENCE` 的纠正。
