# Antigravity2Api

本服务将 Antigravity 代理出来，转换为标准的 Claude API 和 Gemini API 接口，

* 完整适配CC
* MCP XML bridge（mcp__* 工具）
* function_calling
* subagent
* 结构化输出
* 流式思考
* 完整的交错思考签名验证（thoughtsignature）
* 大香蕉生图
* web_search（Antigravity内置的flash2.5模型）
* token计算 count_tokens
* Gemini端点支持geminicli(没严格测试)
* 账号切换等等。

特性：

- **Thought Signatures（思考签名）**：按 Gemini 官方规范透传 `thoughtSignature`，在 thinking / 工具调用等场景中确保下一轮请求能原样带回签名，避免 `missing thought_signature` 类校验错误。
- **工具调用（Tool Use）**：支持 Claude `tool_use` / `tool_result` 与 Gemini `functionCall` / `functionResponse` 的互转，兼容需要工具调用的客户端/工作流。

**关于MCP**：
在使用MCP时，claude转为antigravity的v1internal接口所使用的gemini格式后，v1internal内部判断当前model是claude，会将request转回claude格式，但是其内部接口又不能使用claude的一些字段，所以MCP会有各种奇奇怪怪的问题，这也是使用原生Antigravity时会出现各种MCP问题的原因。只能看google后续会不会去修Antigravity的MCP，**或者你也可以试用下如下WORK-AROUND FOR MCP方案**

### WORK-AROUND FOR MCP：XML 方案（推荐）已测试多个MCP使用正常！

> 仅覆盖 `mcp__*` 工具，用于绕过 Antigravity/v1internal 对 MCP tools 的兼容性问题。

测试结果：

![MCP XML 测试结果](screenshot-20260111-114221.png)

**原理（简述）**

- 上行：当检测到请求里包含 `mcp__*` tools 且 `AG2API_MCP_XML_ENABLED=true` 时：
  - 不将 `mcp__*` tools 透传给 v1internal（避免 schema/字段不兼容导致的 400/校验错误）
  - 在 systemInstruction 注入 XML 协议说明，引导模型用 `<mcp__...>{...}</mcp__...>` 文本表示工具调用
  - 历史里的 `mcp__* tool_use/tool_result` 也会编码为 XML 文本回传上游
- 下行：代理从**非思考文本流**中解析上述 XML，并转换为标准 Claude `tool_use`；客户端返回 `tool_result` 后再编码为 `<mcp_tool_result>{...}</mcp_tool_result>` 发回上游。

示例：

```xml
<mcp__serena__check_onboarding_performed>{}</mcp__serena__check_onboarding_performed>
```

**使用方法**

1) 在 `.env` 开启：

```bash
AG2API_MCP_XML_ENABLED=true
```

2) 重启服务后，Claude Code/客户端正常使用 `mcp__*` 工具场景即可（代理会自动桥接 XML ↔ tool_use/tool_result）。

### （已弃用）MCP Switch 方案：`AG2API_SWITCH_TO_MCP_MODEL`

旧方案通过在首轮流式输出中检测特殊字符串 `AG2API_SWITCH_TO_MCP_MODEL`（或仍然出现 `mcp__* tool_use`）后，切换到指定 `gemini-*` 模型重发本轮请求以执行 MCP；保留兼容但不再推荐，后续可能移除。

> **推荐启动方式**：在项目根目录运行 `npm run start`（或 `node src/server.js`）。本项目会以当前工作目录（`process.cwd()`）定位 `.env`、`auths/`、`log/`；如果你在 `src/` 目录运行，则对应路径会变成 `src/.env`、`src/auths/`、`src/log/`。

启动后可直接访问管理界面：`http://localhost:3000/`（端口以 `AG2API_PORT` 为准，默认 3000）。

## 1. 环境准备

确保已安装 [Node.js](https://nodejs.org/) (建议版本 v18 或更高)。

## 2. 安装依赖

在项目根目录执行一次即可：

```bash
npm install
```

> 本项目核心逻辑可零依赖运行；但如果你启用了代理（`AG2API_PROXY_ENABLED=true`），建议执行一次 `npm install` 以确保代理对 `fetch` 生效（依赖包含 `undici` / `node-fetch` / `*-proxy-agent` 等）。

> **注意**：如果在 PowerShell 中遇到“无法加载文件...npm.ps1”的错误，请尝试使用 CMD 运行，或者使用以下命令绕过策略：
> ```bash
> cmd /c npm install
> ```

## 3. 配置文件 (.env)

在项目根目录下创建 `.env`（建议从 `.env.example` 复制），通过环境变量配置服务。

**示例 `.env`：**

```bash
AG2API_HOST=0.0.0.0
AG2API_PORT=3000
AG2API_API_KEYS=sk-your-secret-key-1,sk-your-secret-key-2
AG2API_PROXY_ENABLED=false
AG2API_PROXY_URL=
AG2API_DEBUG=false
AG2API_LOG_RETENTION_DAYS=3
AG2API_RETRY_DELAY_MS=1200
AG2API_QUOTA_REFRESH_S=300
AG2API_MCP_XML_ENABLED=true
# Deprecated:
# AG2API_SWITCH_TO_MCP_MODEL=gemini-3-flash
AG2API_UPDATE_REPO=znlsl/Antigravity2Api
```

**配置项说明：**

- `AG2API_HOST`：监听地址
- `AG2API_PORT`：监听端口
- `AG2API_API_KEYS`：API Key（逗号分隔或 JSON 数组字符串；为空表示不校验）
- `AG2API_PROXY_ENABLED`：是否启用代理（true/false）
- `AG2API_PROXY_URL`：代理地址
- `AG2API_DEBUG`：是否开启 debug（true/false）
- `AG2API_LOG_RETENTION_DAYS`：日志保留天数（默认 3；设为 0 表示不自动清理；当 >0 且服务长时间不重启时，会按该天数轮转日志文件，并在轮转后清理旧日志文件，避免单个日志无限增长）
- `AG2API_RETRY_DELAY_MS`：网络错误 / 429 重试前的固定等待（毫秒，默认 1200）
- `AG2API_QUOTA_REFRESH_S`：额度刷新间隔（秒；每次并发刷新所有账号；默认 300）
- `AG2API_MCP_XML_ENABLED`：MCP XML 方案开关（仅 `mcp__*`）；开启后不透传 `mcp__* tools` 给 v1internal，改为 XML 协议桥接并在下游还原为 `tool_use/tool_result`
- `AG2API_SWITCH_TO_MCP_MODEL`：（已弃用）旧的 MCP Switch 方案；为空/不配置表示关闭，配置为 `gemini-*`（如 `gemini-3-flash`）表示在检测到 `AG2API_SWITCH_TO_MCP_MODEL` 信号或 `mcp__* tool_use` 时自动切换并重试
- `AG2API_UPDATE_REPO`：管理界面版本检查的 GitHub 仓库（默认 `znlsl/Antigravity2Api`，用于获取 latest release）

Google OAuth Client（可选覆盖）：

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`

## 4. 启动服务

运行以下命令启动服务器：

```bash
npm run start
```

启动后打开管理界面添加/删除账号：

- 管理界面：`http://localhost:3000/`
- OAuth 添加账号：点击页面中的 “OAuth 添加账号” 按钮

如果你仍然希望用命令行方式添加账号，也可以运行：

```bash
npm run add
```

> `npm run add`（或 `node src/server.js --add`）授权成功后会继续启动服务（同 `npm run start`），无需再手动重启。

## 5. Web 管理界面

管理界面提供：

- 查看已加载账号（脱敏信息）
- OAuth 添加账号（写入 `auths/*.json`）
- 删除账号（删除对应 `auths/*.json`）
- 版本更新提醒：页面底部会显示本地版本，并尝试从 GitHub latest release 获取最新版本；如发现更新会提示跳转到 Release 页面（网络不可用/被墙时会自动忽略）

如果你设置了 `AG2API_API_KEYS`，页面会要求你输入 Key 才能调用管理接口（Key 仅保存在浏览器本地）。

> OAuth 回调默认使用：`http://localhost:<port>/oauth-callback`（`<port>` 取 `AG2API_PORT`，默认 3000）。
> 若你是在远程机器访问本服务，授权完成后浏览器可能会跳转到 `localhost`，请把地址栏里的 `localhost:<port>` 改成当前服务地址再回车即可。
> 如果你不方便改地址，也可以直接复制地址栏里的完整回调链接（或仅复制 `code`），粘贴到管理页 “提交” 输入框中完成授权入库。

## 6. Docker 部署

推荐直接使用已发布的 GHCR 镜像：`ghcr.io/znlsl/antigravity2api:latest`（`linux/amd64` + `linux/arm64`）。

### 6.1 使用 GHCR 镜像（推荐）

1) 复制环境变量文件并修改（不要提交 `.env`）：

```bash
cp .env.example .env
```

2) 启动（拉取 GHCR 镜像）：

```bash
docker compose -f docker-compose.ghcr.yml up -d
```

3) 更新版本：

```bash
docker compose -f docker-compose.ghcr.yml up -d --pull always
```

> 私有仓库/私有镜像需要先登录：`docker login ghcr.io`

### 6.2 本地构建（可选）

本地构建适合你要改代码/调试 Dockerfile 的情况。

用 compose 构建并启动：

```bash
docker compose up -d --build
```

或手动 build + run：

构建镜像：

```bash
docker build -t antigravity2api:latest .
```

启动容器（使用 `.env` 传配置）：

```bash
docker run -d --name antigravity2api \
  -p 3000:3000 \
  --env-file .env \
  -v "$(pwd)/auths:/app/auths" \
  -v "$(pwd)/log:/app/log" \
  antigravity2api:latest
```

数据持久化：

- `./auths`（账号凭证）
- `./log`（日志）

### 6.3 GitHub Actions 自动构建 GHCR 镜像

已提供工作流：`.github/workflows/release.yml`：

- 每次 push 到 `main` 会自动构建并推送：

- `ghcr.io/znlsl/antigravity2api:latest`
- 平台：`linux/amd64` + `linux/arm64`（multi-arch）

- 每次 push tag（任意 tag，例如 `v1.2.3` / `2025.12.27-t020612`）会自动：
  - 创建 GitHub Release（自动生成 Release Notes）
  - 构建并推送镜像：`ghcr.io/znlsl/antigravity2api:<tag>` + `:latest`

### 6.4 服务器更新镜像（升级）

如果你使用的是 GHCR 镜像部署（`docker-compose.ghcr.yml`），当仓库有新提交并且 GitHub Actions 构建完成后，在服务器执行：

```bash
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

如果你使用的是本地构建（`docker-compose.yml` 的 `build:`），更新代码后需要重新构建：

```bash
docker compose up -d --build
```

## 7. 客户端连接 (如 CherryStudio)

在客户端中添加自定义提供商（Claude）：

*   **API 地址 (Endpoint)**: `http://localhost:3000` (或 `http://<本机IP>:3000`)
    *   Claude 兼容路径: `http://localhost:3000/v1/messages`
    *   Gemini 原生路径: `http://localhost:3000/v1beta`
*   **API 密钥 (API Key)**: 填写你在 `AG2API_API_KEYS` 中配置的任意一个 Key。
    *   支持的传递方式：`Authorization: Bearer <key>` / `x-api-key` / `anthropic-api-key` / `x-goog-api-key`

## 8. 常见问题

*   **401 Unauthorized**: 检查客户端填写的 API Key 是否与 `AG2API_API_KEYS` 中的一致。
*   **Proxy 错误 / 超时**:
    *   确保已运行 `npm install` 安装依赖。
    *   检查 `AG2API_PROXY_URL` 是否正确且代理软件已开启。
    *   如果是 SOCKS5 代理，确保 `socks-proxy-agent` 已安装。

*   **支持的模型**:
    *   **Claude API** 支持如下模型（可在 Claude Code 中使用 Gemini 模型）:
        *   `claude-sonnet-4-5`
        *   `claude-sonnet-4-5-thinking`
        *   `claude-sonnet-4-5-20250929`
        *   `claude-opus-4-5`
        *   `claude-opus-4-5-thinking`
        *   `claude-opus-4-5-20251101`
        *   `gemini-3-pro-high`
        *   `gemini-3-pro-low`
        *   `gemini-3-flash`
        *   `gemini-2.5-flash`
        *   `gemini-2.5-flash-lite`
        *   `gpt-oss-120b-medium（仅限于chat）`
        *   `.claude/settings.json` 参考配置（示例）:
            ```json
            {
              "ANTHROPIC_MODEL": "claude-opus-4-5-thinking",
              "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gemini-3-flash",
              "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5-thinking",
              "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-5-thinking",
              "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            }
            ```
    *   **Gemini API** 支持如下模型（可在 Gemini CLI 中使用 Claude 模型）:
        *   `claude-sonnet-4-5`
        *   `claude-sonnet-4-5-thinking`
        *   `claude-opus-4-5-thinking`
        *   `gemini-3-pro-high`
        *   `gemini-3-pro-low`
        *   `gemini-3-flash`
        *   `gemini-3-pro-image`
        *   `gemini-2.5-flash`
        *   `gemini-2.5-flash-lite`
        *   `gpt-oss-120b-medium（仅限于chat）`
        *   使用 Claude 的参考启动命令:
            ```bash
            gemini --model claude-opus-4-5-thinking
            ```

*   **OAuth 回调打不开**:
    *   授权完成后若跳到 `http://localhost:<port>/oauth-callback`，请把 `localhost:<port>` 改成当前服务地址再访问。
    *   或者复制地址栏里的完整回调链接（或仅复制 `code`），粘贴到管理页输入框中点击 “提交”。
