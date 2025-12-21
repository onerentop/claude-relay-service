# Gemini API 转换规范

> 本文档详细描述了本项目中 OpenAI 格式与 Google Gemini API 之间的完整转换逻辑，达到像素级精度。

## 目录

1. [核心文件索引](#核心文件索引)
2. [请求转换流程](#请求转换流程)
3. [请求参数映射](#请求参数映射)
4. [JSON Schema 清洗规则](#json-schema-清洗规则)
5. [响应格式转换](#响应格式转换)
6. [流式响应处理](#流式响应处理)
7. [认证方式](#认证方式)
8. [完整示例](#完整示例)

---

## 核心文件索引

| 文件路径 | 功能说明 | 关键行号 |
|---------|---------|---------|
| `src/transformer/gemini.transformer.ts` | 主转换器实现 | 全文 ~100 行 |
| `src/utils/gemini.util.ts` | 核心转换逻辑 | 全文 ~1100 行 |
| `src/transformer/vertex-gemini.transformer.ts` | Vertex AI 版本 | 全文 |
| `src/types/llm.ts` | 统一格式类型定义 | 全文 |

---

## 请求转换流程

```
客户端请求 (OpenAI/统一格式)
    │
    ▼
┌─────────────────────────────────────────┐
│ preHandler 中间件                        │
│ - 解析 model 字段: "gemini,modelName"    │
│ - 设置 req.provider = "gemini"           │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ transformRequestIn (gemini.transformer.ts) │
│ - 构建 URL                               │
│ - 设置认证 Header                        │
│ - 调用 buildRequestBody()               │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ buildRequestBody (gemini.util.ts)        │
│ - 转换 contents (消息)                   │
│ - 转换 tools (工具定义)                  │
│ - 设置 generationConfig                 │
│ - 设置 toolConfig                       │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ Gemini API                              │
│ - generateContent (非流式)              │
│ - streamGenerateContent?alt=sse (流式)  │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ transformResponseOut (gemini.util.ts)   │
│ - JSON: 直接解析转换                    │
│ - SSE: ReadableStream 逐行处理          │
└─────────────────────────────────────────┘
    │
    ▼
客户端响应 (OpenAI/统一格式)
```

---

## 请求参数映射

### 1. 消息格式转换

#### 1.1 角色映射

**代码位置**: `gemini.util.ts` 第 232-237 行

| 统一格式 | Gemini 格式 | 说明 |
|---------|-----------|------|
| `role: "user"` | `role: "user"` | 直接传递 |
| `role: "assistant"` | `role: "model"` | **角色名变化** |
| `role: "system"` | `role: "user"` | **降级为 user** |
| `role: "tool"` | `functionResponse` | 转换为函数响应 |

> **注意**: Gemini 官方推荐使用 `system_instruction` 字段处理系统提示，但本实现将其降级为 user 消息。

#### 1.2 内容块转换

**代码位置**: `gemini.util.ts` 第 243-295 行

##### 纯文本内容

| 统一格式 | Gemini 格式 |
|---------|-----------|
| `content: "Hello"` | `parts: [{ text: "Hello" }]` |
| `content: [{ type: "text", text: "Hello" }]` | `parts: [{ text: "Hello" }]` |

##### 图片内容 (HTTP URL)

**统一格式输入**:
```json
{
  "type": "image_url",
  "image_url": { "url": "https://example.com/image.jpg" },
  "media_type": "image/jpeg"
}
```

**Gemini 格式输出**:
```json
{
  "file_data": {
    "mime_type": "image/jpeg",
    "file_uri": "https://example.com/image.jpg"
  }
}
```

##### 图片内容 (Base64)

**统一格式输入**:
```json
{
  "type": "image_url",
  "image_url": { "url": "data:image/jpeg;base64,/9j/4AAQSkZJRg..." },
  "media_type": "image/jpeg"
}
```

**Gemini 格式输出**:
```json
{
  "inlineData": {
    "mime_type": "image/jpeg",
    "data": "/9j/4AAQSkZJRg..."
  }
}
```

**Base64 提取逻辑**:
```typescript
// 从 Data URI 提取纯 base64 数据
data: content.image_url.url?.split(",")?.pop() || content.image_url.url
// "data:image/jpeg;base64,ABC..." → "ABC..."
```

##### 思考签名

**统一格式输入**:
```json
{
  "role": "assistant",
  "content": "Response text",
  "thinking": {
    "signature": "sig_abc123"
  }
}
```

**Gemini 格式输出**:
```json
{
  "role": "model",
  "parts": [
    {
      "text": "Response text",
      "thoughtSignature": "sig_abc123"
    }
  ]
}
```

#### 1.3 工具调用转换

**代码位置**: `gemini.util.ts` 第 331-375 行

##### Assistant 发起的工具调用

**统一格式输入**:
```json
{
  "role": "assistant",
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "get_weather",
        "arguments": "{\"location\":\"SF\"}"
      }
    }
  ]
}
```

**Gemini 格式输出**:
```json
{
  "role": "model",
  "parts": [
    {
      "functionCall": {
        "id": "call_abc123",
        "name": "get_weather",
        "args": { "location": "SF" }
      }
    }
  ]
}
```

**字段映射表**:

| 统一格式字段 | Gemini 字段 | 转换逻辑 |
|------------|-----------|---------|
| `tool_calls[].id` | `functionCall.id` | 直接传递，如缺失自动生成 UUID |
| `tool_calls[].function.name` | `functionCall.name` | 直接传递 |
| `tool_calls[].function.arguments` (字符串) | `functionCall.args` (对象) | `JSON.parse()` |

##### 工具响应 (Tool Results)

**统一格式输入**:
```json
[
  {
    "role": "assistant",
    "tool_calls": [
      { "id": "call_abc", "function": { "name": "get_weather" } }
    ]
  },
  {
    "role": "tool",
    "tool_call_id": "call_abc",
    "content": "72°F, sunny"
  }
]
```

**Gemini 格式输出**:
```json
[
  {
    "role": "model",
    "parts": [
      { "functionCall": { "name": "get_weather", "args": {} } }
    ]
  },
  {
    "role": "user",
    "parts": [
      {
        "functionResponse": {
          "name": "get_weather",
          "response": { "result": "72°F, sunny" }
        }
      }
    ]
  }
]
```

> **注意**: 工具响应在 Gemini 中作为 `user` 角色的消息，内容包裹在 `{ result: ... }` 中。

---

### 2. 工具定义转换

**代码位置**: `gemini.util.ts` 第 154-206 行

#### 常规工具

**统一格式输入**:
```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather for a location",
        "parameters": {
          "type": "object",
          "properties": {
            "location": { "type": "string" }
          },
          "required": ["location"],
          "additionalProperties": false
        }
      }
    }
  ]
}
```

**Gemini 格式输出**:
```json
{
  "tools": [
    {
      "functionDeclarations": [
        {
          "name": "get_weather",
          "description": "Get weather for a location",
          "parametersJsonSchema": {
            "type": "OBJECT",
            "properties": {
              "location": { "type": "STRING" }
            },
            "required": ["location"]
          }
        }
      ]
    }
  ]
}
```

**字段映射表**:

| 统一格式字段 | Gemini 字段 |
|------------|-----------|
| `tools[].function.name` | `functionDeclarations[].name` |
| `tools[].function.description` | `functionDeclarations[].description` |
| `tools[].function.parameters` | `functionDeclarations[].parametersJsonSchema` |

#### 特殊工具: Web Search

**统一格式输入**:
```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "web_search",
        "description": "Search the web"
      }
    }
  ]
}
```

**Gemini 格式输出**:
```json
{
  "tools": [
    { "googleSearch": {} }
  ]
}
```

> 当工具名为 `web_search` 时，转换为 Gemini 原生的 `googleSearch` 工具。

---

## JSON Schema 清洗规则

**代码位置**: `gemini.util.ts` 第 44-151 行 (`tTool`, `processJsonSchema`, `cleanupParameters`)

Gemini API 对 JSON Schema 有严格限制，需要进行以下清洗:

### 1. 类型名称转换

| JSON Schema 类型 | Gemini 类型 |
|-----------------|------------|
| `"string"` | `"STRING"` |
| `"number"` | `"NUMBER"` |
| `"integer"` | `"INTEGER"` |
| `"boolean"` | `"BOOLEAN"` |
| `"array"` | `"ARRAY"` |
| `"object"` | `"OBJECT"` |
| `"null"` | 设置 `nullable: true` |

### 2. 联合类型处理

```typescript
// 输入: ["string", "null"]
// 输出: { type: "STRING", nullable: true }

// 输入: ["string", "number"]
// 输出: { anyOf: [{ type: "STRING" }, { type: "NUMBER" }] }
```

### 3. 字段白名单

**保留的字段**:
```
type, format, title, description, nullable, enum,
maxItems, minItems, properties, required, minProperties,
maxProperties, minLength, maxLength, pattern, example,
anyOf, propertyOrdering, default, items, minimum, maximum
```

**删除的字段**:
```
additionalProperties, $schema, 及其他自定义字段
```

### 4. Format 清洗

```typescript
// 仅当 type="string" 时保留以下 format:
const allowedFormats = ["enum", "date-time"];

// 其他 format 会被删除
// 例如: format: "uri" → 删除
```

### 5. Enum 限制

```typescript
// 仅当 type="string" 或 type="STRING" 时保留 enum
// 其他类型的 enum 会被删除
```

### 清洗示例

**输入**:
```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "format": "uri",
      "customField": "ignored"
    },
    "count": {
      "type": ["integer", "null"]
    },
    "tags": {
      "type": "array",
      "items": { "type": "string" },
      "enum": ["a", "b"]
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

**输出**:
```json
{
  "type": "OBJECT",
  "properties": {
    "name": {
      "type": "STRING"
    },
    "count": {
      "type": "INTEGER",
      "nullable": true
    },
    "tags": {
      "type": "ARRAY",
      "items": { "type": "STRING" }
    }
  }
}
```

---

### 3. 工具选择配置

**代码位置**: `gemini.util.ts` 第 415-435 行

| 统一格式 | Gemini 格式 |
|---------|-----------|
| `tool_choice: "auto"` | `functionCallingConfig: { mode: "AUTO" }` |
| `tool_choice: "none"` | `functionCallingConfig: { mode: "NONE" }` |
| `tool_choice: "required"` | `functionCallingConfig: { mode: "ANY" }` |
| `tool_choice: { function: { name: "fn" } }` | `functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["fn"] }` |

**完整格式**:
```json
{
  "toolConfig": {
    "functionCallingConfig": {
      "mode": "ANY",
      "allowedFunctionNames": ["get_weather"]
    }
  }
}
```

---

### 4. 思考/推理配置

**代码位置**: `gemini.util.ts` 第 380-413 行

#### Gemini 3 系列模型

| 统一格式 | Gemini 格式 |
|---------|-----------|
| `reasoning.effort: "low"` | `thinkingConfig: { includeThoughts: true, thinkingLevel: "low" }` |
| `reasoning.effort: "medium"` | `thinkingConfig: { includeThoughts: true, thinkingLevel: "medium" }` |
| `reasoning.effort: "high"` | `thinkingConfig: { includeThoughts: true, thinkingLevel: "high" }` |

#### 其他模型 (如 gemini-2.0-flash-thinking)

| 统一格式 | Gemini 格式 |
|---------|-----------|
| `reasoning.max_tokens: N` | `thinkingConfig: { includeThoughts: true, thinkingBudget: N }` |

**thinkingBudget 限制**:

| 模型类型 | 最小值 | 最大值 |
|---------|-------|-------|
| Pro 模型 (含 "pro") | 128 | 32768 |
| 其他模型 | 0 | 24576 |

**示例**:
```json
// 输入 (统一格式)
{
  "reasoning": {
    "effort": "medium",
    "max_tokens": 5000
  }
}

// 输出 (Gemini 格式) - gemini-3 模型
{
  "generationConfig": {
    "thinkingConfig": {
      "includeThoughts": true,
      "thinkingLevel": "medium"
    }
  }
}

// 输出 (Gemini 格式) - 其他模型
{
  "generationConfig": {
    "thinkingConfig": {
      "includeThoughts": true,
      "thinkingBudget": 5000
    }
  }
}
```

---

### 5. 其他请求参数

| 统一格式参数 | Gemini 参数 | 位置 |
|------------|-----------|------|
| `model` | URL 路径参数 | `/models/{model}:generateContent` |
| `max_tokens` | `generationConfig.maxOutputTokens` | - |
| `temperature` | `generationConfig.temperature` | - |
| `top_p` | `generationConfig.topP` | - |
| `top_k` | `generationConfig.topK` | - |
| `stop` | `generationConfig.stopSequences` | - |

---

## 响应格式转换

### 1. 非流式响应

**代码位置**: `gemini.util.ts` 第 509-607 行

#### Gemini 响应格式

```json
{
  "responseId": "resp_abc123",
  "candidates": [
    {
      "content": {
        "parts": [
          { "text": "Hello!", "thought": false },
          { "text": "Let me think...", "thought": true },
          { "thoughtSignature": "sig_xyz" },
          {
            "functionCall": {
              "id": "call_123",
              "name": "get_weather",
              "args": { "location": "SF" }
            }
          }
        ]
      },
      "finishReason": "STOP"
    }
  ],
  "usageMetadata": {
    "promptTokenCount": 100,
    "candidatesTokenCount": 50,
    "cachedContentTokenCount": 20,
    "thoughtsTokenCount": 30,
    "totalTokenCount": 180
  },
  "modelVersion": "gemini-2.0-flash"
}
```

#### 转换后 (统一格式)

```json
{
  "id": "resp_abc123",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "gemini-2.0-flash",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello!",
        "tool_calls": [
          {
            "id": "call_123",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"location\":\"SF\"}"
            }
          }
        ],
        "thinking": {
          "content": "Let me think...",
          "signature": "sig_xyz"
        }
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 50,
    "total_tokens": 180,
    "prompt_tokens_details": {
      "cached_tokens": 20
    },
    "output_tokens_details": {
      "reasoning_tokens": 30
    }
  }
}
```

#### 字段映射表

| Gemini 字段 | 统一格式字段 | 转换逻辑 |
|-----------|------------|---------|
| `responseId` | `id` | 直接传递 |
| `modelVersion` | `model` | 直接传递 |
| `candidates[0].content.parts[].text` (thought≠true) | `message.content` | 用 `\n` 连接 |
| `candidates[0].content.parts[].text` (thought=true) | `message.thinking.content` | 累加 |
| `candidates[0].content.parts[].thoughtSignature` | `message.thinking.signature` | 直接传递 |
| `candidates[0].content.parts[].functionCall` | `message.tool_calls[]` | args 转 JSON 字符串 |
| `candidates[0].finishReason` | `finish_reason` | 转小写 |
| `usageMetadata.promptTokenCount` | `usage.prompt_tokens` | 直接传递 |
| `usageMetadata.candidatesTokenCount` | `usage.completion_tokens` | 直接传递 |
| `usageMetadata.cachedContentTokenCount` | `usage.prompt_tokens_details.cached_tokens` | 直接传递 |
| `usageMetadata.thoughtsTokenCount` | `usage.output_tokens_details.reasoning_tokens` | 直接传递 |

#### finishReason 映射

| Gemini | 统一格式 |
|--------|---------|
| `STOP` | `stop` |
| `MAX_TOKENS` | `length` |
| `SAFETY` | `content_filter` |
| `RECITATION` | `content_filter` |
| `TOOL_CALLS` | `tool_calls` |
| 其他 | 小写转换 |

---

### 2. 引用/Grounding 处理

**代码位置**: `gemini.util.ts` 第 884-920 行

当使用 `googleSearch` 工具时，Gemini 会返回 grounding 元数据:

#### Gemini 格式

```json
{
  "groundingMetadata": {
    "groundingChunks": [
      {
        "web": {
          "uri": "https://example.com/article",
          "title": "Weather Report"
        }
      }
    ],
    "groundingSupports": [
      {
        "groundingChunkIndices": [0],
        "segment": {
          "text": "The weather is sunny",
          "startIndex": 0,
          "endIndex": 20
        }
      }
    ]
  }
}
```

#### 转换后 (统一格式)

```json
{
  "message": {
    "content": "...",
    "annotations": [
      {
        "type": "url_citation",
        "url_citation": {
          "url": "https://example.com/article",
          "title": "Weather Report",
          "content": "The weather is sunny",
          "start_index": 0,
          "end_index": 20
        }
      }
    ]
  }
}
```

---

## 流式响应处理

**代码位置**: `gemini.util.ts` 第 609-1066 行

### 核心状态管理

```typescript
let hasThinkingContent = false;    // 是否有思考内容
let signatureSent = false;         // 签名是否已发送
let contentSent = false;           // 内容是否已发送
let contentIndex = 0;              // 内容块索引
let toolCallIndex = -1;            // 工具调用索引
let pendingContent = "";           // 待发送的内容 (gemini-3 特殊处理)
```

### 事件处理流程

#### 1. 思考内容

**代码位置**: 第 745-769 行

```json
// 输入 (Gemini SSE)
data: {"candidates":[{"content":{"parts":[{"text":"Thinking...","thought":true}]}}]}

// 输出 (统一格式 SSE)
data: {
  "id": "resp_xxx",
  "object": "chat.completion.chunk",
  "choices": [{
    "index": 0,
    "delta": {
      "role": "assistant",
      "content": null,
      "thinking": {
        "content": "Thinking..."
      }
    },
    "finish_reason": null
  }]
}
```

#### 2. 思考签名

**代码位置**: 第 771-822 行

```json
// 输入 (Gemini SSE)
data: {"candidates":[{"content":{"parts":[{"thoughtSignature":"sig_abc"}]}}]}

// 输出 (统一格式 SSE)
data: {
  "choices": [{
    "delta": {
      "role": "assistant",
      "content": null,
      "thinking": {
        "signature": "sig_abc"
      }
    }
  }]
}
```

**gemini-3 特殊处理**:
- gemini-3 模型有真实的 `thoughtSignature`
- 其他模型需要生成虚拟签名: `ccr_{timestamp}`

#### 3. 文本内容

**代码位置**: 第 824-920 行

```json
// 输入 (Gemini SSE)
data: {"candidates":[{"content":{"parts":[{"text":"Hello!"}]}}]}

// 输出 (统一格式 SSE)
data: {
  "choices": [{
    "index": 1,
    "delta": {
      "role": "assistant",
      "content": "Hello!"
    },
    "finish_reason": null
  }]
}
```

#### 4. 工具调用

**代码位置**: 第 920-974 行

```json
// 输入 (Gemini SSE)
data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"location":"SF"}}}]}}]}

// 输出 (统一格式 SSE)
data: {
  "choices": [{
    "index": 2,
    "delta": {
      "role": "assistant",
      "tool_calls": [{
        "id": "ccr_tool_xxx",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"location\":\"SF\"}"
        },
        "index": 0
      }]
    }
  }],
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 50
  }
}
```

#### 5. 完成信号

```json
// 输入 (Gemini SSE)
data: {"candidates":[{"finishReason":"STOP"}]}

// 输出 (统一格式 SSE)
data: {
  "choices": [{
    "finish_reason": "stop"
  }]
}

data: [DONE]
```

### 完整流式事件序列

```
data: {"id":"resp_xxx","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","thinking":{"content":"Let me analyze..."}},"index":0}]}

data: {"id":"resp_xxx","object":"chat.completion.chunk","choices":[{"delta":{"thinking":{"signature":"sig_abc"}},"index":0}]}

data: {"id":"resp_xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"Based on my analysis..."},"index":1}]}

data: {"id":"resp_xxx","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"id":"call_123","type":"function","function":{"name":"search","arguments":"{\"q\":\"test\"}"},"index":0}]},"index":2}],"usage":{"prompt_tokens":100,"completion_tokens":50}}

data: {"id":"resp_xxx","object":"chat.completion.chunk","choices":[{"finish_reason":"tool_calls","index":2}]}

data: [DONE]
```

---

## 认证方式

### 标准版 (Google AI Studio)

**代码位置**: `gemini.transformer.ts` 第 14-35 行

**URL 格式**:
```
https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse
```

**认证 Header**:
```
x-goog-api-key: {apiKey}
```

### Vertex AI 版本

**代码位置**: `vertex-gemini.transformer.ts`

**URL 格式**:
```
https://{location}-aiplatform.googleapis.com/v1beta1/projects/{projectId}/locations/{location}/publishers/google/models/{model}:generateContent
```

**认证 Header**:
```
Authorization: Bearer {accessToken}
```

**Access Token 获取**:
```typescript
const { GoogleAuth } = await import('google-auth-library');
const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform']
});
const client = await auth.getClient();
const accessToken = await client.getAccessToken();
```

**环境变量**:

| 变量 | 说明 | 默认值 |
|-----|------|-------|
| `GOOGLE_CLOUD_PROJECT` | GCP 项目 ID | 从服务账户读取 |
| `GOOGLE_CLOUD_LOCATION` | 区域 | `us-central1` |
| `GOOGLE_APPLICATION_CREDENTIALS` | 服务账户密钥路径 | - |

---

## 完整示例

### 示例 1: 基本对话

**客户端请求 (统一格式)**:
```json
{
  "model": "gemini,gemini-2.0-flash",
  "max_tokens": 1024,
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello!" }
  ]
}
```

**转换后 (Gemini 格式)**:
```json
{
  "contents": [
    {
      "role": "user",
      "parts": [{ "text": "You are a helpful assistant." }]
    },
    {
      "role": "user",
      "parts": [{ "text": "Hello!" }]
    }
  ],
  "generationConfig": {
    "maxOutputTokens": 1024
  }
}
```

### 示例 2: 带工具调用

**客户端请求 (统一格式)**:
```json
{
  "model": "gemini,gemini-2.0-flash",
  "messages": [
    { "role": "user", "content": "What's the weather in SF?" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather for a location",
        "parameters": {
          "type": "object",
          "properties": {
            "location": { "type": "string" }
          },
          "required": ["location"]
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

**转换后 (Gemini 格式)**:
```json
{
  "contents": [
    {
      "role": "user",
      "parts": [{ "text": "What's the weather in SF?" }]
    }
  ],
  "tools": [
    {
      "functionDeclarations": [
        {
          "name": "get_weather",
          "description": "Get weather for a location",
          "parametersJsonSchema": {
            "type": "OBJECT",
            "properties": {
              "location": { "type": "STRING" }
            },
            "required": ["location"]
          }
        }
      ]
    }
  ],
  "toolConfig": {
    "functionCallingConfig": {
      "mode": "AUTO"
    }
  }
}
```

### 示例 3: 带图片

**客户端请求 (统一格式)**:
```json
{
  "model": "gemini,gemini-2.0-flash",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "What's in this image?" },
        {
          "type": "image_url",
          "image_url": { "url": "https://example.com/photo.jpg" },
          "media_type": "image/jpeg"
        }
      ]
    }
  ]
}
```

**转换后 (Gemini 格式)**:
```json
{
  "contents": [
    {
      "role": "user",
      "parts": [
        { "text": "What's in this image?" },
        {
          "file_data": {
            "mime_type": "image/jpeg",
            "file_uri": "https://example.com/photo.jpg"
          }
        }
      ]
    }
  ]
}
```

### 示例 4: 带 Web 搜索

**客户端请求 (统一格式)**:
```json
{
  "model": "gemini,gemini-2.0-flash",
  "messages": [
    { "role": "user", "content": "What's the latest news about AI?" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "web_search",
        "description": "Search the web"
      }
    }
  ]
}
```

**转换后 (Gemini 格式)**:
```json
{
  "contents": [
    {
      "role": "user",
      "parts": [{ "text": "What's the latest news about AI?" }]
    }
  ],
  "tools": [
    { "googleSearch": {} }
  ]
}
```

### 示例 5: 带思考模式

**客户端请求 (统一格式)**:
```json
{
  "model": "gemini,gemini-2.0-flash-thinking",
  "messages": [
    { "role": "user", "content": "Solve this complex math problem..." }
  ],
  "reasoning": {
    "effort": "high",
    "max_tokens": 10000
  }
}
```

**转换后 (Gemini 格式)**:
```json
{
  "contents": [
    {
      "role": "user",
      "parts": [{ "text": "Solve this complex math problem..." }]
    }
  ],
  "generationConfig": {
    "thinkingConfig": {
      "includeThoughts": true,
      "thinkingBudget": 10000
    }
  }
}
```

### 示例 6: 工具响应

**客户端请求 (统一格式)**:
```json
{
  "model": "gemini,gemini-2.0-flash",
  "messages": [
    { "role": "user", "content": "What's the weather in SF?" },
    {
      "role": "assistant",
      "content": "",
      "tool_calls": [
        {
          "id": "call_abc123",
          "type": "function",
          "function": {
            "name": "get_weather",
            "arguments": "{\"location\":\"SF\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_abc123",
      "content": "72°F, sunny"
    }
  ]
}
```

**转换后 (Gemini 格式)**:
```json
{
  "contents": [
    {
      "role": "user",
      "parts": [{ "text": "What's the weather in SF?" }]
    },
    {
      "role": "model",
      "parts": [
        {
          "functionCall": {
            "id": "call_abc123",
            "name": "get_weather",
            "args": { "location": "SF" }
          }
        }
      ]
    },
    {
      "role": "user",
      "parts": [
        {
          "functionResponse": {
            "name": "get_weather",
            "response": { "result": "72°F, sunny" }
          }
        }
      ]
    }
  ]
}
```

---

## 已知限制

| 问题 | 说明 | 影响 |
|-----|------|------|
| System Prompt 降级 | system 角色被转为 user | 可能影响系统指令效果 |
| additionalProperties 删除 | Schema 清洗时删除 | 可能丢失对象约束 |
| 工具响应包裹 | content 被包在 `{ result: ... }` 中 | 需确保下游兼容 |
| 虚拟签名 | 非 gemini-3 模型生成 `ccr_` 签名 | 可能与真实签名混淆 |
| Format 清洗 | 非标准 format 被删除 | 可能丢失格式约束 |

---

## 调试技巧

### 查看请求体

在 `gemini.util.ts` 的 `buildRequestBody` 函数末尾添加日志:
```typescript
console.log('Gemini Request:', JSON.stringify(body, null, 2));
```

### 查看响应转换

在 `transformResponseOut` 函数中添加日志:
```typescript
console.log('Gemini Response:', JSON.stringify(jsonResponse, null, 2));
console.log('Unified Response:', JSON.stringify(res, null, 2));
```

---

*文档生成时间: 2024-12*
*基于代码版本: v1.0.51*
