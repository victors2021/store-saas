# 远程代码，本地浏览

云端 Agent 在虚拟机里跑代码；Cursor 把端口转发到你的电脑，用本机浏览器打开。

## 立刻可看（无需数据库）

在仓库根目录：

```bash
node saas/serve-local-browse.cjs
```

默认同时提供（**页面内容相同**，都是交互原型）：

| 端口 | 必须怎么开 | 和另一个有何不同 | Cloud Agent 建议 |
|---|---|---|---|
| `8080` | `http://localhost:8080/` | 明文 HTTP，转发点开即可 | **优先用这个** |
| `9443` | **必须** `https://localhost:9443/` | 自签 HTTPS；点 Forwarded Ports 若走 `http://` 会失败或只看到提示页 | 仅当你要测 HTTPS 入口时 |

两者都是 `docs/saas/saas-prototype.html`（本地模拟数据，**不连后端**）。  
**不是**完整演示栈：完整栈的 9443 需要持久预览库、登录、网关；当前云环境没有预览库时，本启动器只是占用同端口号提供原型，避免空白。

### 在 Cursor 里打开（推荐 8080）

1. 打开本 Cloud Agent（桌面端优先用 **Agents Window**）。
2. 编辑器面板右上角 **Forwarded Ports**（插头图标）。
3. 打开 **`http://localhost:8080/`**。
4. 若一定要用 9443：手动输入 `https://localhost:9443/`（不要用 `http://`），并接受自签证书警告。

若 9443 “打不开”：多半是用了 `http://localhost:9443/`。现在会返回说明页；正确地址是 `https://`。`/status.json` 可确认当前是原型模式。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `SAAS_LOCAL_BROWSE_PORT` | `8080` | HTTP 浏览端口 |
| `SAAS_LOCAL_BROWSE_HTTPS_PORT` | `9443` | HTTPS 浏览端口；设为 `0` 可关闭 |
| `SAAS_LOCAL_BROWSE_HOST` | `0.0.0.0` | 监听地址 |
| `SAAS_LOCAL_BROWSE_TLS_DIR` | 系统临时目录下的私有目录 | 自签证书存放位置 |

`.cursor/environment.json` 已声明 `local-browse` / `demo-tls` 端口，并在 `start` 中启动该服务，供新的 Cloud Agent 启动时自动拉起。

## 完整演示栈（需持久预览库）

需要真实注册页 `https://localhost:9443/register` 时，先一次性准备（Postgres/Redis、
标记库、密钥、迁移、Admin/商城构建）：

```bash
bash saas/bootstrap-cloud-preview.sh
```

然后启动：

```bash
source /workspace/.store-saas-environment/activate.sh
# 若本启动器已占用 9443，先停掉它，再启动完整栈
pkill -f 'node saas/serve-local-browse.cjs' || true
NODE_ENV=development SAAS_PREVIEW_DIRECTORY=/workspace/.store-saas-preview \
  SAAS_CLOUD_LOCAL_BROWSE=1 \
  node saas/start-demo-preview.cjs
```

`SAAS_CLOUD_LOCAL_BROWSE=1` 时 TLS 与 API 绑定 `0.0.0.0`，便于 Cursor 端口转发；仍要求私有预览目录、标记库与自签证书，**不是公网部署**。开启后在 Forwarded Ports 打开 `9443`，用本机浏览器访问 `https://localhost:9443/`（需信任预览目录里的自签证书）。统一 localhost HTTPS 入口说明见 [localhost 开发入口](25-LOCALHOST-DEVELOPMENT.md)；历史主机名 `shops.example.test` 仍见 [自助开店交付](24-SELF-SERVICE-ONBOARDING.md)。当前云 Agent 环境若缺少预览库，请用本页上面的 8080/9443 原型浏览，不要期望完整栈 API。
