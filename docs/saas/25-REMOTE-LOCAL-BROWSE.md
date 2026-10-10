# 远程代码，本地浏览

云端 Agent 在虚拟机里跑代码；Cursor 把端口转发到你的电脑，用本机浏览器打开。

## 立刻可看（无需数据库）

在仓库根目录：

```bash
node saas/serve-local-browse.cjs
```

默认绑定 `0.0.0.0:8080`，提供 `docs/saas/saas-prototype.html` 交互原型（本地模拟数据，不连后端）。

### 在 Cursor 里打开

1. 打开本 Cloud Agent（桌面端优先用 **Agents Window**）。
2. 编辑器面板右上角 **Forwarded Ports**（插头图标）。
3. 确认 `8080` 已转发（可开启 Auto-Forward Ports）。
4. 用内置浏览器，或本机浏览器打开 `http://localhost:8080/`。

若打不开：确认进程仍在运行，且监听地址不是仅限 `127.0.0.1` 时的异常转发环境；本启动器默认绑 `0.0.0.0`。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `SAAS_LOCAL_BROWSE_PORT` | `8080` | 浏览端口 |
| `SAAS_LOCAL_BROWSE_HOST` | `0.0.0.0` | 监听地址 |

`.cursor/environment.json` 已声明 `local-browse` 端口，并在 `start` 中启动该服务，供新的 Cloud Agent 启动时自动拉起。

## 完整演示栈（需持久预览库）

带 TLS / 网关 / 商城的演示仍使用：

```bash
source /workspace/.store-saas-environment/activate.sh
NODE_ENV=development SAAS_PREVIEW_DIRECTORY=/workspace/.store-saas-preview \
  SAAS_CLOUD_LOCAL_BROWSE=1 \
  node saas/start-demo-preview.cjs
```

`SAAS_CLOUD_LOCAL_BROWSE=1` 时 TLS 与 API 绑定 `0.0.0.0`，便于 Cursor 端口转发；仍要求私有预览目录、标记库与自签证书，**不是公网部署**。主机名仍为 `shops.example.test`（见 [自助开店交付](24-SELF-SERVICE-ONBOARDING.md)）。当前环境若缺少预览库或 Docker，请先用上面的 8080 原型浏览。
