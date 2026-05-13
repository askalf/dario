<p align="center">
  <h1 align="center">dario</h1>
  <p align="center"><strong>将你的 Claude Pro/Max 订阅与 Cursor、Aider、Cline、Zed、Codex CLI、Claude Agent SDK —— 任何支持 OpenAI API 格式的工具一起使用。</strong></p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dario"><img src="https://img.shields.io/npm/v/dario" alt="npm version"></a>
  <a href="https://github.com/askalf/dario/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
</p>

---

## 什么是 dario？

dario 是一个本地 LLM 路由器。它为你提供一个兼容 OpenAI 的 API 端点，可以将请求路由到 Claude Max/Pro、OpenAI 或任何其他 LLM 提供商。

## 为什么使用 dario？

- **统一接口**：一个端点，多个 LLM 提供商
- **本地运行**：数据不经过第三方服务器
- **兼容 OpenAI API**：适用于任何支持 OpenAI 格式的工具
- **支持 Claude Pro/Max**：通过你的订阅使用 Claude
- **支持多种工具**：Cursor、Aider、Cline、Zed、Codex CLI 等

## 快速开始

### 安装

```bash
npm install -g dario
```

### 配置

创建配置文件 `~/.dario/config.json`：

```json
{
  "providers": {
    "anthropic": {
      "type": "anthropic",
      "apiKey": "your-api-key"
    },
    "openai": {
      "type": "openai",
      "apiKey": "your-api-key"
    }
  },
  "routes": {
    "default": "anthropic"
  }
}
```

### 启动

```bash
dario start
```

服务将在 `http://localhost:3000` 启动。

### 使用

在你的工具中配置 OpenAI API：

```
API Base URL: http://localhost:3000/v1
API Key: your-dario-key
```

## 支持的工具

| 工具 | 配置方式 |
|------|----------|
| Cursor | 设置 → API → OpenAI API Base URL |
| Aider | `--openai-api-base http://localhost:3000/v1` |
| Cline | 设置 API Provider 为 OpenAI Compatible |
| Zed | 配置 assistant provider |
| Codex CLI | `--api-base http://localhost:3000/v1` |
| Claude Agent SDK | 环境变量配置 |

## 环境变量

```bash
# Anthropic API Key
export ANTHROPIC_API_KEY=your-key

# OpenAI API Key
export OPENAI_API_KEY=your-key

# dario 端口
export DARIO_PORT=3000
```

## 高级用法

### 自定义路由

```json
{
  "routes": {
    "default": "anthropic",
    "code": "openai",
    "chat": "anthropic"
  }
}
```

### 负载均衡

```json
{
  "providers": {
    "anthropic-1": {
      "type": "anthropic",
      "apiKey": "key-1"
    },
    "anthropic-2": {
      "type": "anthropic",
      "apiKey": "key-2"
    }
  },
  "loadBalancing": {
    "strategy": "round-robin"
  }
}
```

## 常见问题

### 如何获取 Claude API Key？

1. 访问 [Anthropic Console](https://console.anthropic.com/)
2. 创建账户或登录
3. 在 API Keys 页面创建新密钥

### 如何获取 OpenAI API Key？

1. 访问 [OpenAI Platform](https://platform.openai.com/)
2. 创建账户或登录
3. 在 API Keys 页面创建新密钥

## 许可证

MIT

---

> 项目地址：[askalf/dario](https://github.com/askalf/dario)
> npm 包：[dario](https://www.npmjs.com/package/dario)
