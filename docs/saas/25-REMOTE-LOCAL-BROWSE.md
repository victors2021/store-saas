# 远程代码，本地浏览

云端 Agent 在虚拟机里跑代码；Cursor 把端口转发到你的电脑，用本机浏览器打开。

## 立刻可看（无需数据库）

在仓库根目录：

```bash
node saas/serve-local-browse.cjs
```

默认同时提供：

| 协议 | 端口 | 地址 |
|---|---:|---|
| HTTP | `8080` | `http://localhost:8080/` |
| HTTPS（自签） | `9443` | `https://localhost:9443/` |

两者都提供 `docs/saas/saas-prototype.html` 交互原型（本地模拟数据，**不连后端**）。
云环境若还没有持久预览库 / PostgreSQL，**完整演示栈不会占用 9443**；此时本启动器会接管 9443，避免 Forwarded Ports 打开空白页。若 9443 已被完整演示占用，HTTPS 预览会跳过并保留 8080。

### 在 Cursor 里打开

1. 打开本 Cloud Agent（桌面端优先用 **Agents Window**）。
2. 编辑器面板右上角 **Forwarded Ports**（插头图标）。
3. 确认 `8080` 和/或 `9443` 已转发（可开启 Auto-Forward Ports）。
4. 打开 `http://localhost:8080/`，或 `https://localhost:9443/`（首次需在浏览器接受自签证书警告）。

若打不开：确认进程仍在运行，且监听地址不是仅限 `127.0.0.1` 时的异常转发环境；本启动器默认绑 `0.0.0.0`。`/status.json` 可确认当前是原型模式。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `SAAS_LOCAL_BROWSE_PORT` | `8080` | HTTP 浏览端口 |
| `SAAS_LOCAL_BROWSE_HTTPS_PORT` | `9443` | HTTPS 浏览端口；设为 `0` 可关闭 |
| `SAAS_LOCAL_BROWSE_HOST` | `0.0.0.0` | 监听地址 |
| `SAAS_LOCAL_BROWSE_TLS_DIR` | 系统临时目录下的私有目录 | 自签证书存放位置 |

`.cursor/environment.json` 已声明 `local-browse` / `demo-tls` 端口，并在 `start` 中启动该服务，供新的 Cloud Agent 启动时自动拉起。

## 完整演示栈（需持久预览库）

带 TLS / 网关 / 商城、真实登录与店铺数据的演示仍使用：

```bash
source /workspace/.store-saas-environment/activate.sh
# 若本启动器已占用 9443，先停掉它，再启动完整栈
NODE_ENV=development SAAS_PREVIEW_DIRECTORY=/workspace/.store-saas-preview \
  SAAS_CLOUD_LOCAL_BROWSE=1 \
  node saas/start-demo-preview.cjs
```

`SAAS_CLOUD_LOCAL_BROWSE=1` 时 TLS 与 API 绑定 `0.0.0.0`，便于 Cursor 端口转发；仍要求私有预览目录、标记库与自签证书，**不是公网部署**。开启后在 Forwarded Ports 打开 `9443`，用本机浏览器访问 `https://localhost:9443/`（需信任预览目录里的自签证书）。统一 localhost HTTPS 入口说明见 [localhost 开发入口](25-LOCALHOST-DEVELOPMENT.md)；历史主机名 `shops.example.test` 仍见 [自助开店交付](24-SELF-SERVICE-ONBOARDING.md)。当前云 Agent 环境若缺少预览库，请用本页上面的 8080/9443 原型浏览，不要期望完整栈 API。
