# Pi Mobile

Pi Mobile 是一个“手机上的私有 Pi Agent App”项目：手机端提供类似 ChatGPT App 的聊天界面，真正的智能体运行在这台服务器上，通过 Pi SDK 调用本机的 `pi` agent 能力，从而可以在授权后读取文件、执行命令、修改代码、排查服务问题。

> 当前阶段：MVP 原型。目标是先跑通“手机浏览器/PWA ↔ Node 后端 ↔ Pi SDK ↔ 服务器”的完整链路，然后逐步补齐权限、安全、会话管理和移动端体验。

## 项目愿景

普通 ChatGPT App 的智能体运行在 OpenAI 服务器上；Pi Mobile 的智能体运行在自己的服务器上。手机只是远程交互入口，真正执行任务的是服务器里的 Pi Agent。

典型使用场景：

- 在手机上问：“这台服务器现在运行了哪些服务？”
- 让 Agent 检查 Docker、systemd、端口、日志。
- 让 Agent 帮忙修改项目文件、写脚本、排查错误。
- 长任务完成后未来可通过 ntfy/Bark/Telegram 推送通知。

## 当前 MVP 功能

- 单用户 Token 登录。
- 手机友好的 Web 聊天页面。
- 后端使用 `@earendil-works/pi-coding-agent` SDK 创建 Pi Agent Session。
- 支持流式显示 assistant 文本。
- 支持展示工具调用开始/结束事件。
- 支持 Abort 当前任务。
- 支持基础历史对话查看：后端将聊天展示日志保存到 `data/conversations/`，刷新页面后可恢复展示。
- 支持“新聊天”按钮：不删除旧聊天，创建新的 Pi Agent Session 和独立会话记录。
- 支持会话列表：展示服务器启动之后创建/迁移的所有聊天会话。
- 支持会话切换、删除、重命名。
- 支持在 WebUI 中选择 `~/.pi/agent/models.json` 声明的模型，不向前端暴露 API Key。
- 支持上传图片：通过 Pi SDK `images` 传给模型。
- 支持上传文本类文档：前端读取文本内容后拼接进 prompt。
- 默认只监听 `127.0.0.1:8787`，建议通过 Nginx/Caddy 反代 HTTPS 后访问。

## 目录结构

```text
/root/pi-mobile
├── README.md              # 项目说明、规划、交接文档
├── package.json           # Node 项目配置
├── server.js              # 后端：静态页面 + API + SSE + Pi SDK
├── public
│   ├── index.html         # 手机 Web UI
│   ├── app.js             # 前端逻辑
│   └── style.css          # 前端样式
└── data
    ├── sessions           # 预留：未来保存/管理 Pi 会话
    └── conversations       # Pi Mobile 会话索引和每个会话的展示消息
```

## 快速启动

```bash
cd /root/pi-mobile

# 设置访问令牌。务必改成强随机字符串。
export PI_MOBILE_TOKEN='change-me-to-a-long-random-token'

# 可选：指定 Agent 工作目录，默认 /root
export PI_MOBILE_CWD='/root'

# 启动
npm start
```

默认监听：

```text
http://127.0.0.1:8787
```

如果你只是临时测试，也可以让它监听公网地址：

```bash
PI_MOBILE_HOST=0.0.0.0 PI_MOBILE_TOKEN='强密码' npm start
```

但不建议长期公网裸奔，应该放到 HTTPS 反代和防火墙后面。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `PI_MOBILE_TOKEN` | `dev-token-change-me` | 前端登录和 API 鉴权 token。生产环境必须改。 |
| `PI_MOBILE_HOST` | `127.0.0.1` | 服务监听地址。建议保持本机监听。 |
| `PI_MOBILE_PORT` | `8787` | 服务端口。 |
| `PI_MOBILE_CWD` | `/root` | Pi Agent 的工作目录。 |

## API 设计

当前后端采用“POST 发消息 + SSE 收事件”的简单设计。

### 登录检查

```http
GET /api/state
Authorization: Bearer <token>
```

返回当前 Session 状态。

### 发送 Prompt

```http
POST /api/prompt
Authorization: Bearer <token>
Content-Type: application/json

{"message":"看看服务器上运行了哪些服务"}
```

### 获取历史消息

```http
GET /api/messages
Authorization: Bearer <token>
```

返回当前活动会话的聊天展示记录。多会话记录保存在 `data/conversations/`。

### 接收事件流

```http
GET /api/events?token=<token>
```

服务端会通过 Server-Sent Events 推送：

- `ready`
- `assistant_delta`
- `tool_start`
- `tool_end`
- `agent_end`
- `queue_update`
- `error`
- `raw`

### 获取和切换模型

```http
GET /api/models
POST /api/model
Authorization: Bearer <token>
```

切换请求示例：

```json
{"provider":"4Router","id":"gpt-5.5"}
```

后端只允许选择 `~/.pi/agent/models.json` 中声明的模型，返回结果不包含 `apiKey`、`baseUrl` 或私有 headers。Agent 正在运行时不允许切换模型。

### 会话列表

```http
GET /api/conversations
Authorization: Bearer <token>
```

返回服务器启动之后创建/迁移的所有 Pi Mobile 会话。

### 新建聊天

```http
POST /api/new-chat
Authorization: Bearer <token>
```

创建新的 Pi Agent Session 和新的 Pi Mobile conversation，不删除旧聊天。

### 切换/重命名/删除会话

```http
POST /api/conversations/<id>/select
PATCH /api/conversations/<id>
DELETE /api/conversations/<id>
```

### 终止当前任务

```http
POST /api/abort
Authorization: Bearer <token>
```

## 安全注意事项

这个项目的本质是“从手机远程操作服务器上的 Agent”。安全非常重要。

当前 MVP 已做：

- Bearer Token 鉴权。
- 默认只监听 `127.0.0.1`。
- 前端不保存真实服务器权限，只保存访问 token。

后续必须补强：

- 使用 HTTPS。
- 强随机 token 或正式登录系统。
- 工具调用审批：特别是 `bash`、`write`、`edit`。
- 危险命令拦截：`rm -rf`、`shutdown`、`reboot`、`mkfs`、`dd`、`iptables`、`ufw deny 22`、`systemctl stop ssh`、`docker rm -f` 等。
- 工作目录 allowlist，避免 Agent 默认拥有全盘操作自由。
- 对 `.env`、`/root/.ssh`、`/etc` 等敏感路径增加确认或禁止规则。
- 记录审计日志。

## 开发计划

### Phase 1：MVP 链路跑通，当前阶段

- [x] 创建项目骨架。
- [x] 写 README 和交接说明。
- [x] Node 后端集成 Pi SDK。
- [x] 手机 Web UI。
- [x] SSE 流式输出。
- [x] Token 鉴权。
- [x] Abort 当前任务。
- [x] 基础历史消息展示，刷新页面后恢复。
- [x] 新聊天按钮。
- [x] 聊天会话列表按钮。
- [x] 每个对话单独保存。
- [x] 删除和重命名对话。
- [x] WebUI 模型选择器。
- [x] models.json 模型白名单与后端切换 API。
- [x] 上传图片按钮。
- [x] 上传文档按钮。

验收标准：

- 手机/浏览器可以打开页面。
- 登录后可以发送消息。
- Agent 能流式回复。
- 工具调用能在 UI 中显示。

### Phase 2：会话管理

- [x] 新建会话。
- [x] 会话列表。
- [x] 恢复历史会话。
- [x] 显示/修改会话标题。
- [ ] 支持切换 cwd。
- [ ] 每个会话独立事件流和消息历史。

### Phase 3：权限和安全

- [ ] 工具调用前置审批。
- [ ] 危险 bash 命令拦截。
- [ ] 敏感文件保护。
- [ ] cwd allowlist。
- [ ] 只读模式。
- [ ] 审计日志。

### Phase 4：移动端体验

- [ ] PWA manifest。
- [ ] 添加到手机桌面。
- [ ] Markdown 渲染。
- [ ] 代码块复制按钮。
- [ ] 工具调用折叠/展开。
- [ ] 图片上传，映射到 Pi SDK images。

### Phase 5：通知和自动化

- [ ] ntfy/Bark/Telegram 推送。
- [ ] 长任务完成通知。
- [ ] 等待审批时推送手机通知。
- [ ] 常用服务器运维快捷按钮。

## 后续接手建议

另一个人接手时建议先看：

1. `README.md`：理解目标、架构、计划。
2. `server.js`：理解 Pi SDK session 如何创建、事件如何广播给前端。
3. `public/app.js`：理解前端如何登录、发送 prompt、订阅 SSE。
4. `public/index.html` 和 `public/style.css`：调整 UI。

优先优化顺序：

1. 安全：HTTPS、强 token、危险命令审批。
2. 会话：多 session 和历史恢复。
3. 体验：Markdown、PWA、移动端 UI。
4. 通知：长任务完成和审批推送。

## 当前已知限制

- 当前后端同一时间只有一个 active Pi SDK session；切换会话时会 dispose 当前 session 并打开目标 session。
- 页面刷新后可以恢复 Pi Mobile 自己的多会话展示日志，但还不是完整的 Pi 原生 session tree 浏览器。
- 还没有工具调用审批，生产使用前必须补。
- 还没有 HTTPS，需要反代部署。
