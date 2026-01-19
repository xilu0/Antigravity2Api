# ThoughtSignature: Claude API vs Gemini API 差异

本文档描述 Claude API 和 Gemini API (v1internal) 在 thinking/signature 处理上的差异，以及 Antigravity2Api 如何进行转换兼容。

## 概述

当模型启用 extended thinking（思考模式）并使用工具调用时，Gemini API 要求在后续请求中回传 `thoughtSignature`。由于 Claude API 和 Gemini API 对签名的处理方式不同，代理需要进行转换和缓存。

## API 差异对比

| 方面 | Gemini API (v1internal) | Claude API |
|------|------------------------|------------|
| **签名字段位置** | `thoughtSignature` 字段直接在 `functionCall` part 上 | `signature` 在单独的 `thinking` block 中 |
| **tool_use 签名** | `functionCall.thoughtSignature` | `tool_use` 块没有 `signature` 字段（非标准） |
| **签名回传要求** | 必须在下一轮请求中原样回传到对应的 `functionCall` part | Claude Code 通常不会回传 `tool_use.signature` |
| **签名载体** | 直接附着在 `functionCall` part | 通过 `thinking` block 的 `signature` 字段间接传递 |

## Gemini API 签名规范

根据 Gemini API 官方文档：

1. 当模型响应包含 `thoughtSignature` 时，下一轮请求必须原样回传
2. 签名必须附着在对应的 `functionCall` part 上
3. 签名不应附着在 `thought: true` 的 thinking part 上
4. 缺少必需的签名会导致 `400 Bad Request`

**Gemini 响应示例：**
```json
{
  "candidates": [{
    "content": {
      "parts": [
        { "text": "Let me think...", "thought": true },
        {
          "functionCall": {
            "name": "get_weather",
            "args": { "location": "Tokyo" },
            "id": "toolu_123"
          },
          "thoughtSignature": "base64-encoded-signature..."
        }
      ]
    }
  }]
}
```

**Gemini 请求示例（下一轮）：**
```json
{
  "contents": [{
    "role": "model",
    "parts": [
      { "text": "Let me think...", "thought": true },
      {
        "functionCall": {
          "name": "get_weather",
          "args": { "location": "Tokyo" },
          "id": "toolu_123"
        },
        "thoughtSignature": "base64-encoded-signature..."
      }
    ]
  }, {
    "role": "user",
    "parts": [{
      "functionResponse": {
        "name": "get_weather",
        "response": { "result": "Sunny, 25°C" },
        "id": "toolu_123"
      }
    }]
  }]
}
```

## Claude API 签名规范

Claude API 使用不同的结构：

1. `thinking` block 是独立的内容块，包含 `thinking` 文本和可选的 `signature`
2. `tool_use` block 不包含标准的 `signature` 字段
3. 签名通过 `thinking.signature` 与后续的 `tool_use` 关联

**Claude 响应示例：**
```json
{
  "content": [
    {
      "type": "thinking",
      "thinking": "Let me think about this...",
      "signature": "base64-encoded-signature..."
    },
    {
      "type": "tool_use",
      "id": "toolu_123",
      "name": "get_weather",
      "input": { "location": "Tokyo" }
    }
  ]
}
```

**Claude 请求示例（下一轮，包含历史）：**
```json
{
  "messages": [
    {
      "role": "assistant",
      "content": [
        {
          "type": "thinking",
          "thinking": "Let me think about this...",
          "signature": "base64-encoded-signature..."
        },
        {
          "type": "tool_use",
          "id": "toolu_123",
          "name": "get_weather",
          "input": { "location": "Tokyo" }
        }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_123",
          "content": "Sunny, 25°C"
        }
      ]
    }
  ]
}
```

## Antigravity2Api 转换策略

### 响应转换 (Gemini → Claude)

1. **签名缓存**：当收到 Gemini 响应中的 `functionCall.thoughtSignature` 时，使用 `rememberToolThoughtSignature(toolId, signature)` 缓存到本地
2. **签名输出**：将签名转换为 Claude 的 `thinking.signature_delta` 事件（流式）或 `thinking.signature` 字段（非流式）
3. **工具调用**：`tool_use` block 不包含 signature 字段

### 请求转换 (Claude → Gemini)

1. **签名来源优先级**：
   - 优先：`tool_use.signature`（如果客户端显式回传）
   - 次选：`thinking.signature`（紧邻的 thinking block 中的签名）
   - 兜底：本地缓存 `getToolThoughtSignature(toolId)`

2. **签名附着**：将获取到的签名附着到对应的 `functionCall.thoughtSignature`

3. **缓存管理**：
   - 缓存有 21 天 TTL
   - 每小时清理过期条目
   - 持久化到磁盘以支持进程重启

### 关键代码位置

| 功能 | 文件 | 说明 |
|------|------|------|
| 签名缓存存储 | `ToolThoughtSignatureStore.js` | Map + 磁盘持久化 |
| 请求转换 | `ClaudeRequestIn.js:290-330` | 签名获取和附着逻辑 |
| 流式响应转换 | `ClaudeResponseStreaming.js:370-394` | functionCall 签名缓存 |
| 非流式响应转换 | `ClaudeResponseNonStreaming.js:118-122` | functionCall 签名缓存 |

## 潜在问题和注意事项

### 签名丢失场景

当以下条件同时满足时，可能导致签名丢失：

1. Claude Code 在某次请求中回传了 `thinking.signature`
2. 代理将签名应用到请求并删除了本地缓存
3. 后续请求中 Claude Code 不再回传同一 `tool_use.id` 的签名
4. 本地缓存已被删除，无法恢复

### shouldForwardThoughtSignatures 标志

- 当请求启用 thinking 时为 `true`
- 当请求禁用 thinking 时为 `false`，签名不会被转发
- 这是有意设计，避免在禁用 thinking 时发送不必要的签名导致上游报错

## 相关配置

无需额外配置。签名处理在启用 thinking 时自动生效。

签名缓存文件位置：`src/transform/claude/tool_thought_signatures.json`