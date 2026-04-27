# JB AI Proxy

JetBrains AI 反向代理，将 JetBrains AI API 转换为 OpenAI 和 Anthropic 兼容格式。

## 一键启动（Windows）

1. **先安装 Node.js 18+**：https://nodejs.org/ （下载 LTS 版本，一路下一步）
2. **解压本压缩包**到任意目录（路径不要带空格和中文）
3. **双击 `START.bat`** 即可

脚本会自动：
- 检查 Node.js
- 首次运行时复制配置模板（config.json / credentials.json / cf_settings.json）
- 首次运行时自动 `npm install`（约 30 秒）
- 启动反代服务

打开 `http://localhost:3000/panel`（默认密码 `12345`）。

> **国内用户必看**：JetBrains AI / Cloudflare API 在国内被墙，**必须开梯子**。
> 在面板「CF 代理池」里填梯子地址（如 `http://127.0.0.1:7890`），
> 这个梯子只用于反代进程内的 fetch，不影响你本机其他程序。

> **如果 npm install 失败**：国内 npm 默认源慢/被墙，先在 cmd 里执行：
> ```
> npm config set registry https://registry.npmmirror.com
> ```
> 然后重新双击 `START.bat`。

## 手动启动（Mac/Linux 或不想用 bat）

```bash
cp config.example.json config.json
cp credentials.example.json credentials.json
cp cf_settings.example.json cf_settings.json
npm install
node server.js
```

## 功能

- OpenAI 兼容（`/v1/chat/completions`、`/v1/models`）
- Anthropic 兼容（`/v1/messages`）
- 流式 / 非流式响应
- 多轮对话、工具调用、图片输入
- **思考强度后缀**（`-thinking` / `-maxthinking` / `-low/-medium/-high`）
- **动态模型同步**（面板一键从 JB 拉最新列表）
- **Cloudflare Workers 代理池**（分散 IP）
- **配额聚合面板**（实时查看所有账号 license 使用情况）
- **稳定性增强**：上游 terminated 自动换号重试 / 客户端断开立即取消上游
- 多账号轮询 + API Key 鉴权 + Web 管理面板

## 支持的模型

通过 JetBrains AI 可使用 50+ 模型：
- **OpenAI**: GPT-4o、GPT-4.1、GPT-5 系列、o1/o3/o4-mini
- **Anthropic**: Claude 4 / 4.5 / 4.6 / 4.7 全系
- **Google**: Gemini 2.0/2.5/3.x Flash/Pro
- **xAI**: Grok-4、Grok-4.1 Fast

## 添加账号

### 方式一：批量导入（推荐）
面板「批量导入」粘贴账号列表（支持 JSON / `email----password` / 空格 / 逗号 / Tab 分隔等格式自动检测）。

### 方式二：OAuth 登录
面板「添加账号」→ JB 授权 → 粘贴回调 URL → 填 License ID。

### 方式三：手动导入
面板「手动导入」填 Refresh Token + License ID。

## 客户端配置

在 Cherry Studio、Cursor、ChatGPT-Next-Web 等客户端中：

- **Base URL**: `http://你的IP:3000/v1`
- **API Key**: `config.json` 中的 key（默认 `12345`）
- **Model**: 用 JB profile ID，如 `anthropic-claude-4-6-opus`、`anthropic-claude-4-5-sonnet-thinking`

## 思考强度（写代码场景重点）

模型名加后缀启用思考：

| 后缀 | 适用模型 | 实现 |
|---|---|---|
| `-low` / `-medium` / `-high` | GPT-5 系 / o-系 | 原生 reasoning-effort |
| `-thinking` | Gemini 2.5/3.x | 原生 thinking-budget 8K |
| `-maxthinking` | Gemini 2.5/3.x | 原生 thinking-budget 24K |
| `-thinking` | Claude 全系 / Grok | system prompt 注入 + `<thinking>` 标签 |
| `-maxthinking` | Claude 全系 / Grok | 强化版 prompt（含 self-critique） |

**示例**：
- `anthropic-claude-4-5-sonnet` —— 原版（无思考）
- `anthropic-claude-4-5-sonnet-thinking` —— 标准思考（token 消耗 3-5 倍）
- `anthropic-claude-4-5-sonnet-maxthinking` —— 深度思考（消耗 ~10 倍）
- `openai-gpt-5-high` —— GPT-5 高强度推理

## CF 代理池（可选但强推）

1. 注册 Cloudflare（免费即可）
2. Workers & Pages 页面右侧拿 **Account ID**
3. 头像 → My Profile → API Tokens → Create Token → 选 `Edit Cloudflare Workers` 模板
4. 进面板「CF 代理池」→ 填 API Token + Account ID + 梯子地址 → 「保存并部署」
5. 部署成功后，反代启动时会自动从 CF 恢复 Workers 池

## 常见问题

### Q: 双击 START.bat 报 `Cannot find module 'express'`
A: npm install 没执行成功。打开 cmd 进入解压目录手动跑：
```
npm install
node server.js
```

### Q: Cursor 用着突然报 `terminated` 错误
A: v3 已修复 — 现在反代会自动换账号重试一次，看 cmd 终端会有 `[chat] upstream terminated, retry with another account` 黄色警告但**不会抛错给 Cursor**。

### Q: Cursor 任务卡住、要等很久
A: 上游 JB 的 chat 端点偶尔慢，这是 JB 服务端 / 梯子节点延迟，不是反代的 bug。卡住时直接在 Cursor 取消请求即可，反代会自动取消上游 fetch（不浪费 token）。

### Q: 启动后访问面板报 502 / 卡住不动
A: 国内必须开梯子。Cloudflare API 和 JB AI 在国内被墙，反代访问不到上游。

### Q: 「同步上游模型」按钮失败
A: 同上，需要梯子。不点也没事，反代有内置 fallback 模型列表。

## v3 更新（2026-04-26）

- ✅ 修复 `terminated` 错误：上游断开自动换账号重试 1 次，不再抛错给 Cursor
- ✅ 修复客户端断开守护：Cursor 取消请求时反代立即取消上游 fetch（不浪费 token）
- ✅ 修复 `write after end` 崩溃：流式响应中 socket 关闭后不再抛错
- ✅ 修复 `<thinking>` 标签跨 chunk 边界吞字符
- ✅ 修复模型后缀正则锚定 bug

## 配置说明

编辑 `config.json`：
- `port`: 监听端口（默认 3000）
- `api_key`: API 密钥，留空 = 不鉴权
- `panel_password`: 面板密码，留空 = 不鉴权
