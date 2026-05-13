<p align="center">
  <h1 align="center">dario</h1>
  <p align="center"><strong>将你的 Claude Pro/Max 订阅用于 Cursor、Aider、Cline、Zed、Codex CLI、Claude Agent SDK —— 任何支持 Anthropic 或 OpenAI 的工具。</strong></p>
  <p align="center">一个本地 LLM 路由器。一个端点，所有提供商。你的 Claude 订阅 —— Pro（$20）、Max 5x（$100）或 Max 20x（$200）—— 不再闲置在 Claude Code 中，而你在其他地方按 token 付费。同时支持 Anthropic Messages API 和 OpenAI Chat Completions API，运行在 <code>http://localhost:3456</code>。</p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@askalf/dario"><img src="https://img.shields.io/npm/v/@askalf/dario?color=blue" alt="npm version"></a>
  <a href="https://github.com/askalf/dario/actions/workflows/ci.yml"><img src="https://github.com/askalf/dario/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/askalf/dario/actions/workflows/codeql.yml"><img src="https://github.com/askalf/dario/actions/workflows/codeql.yml/badge.svg" alt="CodeQL"></a>
  <a href="https://github.com/askalf/dario/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/@askalf/dario" alt="License"></a>
  <a href="https://www.npmjs.com/package/@askalf/dario"><img src="https://img.shields.io/npm/dm/@askalf/dario" alt="Downloads"></a>
</p>

<p align="center">
  <a href="https://x.com/ask_alf"><img src="https://img.shields.io/badge/follow-@ask_alf-1da1f2?style=flat-square" alt="Follow on X"></a>
  <a href="https://askalf.org"><img src="https://img.shields.io/badge/askalf.org-platform-00ff88?style=flat-square" alt="askalf"></a>
</p>

<p align="center"><em>零运行时依赖。每次发布都经过 <a href="https://www.npmjs.com/package/@askalf/dario">SLSA 认证</a>。不会回传数据。独立、非官方、第三方 —— 参见 <a href="DISCLAIMER.md">DISCLAIMER.md</a>。</em></p>

> **dario 是 [askalf](https://askalf.org) 的开源楔子** —— 我们正在构建的 AI 工作力平台。Dario 解决了 Claude 订阅问题，让其余工作力可以运行在固定费率计费上。Star 这个仓库或关注 [@ask_alf](https://x.com/ask_alf) 获取平台更新。

---

## 30 秒快速开始

```bash
# 1. 安装
npm install -g @askalf/dario

# 2. 登录你的 Claude 订阅（Pro、Max 5x 或 Max 20x）
dario login                      # 或 `dario login --manual` 用于 SSH / 无头环境

# 3. 启动本地 Claude API 代理
dario proxy

# 4. 将任何兼容 Anthropic 的工具指向它
export ANTHROPIC_BASE_URL=http://localhost:3456
export ANTHROPIC_API_KEY=dario
```

完成。所有使用这些环境变量的工具 —— Claude Code、Cursor、Aider、Cline、Roo Code、Continue.dev、Zed、Windsurf、OpenHands、OpenClaw、Hermes、Codex CLI、[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)、你自己的脚本 —— 现在都通过你的 **Claude 订阅**（Pro / Max 5x / Max 20x）路由，而不是按 token 的 API 定价。Dario 发送与 Claude Code 本身相同的请求格式，这正是订阅计费路径识别的格式。

更喜欢 Docker？`ghcr.io/askalf/dario:latest` 是一个多架构（`linux/amd64` + `linux/arm64`）镜像，每次发布都会更新 —— 家庭实验室、k8s、NAS。完整指南：[`docs/docker.md`](./docs/docker.md)。

对于 OpenAI / Groq / OpenRouter / Ollama / LiteLLM / vLLM，添加一个后端行并重用同一个代理：

```bash
dario backend add openai     --key=sk-proj-...
dario backend add groq       --key=gsk_...    --base-url=https://api.groq.com/openai/v1
dario backend add openrouter --key=sk-or-...  --base-url=https://openrouter.ai/api/v1
dario backend add local      --key=anything   --base-url=http://127.0.0.1:11434/v1

export OPENAI_BASE_URL=http://localhost:3456/v1
export OPENAI_API_KEY=dario
```

切换提供商只需在工具中**更改模型名称** —— `claude-opus-4-7`、`gpt-4o`、`llama-3.3-70b`、任何 OpenRouter / Groq / 本地模型 —— 无需重新配置。使用前缀强制指定后端：`openai:gpt-4o`、`claude:opus`、`groq:llama-3.3-70b`、`local:qwen-coder`。

有问题？`dario doctor` 打印一个可直接粘贴的健康报告。提交 issue 时粘贴它。

---

## 实际工作原理

你将所有工具指向一个 URL。Dario 读取每个请求，决定哪个后端拥有它，并以该后端的原生协议转发。

| 客户端协议 | 请求中的模型 | dario 路由到 | 发生什么 |
|---|---|---|---|
| Anthropic Messages API | `claude-*` / `opus` / `sonnet` / `haiku` | Claude 后端 | OAuth 交换 +（可选）CC 模板重放 → `api.anthropic.com` |
| Anthropic Messages API | `gpt-*`、`llama-*` 等 | OpenAI 兼容后端 | Anthropic → OpenAI 翻译，转发到配置的后端 |
| OpenAI Chat Completions | `gpt-*` / `o1-*` / `o3-*` | OpenAI 兼容后端 | 直通：认证交换，正文逐字节转发 |
| OpenAI Chat Completions | `claude-*` | Claude 后端 | OpenAI → Anthropic 翻译，然后走 Claude 后端路径 |
| 任一协议 | `<provider>:<model>` | 前缀强制 | 模糊名称的显式覆盖 |

工具不知道。后端不知道。Dario 是接缝。

除了路由，Claude 后端是一个**完整的 Claude Code 线级模板** —— 每个可观察的维度（字节、头部、正文键顺序、TLS 栈、请求间时序、会话 ID 生命周期、流消耗形状）都从你安装的 CC 二进制文件中捕获，并在出站请求上镜像，使上游订阅计费路径成为请求遵循的路径。参见 [`docs/wire-fidelity.md`](./docs/wire-fidelity.md)。

---

## 成本对比

Claude 订阅层级：**Pro**（$20/月）· **Max 5x**（$100/月）· **Max 20x**（$200/月）。Dario 通过你拥有的订阅路由 —— 根据你的使用量选择，而不是根据 dario 的需要。

| 设置 | 月度成本（重度单工具用户） |
|---|---|
| Cursor + Anthropic API 直连 | $80–$300 |
| Cursor + ChatGPT Plus | $20 + 超额按 token 计费 |
| **Cursor + Claude Pro/Max + dario** | **$20（Cursor）+ $20–200（你的 Claude 层级）固定 —— 每次 Claude 调用都通过你的订阅路由** |
| 多工具重度使用（Cursor + Aider + Cline + Continue）无 dario | $200–$600+ |
| **同样的多工具使用有 dario** | **$20–200 固定 —— 一个 Pro/Max 订阅路由所有工具** |

已经有 **Pro + Max** 叠加？池模式（`dario accounts add work` / `dario accounts add personal`）跨两者路由，会话粘性将多轮代理固定到一个账户，使提示缓存得以保留。层级可以自由混合 —— dario 只关心余量，不关心账户在哪个计划上。

---

## 为什么你会安装这个

- **一个 URL 对应所有提供商。** Cursor、Aider、Continue、Zed、OpenHands、Claude Code、你自己的脚本 —— 你拥有的每个工具都有自己的按提供商配置。Dario 将其折叠为一个 `localhost:3456`，同时支持 Anthropic 和 OpenAI 协议，并按模型名称路由。
- **你的 Claude 订阅不再闲置。** Cursor、Aider、Zed、Continue 都需要 API 密钥并按 token 计费，而你的 Pro / Max 5x / Max 20x 计划只在 Claude Code 中使用。Dario 通过 Claude Code 的精确线格式将它们路由到你的计划。
- **你在长时间代理运行时遇到速率限制。** 使用 `dario accounts add work` 添加第二个/第三个 Claude 订阅，池模式将每个请求路由到有最多余量的账户。会话粘性固定多轮对话；进行中的 429 故障转移到不同账户重试，然后客户端才看到错误。参见 [`docs/multi-account-pool.md`](./docs/multi-account-pool.md)。
- **你运行的编码代理不是 Claude Code。** Cline、Roo Code、Cursor、Windsurf、Continue.dev、GitHub Copilot、OpenHands、OpenClaw、Hermes、hands —— dario 的通用 `TOOL_MAP`（66 个模式验证条目）预映射它们的工具名称到 Claude Code 的原生集合。无需标志，无验证器错误。参见 [`docs/agent-compat.md`](./docs/agent-compat.md)。
- **你希望代理完全不在网络上。** Shim 模式是进程内的 `globalThis.fetch` 补丁 —— 无 HTTP 跳跃，无需绑定端口，无 `BASE_URL`。`dario shim -- claude --print "hi"` 让 CC 以为它直接与 `api.anthropic.com` 对话。参见 [`docs/shim.md`](./docs/shim.md)。
- **你希望从提示中移除 CC 的行为约束。** `dario proxy --system-prompt=partial` 移除 CC 的语气和风格/文本输出/详细程度/默认无评论的要点，在开放式工作上恢复约 1.2–2.8 倍的输出能力 —— 经验上不会翻转订阅计费（分类器不读取此槽）。有害内容的 RLHF 拒绝不受影响（对齐在权重中，不在提示中）。参见 [`docs/system-prompt.md`](./docs/system-prompt.md) 和 [`docs/research/system-prompt.md`](./docs/research/system-prompt.md) 中的经验报告。
- **你希望 dario 可从 Claude Code 或任何 MCP 客户端内部访问。** `dario subagent install` 注册一个 CC 子代理用于会话内诊断（[`docs/sub-agent.md`](./docs/sub-agent.md)）。`dario mcp` 将 dario 变成只读 MCP 服务器（[`docs/mcp-server.md`](./docs/mcp-server.md)）。
- **你希望实际审计它。** 约 13,170 行 TypeScript，跨 28 个文件。零运行时依赖。凭据在 `~/.dario/`，权限 `0600`。默认仅 `127.0.0.1`。每次发布 [SLSA 认证](https://www.npmjs.com/package/@askalf/dario)。不会回传数据。小到可以在周末读完。
- **你想要一个 $0/月的深度研究工具。** [deepdive](https://github.com/askalf/deepdive) 是 dario 的伴侣 CLI —— `npx @askalf/deepdive "你的问题"`，获得带引用的 Markdown 报告。替代 Perplexity Pro（$20/月）、OpenAI Deep Research（$20/月）、Gemini Deep Research（$20/月）—— 这些都是在 LLM 调用之上加价 LLM 调用。深度研究工作负载（每个问题 50k–200k token，持续）正是 Max 定价的目标；deepdive 就是为此使用它的。

---

## 独立评审（4 个 LLM）

对所有四个使用相同提示（[`reviews/PROMPT.md`](./reviews/PROMPT.md)）。每个评审者签署了结论行。推回在 [`review-feedback`](https://github.com/askalf/dario/issues?q=label%3Areview-feedback) 中分类。

| 评审者 | 结论 | 完整评审 |
|---|---|---|
| **Grok 4** | "如果用例合适就采用。" | [→](./reviews/grok-4-2026-04-21.md) |
| **Claude Opus 4.7** | "指纹重放声明有代码支持。" | [→](./reviews/claude-opus-4-7-2026-04-21.md) |
| **Gemini 2.0 Pro** | "技术精英，零依赖代理。" | [→](./reviews/gemini-2-pro-2026-04-21.md) |
| **GPT-5.3** | "有纪律的、有意的工程。不是氛围编码。" | [→](./reviews/gpt-5.3-2026-04-21.md) |

亮点：

> "这不是氛围编码；它读起来像碰巧是开源的生产级基础设施。" —— Grok 4
>
> "注释持续引用推动代码的 issue 编号 —— 这正是有实际用户的项目中的疤痕组织代码的样子。" —— Claude Opus 4.7
>
> "实现不只是简单的头部交换；它是复杂的请求级深度伪造。" —— Gemini 2.0 Pro
>
> "不是'尽力模仿'；它是对真实客户端的捕获和重放。" —— GPT-5.3

---

## 适用人群

**最适合：**

- 在多个工具中使用多个 LLM 的开发者，厌倦了管理基础 URL、密钥和按工具的提供商配置。
- Claude Pro / Max 订阅者，希望订阅可用于机器上的每个工具，而不仅仅是 Claude Code。
- 运行本地或托管 OpenAI 兼容服务器（LiteLLM、vLLM、Ollama、Groq、OpenRouter、自托管）的团队，希望一个稳定的本地端点供所有工具重用。
- [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 用户，希望在 SDK 下进行 OAuth 订阅路由。指向 `baseURL: 'http://localhost:3456'`，dario 将 API 密钥调用翻译为你的 Claude 订阅认证 —— 代理代码保持不变。
- 多代理工作负载的高级用户，希望在自己的机器上、针对自己的订阅进行多账户池化、会话粘性和进行中的 429 故障转移。

**不适合：**

- 你需要供应商管理的每个请求的生产 SLA。直接使用提供商 API。
- 你需要一个托管的、多租户的、管理的路由平台，带有仪表板、团队认证和支持合同。Dario 是本地单用户工具 —— [askalf 平台](https://askalf.org) 是团队/舰队用例的正确界面。
- 你想要聊天 UI。使用 claude.ai 或 chatgpt.com。

---

## 后端

Dario 的路由围绕**后端**组织。每个都是可交换的适配器 —— 添加一个，你的工具通过 `localhost:3456` 以它们已经使用的 API 格式访问它。可以运行零个、一个或所有后端同时运行。

### 1. OpenAI 兼容后端

任何支持 OpenAI Chat Completions API 的提供商。

```bash
dario backend add openai     --key=sk-proj-...
dario backend add groq       --key=gsk_...   --base-url=https://api.groq.com/openai/v1
dario backend add openrouter --key=sk-or-... --base-url=https://openrouter.ai/api/v1
dario backend add local      --key=anything  --base-url=http://127.0.0.1:4000/v1
```

凭据存储在 `~/.dario/backends/<name>.json`，权限 `0600`。正文原样转发，仅交换 `Authorization` 头部，流逐字节转发。使用模型字段上的[提供商前缀](./docs/usage.md#provider-prefix)强制指定后端。

### 2. Claude 订阅后端

OAuth 支持的 Claude Pro / Max 5x / Max 20x，按你的计划计费而不是 API。通过 `dario login` 激活（或 `dario login --manual` 用于 SSH / 容器设置，v3.20）。任何有 Claude Code 访问权限的层级都可以 —— 参见 [`docs/faq.md`](./docs/faq.md)。

每个出站 Claude 请求都被重建为匹配 Claude Code 本身会发出的请求 —— 系统提示、工具定义、身份头部、计费标签、beta 标志、头部插入顺序、静态头部值、`anthropic-beta` 标志集、顶级请求体键顺序 —— 使用从你实际安装的 CC 二进制文件中实时提取的模板，该模板在每次上游 CC 发布时自我修复。

关键机制简述：从你安装的 `claude` 二进制文件实时模板提取、漂移检测与不匹配时强制刷新、OAuth 配置自动检测（因此 dario 在下次运行时获取 Anthropic 端的轮换）、原子缓存写入、框架擦除（从系统提示中剥离第三方身份标记）、Bun 自动重启（因此 TLS ClientHello 匹配 CC 的运行时）。`dario proxy --passthrough` 做 OAuth 交换而不做其他任何事情 —— 当上游工具已经构建了 Claude Code 形状的请求时使用它。

这解决了什么：每请求保真度。它单独不能解决什么：累积的每 OAuth 会话聚合。v3.22 – v3.28 线保真度跟踪关闭了其中六个轴（正文顺序、TLS、节奏、流消耗、会话 ID 生命周期、MCP/子代理表面 —— 参见 [`docs/wire-fidelity.md`](./docs/wire-fidelity.md)）；对于剩余的，[池模式](./docs/multi-account-pool.md)跨多个订阅分配负载。

---

## 多账户池模式

当 `~/.dario/accounts/` 包含 2+ 个账户时，池模式自动激活。每个请求选择有最多余量的账户；多轮代理会话固定到一个账户，使 Anthropic 提示缓存得以保留；进行中的 429 在客户端看到错误之前在不同账户上重试。

```bash
dario accounts add work
dario accounts add personal
dario proxy
```

完整详情、余量计算、粘性键实现、检查端点：[`docs/multi-account-pool.md`](./docs/multi-account-pool.md)。

---

## Shim 模式（实验性）

将代理完全从网络上移除。`dario shim -- <child cmd>` 通过 `NODE_OPTIONS=--require` 在子进程中补丁 `globalThis.fetch`。无 localhost HTTP 跳跃。无需绑定端口。无 `BASE_URL`。

```bash
dario shim -- claude --print "hi"
```

子进程（及其派生的任何进程）看到一个假的 `fetch`，它拦截 Anthropic 调用并将它们路由到你的订阅 —— 对应用程序完全透明。

完整详情：[`docs/shim.md`](./docs/shim.md)。

---

## 系统提示控制

```bash
# 保留完整 CC 系统提示（默认）
dario proxy

# 移除 CC 行为约束（语气/风格/输出格式）
dario proxy --system-prompt=partial

# 完全移除系统提示
dario proxy --system-prompt=none
```

`partial` 模式移除 CC 的语气和风格/文本输出/详细程度/默认无评论的要点，在开放式工作上恢复约 1.2–2.8 倍的输出能力。有害内容的 RLHF 拒绝不受影响（对齐在权重中，不在提示中）。

完整详情：[`docs/system-prompt.md`](./docs/system-prompt.md)。

---

## MCP 服务器

```bash
# 将 dario 作为只读 MCP 服务器运行
dario mcp
```

Dario 可以作为 MCP（Model Context Protocol）服务器运行，允许 MCP 客户端查询其状态、配置和运行状况。

完整详情：[`docs/mcp-server.md`](./docs/mcp-server.md)。

---

## 子代理安装

```bash
# 在 Claude Code 中注册 dario 作为子代理
dario subagent install
```

这注册一个 CC 子代理用于会话内诊断，允许你在 Claude Code 会话中直接查询 dario 的状态。

完整详情：[`docs/sub-agent.md`](./docs/sub-agent.md)。

---

## 健康检查

```bash
# 打印可粘贴的健康报告
dario doctor
```

输出包括：
- 安装版本
- 登录状态
- 后端配置
- 代理状态
- 网络连接
- 常见问题诊断

提交 issue 时粘贴此输出。

---

## Docker

```bash
docker run -d \
  --name dario \
  -p 3456:3456 \
  -v ~/.dario:/home/node/.dario \
  ghcr.io/askalf/dario:latest
```

多架构镜像：`linux/amd64` + `linux/arm64`。

完整指南：[`docs/docker.md`](./docs/docker.md)。

---

## 许可证

MIT

---

> 项目地址：[askalf/dario](https://github.com/askalf/dario)
> npm 包：[@askalf/dario](https://www.npmjs.com/package/@askalf/dario)
