# localhost 开发入口

更新日期：2026-10-10。该功能是本地开发入口兼容，不是公网部署。

## 访问地址

| 页面 | 默认开发地址 |
|---|---|
| SaaS 官网 | `https://localhost:9443/` |
| 邮箱登录 | `https://localhost:9443/login` |
| 我的网店 | `https://localhost:9443/dashboard` |
| 演示店铺商城 | `https://demo-store.shops.localhost:9443/` |
| 演示商家后台 | `https://demo-store.shops.localhost:9443/app/` |
| 平台管理 | `https://platform.shops.localhost:9443/platform` |

注册、登录及“进入商家后台”均使用当前入口生成跳转。官网可用 `localhost`
或 `shops.localhost`；店铺使用 `<slug>.shops.localhost`。采用三级店铺域名是为了
让标准 TLS 校验接受 `*.shops.localhost`，不使用不兼容的 `*.localhost` 通配证书。
当前 Chromium 对 `.localhost` 自动回环解析；验证不使用 hosts 修改或浏览器 DNS 映射。
其他浏览器/命令行若不自动解析，需要本机 DNS/hosts 将对应名称映射到回环地址。

这些地址连接访问者自己的电脑。服务必须在该电脑运行，或通过既有受支持的 TCP
转发连接到服务所在环境。代码兼容不创建 SSH、VPN、公网域名或云环境转发入口。

当前浏览器入口统一为 **9443（HTTPS）**，8080 没有启用。端口号本身不决定协议；
9443 是本项目为开发 HTTPS 选定的端口。官网、网店和平台共用该端口，按访问域名
及路径路由。访问时请写完整的 `https://localhost:9443/`。

## 启动与 HTTPS

完成原有依赖安装、编译、数据库迁移及私有开发配置后，在当前已准备的环境运行：

```bash
source /workspace/.store-saas-environment/activate.sh
cd /workspace/store-saas
NODE_ENV=development SAAS_PREVIEW_DIRECTORY=/workspace/.store-saas-preview \
  node saas/start-demo-preview.cjs
```

预览启动器默认开启 localhost 兼容，只监听回环地址。TLS 默认 9443、API 9130、
商城 Next 8130；通过原有 `SAAS_PREVIEW_TLS_PORT` 可更换外部 HTTPS 端口。
仍须核对已有持久库 marker，禁止重置或重新创建原租户及管理员凭据。
重复启动前先停止已核实的旧预览 supervisor；不要同时占用相同端口。

首次开启时，`saas/localhost-tls.cjs` 在私有开发目录生成一对独立的 30 天自签
开发证书及私钥，覆盖 localhost、shops.localhost、一级店铺域名及原 example.test
域名。原 `tls-demo-*` 文件保持不变。再次启动复用新证书，并验证域名、有效期、
密钥匹配和文件权限；缺损、过期或不匹配会拒绝启动，不盲目覆盖已有文件。

本机浏览器需要导入并信任**该次运行生成的** `tls-localhost-cert.pem`。
不能使用其他机器生成的证书，也不要复制或公开 `tls-localhost-key.pem`。
正常登录仍使用 HTTPS、Secure/HttpOnly cookie；这次没有新增明文 HTTP 登录。

通用运行配置默认关闭 `SAAS_LOCALHOST_ACCESS`。预览启动器显式设置它为 `true`；
设置为 `false` 可恢复原 example.test 入口及证书。仅 development/test 模式、
保留的 example.test 域名且没有发布 manifest 时允许开启，生产或正式域名拒绝开启。
Next 仍采用生产构建，只从经过校验的后端启动器接收这个非秘密开发开关。

## 数据和认证边界

- localhost 别名先映射到原有规范域名，再通过原控制层查询租户，继续执行成员
  身份、配额、暂停规则、工作流守卫与事务级 RLS。不创建 localhost 数据库域名记录。
- 不接受客户端 `tenant_id` 或转发 Host 来选择租户。浏览器写操作仍要求实际访问
  地址的精确 Origin（含协议和端口）；同一个店铺的两个域名也不能替换写操作 Origin。
- 商家原生 session 保持实际主机隔离；其他店铺、官网和平台不能使用该 session。
  官网和平台分别沿用原有账号认证、固定时限 session 和 CSRF。
- 已有模拟商品的本店图片只在 localhost 响应中投影为相对媒体路径，数据库保存的
  URL、任意 metadata、外部图片和其他店铺的 URL 均不改动。
- 演示邮箱继续是 `demo@shops.example.test` 和 `demo-admin@shops.example.test`，
  原普通平台管理员仍是 `admin@shops.example.test`。密码不显示、不提交仓库。

## 验证与限制

验证结果保存到 [localhost-evidence/summary.json](localhost-evidence/summary.json)，
共通过 97 项场景检查：localhost 接口 9 项、localhost 浏览器 15 项、原域名接口
19 项、原域名浏览器 15 项、平台邮箱登录 18 项、安全回归 11 项、持久演示服务
浏览器 10 项；另验证新开发证书首次生成和重复启动时的复用。
商城 Next 构建通过，包含类型及 lint 检查；原生 Medusa/Admin 沿用已有编译产物，
没有重复运行完整 monorepo 构建或长时间容量压测。
包括原生接口隔离、完整浏览器注册/登录/
开店/样品清除/商家后台/平台登录、标准 TLS 主机名验证及原入口回归。
浏览器自动化仅信任该次自有开发证书的公钥指纹，不全局忽略 HTTPS 错误；
另外以独立 SSL 客户端执行证书链和主机名校验。开发信任不是正式 TLS 发布验收。

本次没有新增业务模块、数据库迁移或 SaaS 模板市场。现有正式发布、真实支付、
独立备份目标和性能容量验收仍按原计划执行。当前云环境仍没有用户可用的外部转发。
