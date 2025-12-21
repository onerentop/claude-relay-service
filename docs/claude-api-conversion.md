# Claude (Anthropic) API 转换规范

> 本文档详细描述了本项目中 OpenAI 格式与 Anthropic Claude API 之间的完整转换逻辑，达到像素级精度。

## 目录

1. [核心文件索引](#核心文件索引)
2. [请求转换流程](#请求转换流程)
3. [请求参数映射](#请求参数映射)
4. [响应格式转换](#响应格式转换)
5. [流式响应处理](#流式响应处理)
6. [认证方式](#认证方式)
7. [完整示例](#完整示例)

---

## 核心文件索引

| 文件路径 | 功能说明 | 关键行号 |
|---------|---------|---------|
| `src/transformer/anthropic.transformer.ts` | 主转换器实现 | 全文 ~1000 行 |
| `src/transformer/vertex-claude.transformer.ts` | Vertex AI 版本 | 全文 |
| `src/utils/vertex-claude.util.ts` | Vertex AI 工具函数 | 全文 |
| `src/utils/image.ts` | 图片格式化工具 | 1-7 行 |
| `src/utils/toolArgumentsParser.ts` | 工具参数解析 | 全文 |
| `src/types/llm.ts` | 统一格式类型定义 | 全文 |

---

## 请求转换流程

```
客户端请求 (OpenAI 格式)
    │
    ▼
┌─────────────────────────────────────────┐
│ preHandler 中间件 (server.ts:123-138)   │
│ - 解析 model 字段: "provider,modelName" │
│ - 设置 req.provider = provider          │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ transformRequestOut (第 31-186 行)      │
│ - Anthropic 原生格式 → 统一格式          │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ auth() (第 20-34 行)                    │
│ - 设置认证 Headers                       │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ sendUnifiedRequest                       │
│ - 发送 HTTP 请求到 Anthropic API         │
└─────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────┐
│ transformResponseIn (第 188-220 行)     │
│ - 统一格式 → Anthropic 原生格式          │
│ - 非流式: convertOpenAIResponseToAnthropic │
│ - 流式: convertOpenAIStreamToAnthropic  │
└─────────────────────────────────────────┘
    │
    ▼
客户端响应 (Anthropic 格式)
```

---

## 请求参数映射

### 1. 消息格式转换

#### 1.1 角色映射

| OpenAI/统一格式 | Anthropic 格式 | 处理逻辑 |
|----------------|---------------|---------|
| `role: "user"` | `role: "user"` | 直接传递 |
| `role: "assistant"` | `role: "assistant"` | 直接传递 |
| `role: "system"` | 独立 `system` 字段 | 提取到顶层 |
| `role: "tool"` | 用户消息中的 `tool_result` 块 | 转换为内容块 |

#### 1.2 System 消息处理

**代码位置**: `anthropic.transformer.ts` 第 48-61 行

```typescript
// 情况 A: 字符串格式
if (typeof request.system === "string") {
  messages.push({ role: "system", content: request.system });
}

// 情况 B: 数组格式 (支持缓存控制)
if (Array.isArray(request.system) && request.system.length) {
  const textParts = request.system
    .filter((item) => item.type === "text" && item.text)
    .map((item) => ({
      type: "text",
      text: item.text,
      cache_control: item.cache_control,  // 保留缓存控制
    }));
  messages.push({ role: "system", content: textParts });
}
```

**Anthropic 输入格式**:
```json
{
  "system": "You are a helpful assistant",
  // 或
  "system": [
    {
      "type": "text",
      "text": "You are a helpful assistant",
      "cache_control": { "type": "ephemeral" }
    }
  ]
}
```

**转换后 (统一格式)**:
```json
{
  "messages": [
    { "role": "system", "content": "You are a helpful assistant" }
  ]
}
```

#### 1.3 User 消息处理

**代码位置**: `anthropic.transformer.ts` 第 82-119 行

##### 纯文本内容

| Anthropic 输入 | 统一格式输出 |
|---------------|-------------|
| `content: "Hello"` | `content: "Hello"` |
| `content: [{ type: "text", text: "Hello" }]` | `content: "Hello"` |

##### 工具结果块

**Anthropic 输入**:
```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "tool_abc123",
      "content": "Result data",
      "cache_control": { "type": "ephemeral" }
    }
  ]
}
```

**统一格式输出**:
```json
{
  "role": "tool",
  "content": "Result data",
  "tool_call_id": "tool_abc123",
  "cache_control": { "type": "ephemeral" }
}
```

##### 图片内容

**代码位置**: `anthropic.transformer.ts` 第 95-112 行

| Anthropic 输入 | 统一格式输出 |
|---------------|-------------|
| `{ type: "image", source: { type: "base64", data: "...", media_type: "image/jpeg" } }` | `{ type: "image_url", image_url: { url: "data:image/jpeg;base64,..." }, media_type: "image/jpeg" }` |
| `{ type: "image", source: { type: "url", url: "https://..." } }` | `{ type: "image_url", image_url: { url: "https://..." }, media_type: "..." }` |

**图片 Data URI 格式化** (`src/utils/image.ts`):
```typescript
export const formatBase64 = (data: string, media_type: string) => {
  // 移除已有的 base64 前缀
  if (data.includes("base64")) {
    data = data.split("base64").pop() as string;
    if (data.startsWith(",")) {
      data = data.slice(1);
    }
  }
  return `data:${media_type};base64,${data}`;
};
```

#### 1.4 Assistant 消息处理

**代码位置**: `anthropic.transformer.ts` 第 120-163 行

##### 文本块

```json
// Anthropic 输入
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Hello" },
    { "type": "text", "text": "World" }
  ]
}

// 统一格式输出
{
  "role": "assistant",
  "content": "Hello\nWorld"  // 用换行符连接
}
```

##### 工具调用块

**Anthropic 输入**:
```json
{
  "role": "assistant",
  "content": [
    {
      "type": "tool_use",
      "id": "tool_abc123",
      "name": "get_weather",
      "input": { "location": "San Francisco" }
    }
  ]
}
```

**统一格式输出**:
```json
{
  "role": "assistant",
  "content": "",
  "tool_calls": [
    {
      "id": "tool_abc123",
      "type": "function",
      "function": {
        "name": "get_weather",
        "arguments": "{\"location\":\"San Francisco\"}"
      }
    }
  ]
}
```

**字段映射表**:

| Anthropic 字段 | 统一格式字段 | 转换逻辑 |
|---------------|------------|---------|
| `tool_use.id` | `tool_calls[].id` | 直接传递 |
| `tool_use.name` | `tool_calls[].function.name` | 直接传递 |
| `tool_use.input` (对象) | `tool_calls[].function.arguments` (字符串) | `JSON.stringify()` |

##### 思考块 (Extended Thinking)

**Anthropic 输入**:
```json
{
  "role": "assistant",
  "content": [
    {
      "type": "thinking",
      "thinking": "Let me think about this...",
      "signature": "sig_abc123"
    }
  ]
}
```

**统一格式输出**:
```json
{
  "role": "assistant",
  "thinking": {
    "content": "Let me think about this...",
    "signature": "sig_abc123"
  }
}
```

---

### 2. 工具定义转换

**代码位置**: `anthropic.transformer.ts` 第 216-220 行

**Anthropic 输入**:
```json
{
  "tools": [
    {
      "name": "get_weather",
      "description": "Get weather information",
      "input_schema": {
        "type": "object",
        "properties": {
          "location": { "type": "string" }
        },
        "required": ["location"]
      }
    }
  ]
}
```

**统一格式输出**:
```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather information",
        "parameters": {
          "type": "object",
          "properties": {
            "location": { "type": "string" }
          },
          "required": ["location"]
        }
      }
    }
  ]
}
```

**字段映射表**:

| Anthropic 字段 | 统一格式字段 |
|---------------|------------|
| `tools[].name` | `tools[].function.name` |
| `tools[].description` | `tools[].function.description` |
| `tools[].input_schema` | `tools[].function.parameters` |

---

### 3. 工具选择配置

**代码位置**: `anthropic.transformer.ts` 第 178-186 行

| Anthropic 输入 | 统一格式输出 |
|---------------|------------|
| `tool_choice: { type: "auto" }` | `tool_choice: "auto"` |
| `tool_choice: { type: "none" }` | `tool_choice: "none"` |
| `tool_choice: { type: "any" }` | `tool_choice: "required"` |
| `tool_choice: { type: "tool", name: "fn" }` | `tool_choice: { type: "function", function: { name: "fn" } }` |

---

### 4. 思考/推理配置

**代码位置**: `anthropic.transformer.ts` 第 168-177 行

**Anthropic 输入**:
```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 5000
  }
}
```

**统一格式输出**:
```json
{
  "reasoning": {
    "effort": "medium",
    "enabled": true
  }
}
```

**budget_tokens 到 effort 映射** (`src/utils/thinking.ts`):

| budget_tokens 范围 | effort 值 |
|-------------------|----------|
| 0 | `"none"` |
| 1 - 1024 | `"low"` |
| 1025 - 8192 | `"medium"` |
| > 8192 | `"high"` |

---

### 5. 其他请求参数

| Anthropic 参数 | 统一格式参数 | 说明 |
|---------------|------------|------|
| `model` | `model` | 直接传递 |
| `max_tokens` | `max_tokens` | 直接传递 |
| `temperature` | `temperature` | 直接传递 |
| `stream` | `stream` | 直接传递 |
| `top_p` | `top_p` | 直接传递 |
| `top_k` | `top_k` | 直接传递 (Anthropic 特有) |
| `stop_sequences` | `stop` | 字段名变化 |

---

## 响应格式转换

### 1. 非流式响应

**代码位置**: `anthropic.transformer.ts` 第 627-756 行 (`convertOpenAIResponseToAnthropic`)

#### 输入 (统一/OpenAI 格式)

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "claude-3-5-sonnet-20241022",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you?",
        "tool_calls": [
          {
            "id": "call_abc123",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"location\":\"SF\"}"
            }
          }
        ],
        "thinking": {
          "content": "User is asking about weather...",
          "signature": "sig_xyz789"
        },
        "annotations": [
          {
            "url_citation": {
              "url": "https://example.com",
              "title": "Source"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ],
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 50,
    "prompt_tokens_details": {
      "cached_tokens": 20
    }
  }
}
```

#### 输出 (Anthropic 格式)

```json
{
  "id": "chatcmpl-abc123",
  "type": "message",
  "role": "assistant",
  "model": "claude-3-5-sonnet-20241022",
  "content": [
    {
      "type": "server_tool_use",
      "id": "srvtoolu_xxx",
      "name": "web_search",
      "input": { "query": "" }
    },
    {
      "type": "web_search_tool_result",
      "tool_use_id": "srvtoolu_xxx",
      "content": [
        {
          "type": "web_search_result",
          "url": "https://example.com",
          "title": "Source"
        }
      ]
    },
    {
      "type": "text",
      "text": "Hello! How can I help you?"
    },
    {
      "type": "tool_use",
      "id": "call_abc123",
      "name": "get_weather",
      "input": { "location": "SF" }
    },
    {
      "type": "thinking",
      "thinking": "User is asking about weather...",
      "signature": "sig_xyz789"
    }
  ],
  "stop_reason": "tool_use",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 80,
    "output_tokens": 50,
    "cache_read_input_tokens": 20
  }
}
```

#### 字段映射表

| 统一格式字段 | Anthropic 字段 | 转换逻辑 |
|------------|---------------|---------|
| `id` | `id` | 直接传递 |
| `model` | `model` | 直接传递 |
| `choices[0].message.content` | `content[].type: "text"` | 包装为文本块 |
| `choices[0].message.tool_calls[]` | `content[].type: "tool_use"` | 转换工具调用 |
| `choices[0].message.thinking` | `content[].type: "thinking"` | 转换思考内容 |
| `choices[0].message.annotations` | `content[].type: "web_search_tool_result"` | 转换网络搜索结果 |
| `choices[0].finish_reason` | `stop_reason` | 见下表 |
| `usage.prompt_tokens` | `usage.input_tokens` | 减去缓存 token |
| `usage.completion_tokens` | `usage.output_tokens` | 直接传递 |
| `usage.prompt_tokens_details.cached_tokens` | `usage.cache_read_input_tokens` | 直接传递 |

#### finish_reason 到 stop_reason 映射

| 统一格式 finish_reason | Anthropic stop_reason |
|----------------------|----------------------|
| `"stop"` | `"end_turn"` |
| `"length"` | `"max_tokens"` |
| `"tool_calls"` | `"tool_use"` |
| `"content_filter"` | `"stop_sequence"` |
| 其他 | `"end_turn"` |

#### 工具调用转换

```typescript
// 输入 (统一格式)
{
  "id": "call_abc123",
  "type": "function",
  "function": {
    "name": "get_weather",
    "arguments": "{\"location\":\"SF\"}"  // JSON 字符串
  }
}

// 输出 (Anthropic 格式)
{
  "type": "tool_use",
  "id": "call_abc123",
  "name": "get_weather",
  "input": { "location": "SF" }  // 已解析的对象
}
```

**解析逻辑** (第 676-692 行):
```typescript
let parsedInput = {};
try {
  const argumentsStr = toolCall.function.arguments || "{}";
  parsedInput = typeof argumentsStr === "string"
    ? JSON.parse(argumentsStr)
    : argumentsStr;
} catch {
  // 解析失败时包装为 text 字段
  parsedInput = { text: toolCall.function.arguments || "" };
}
```

---

## 流式响应处理

**代码位置**: `anthropic.transformer.ts` 第 223-626 行 (`convertOpenAIStreamToAnthropic`)

### 核心状态管理

```typescript
let isThinkingStarted = false;      // 思考块是否已开始
let hasTextContentStarted = false;  // 文本块是否已开始
let contentIndex = 0;               // 全局内容块索引
let currentContentBlockIndex = -1;  // 当前活跃块索引
let isClosed = false;               // 流是否已关闭
let hasFinished = false;            // 是否已收到完成信号
const toolCallIndexToContentBlockIndex = new Map<number, number>();  // 工具调用索引映射
const toolCalls = new Map<number, any>();  // 工具调用累积器
```

### 事件序列

#### 1. 流开始 (message_start)

**代码位置**: 第 271-289 行

```
event: message_start
data: {
  "type": "message_start",
  "message": {
    "id": "msg_xxx",
    "type": "message",
    "role": "assistant",
    "content": [],
    "model": "claude-3-5-sonnet-20241022",
    "stop_reason": null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 100,
      "output_tokens": 0
    }
  }
}
```

#### 2. 思考内容块

**代码位置**: 第 326-375 行

##### 2.1 思考块开始

```
event: content_block_start
data: {
  "type": "content_block_start",
  "index": 0,
  "content_block": {
    "type": "thinking",
    "thinking": ""
  }
}
```

##### 2.2 思考内容增量

```
event: content_block_delta
data: {
  "type": "content_block_delta",
  "index": 0,
  "delta": {
    "type": "thinking_delta",
    "thinking": "Let me think about this..."
  }
}
```

##### 2.3 思考签名

```
event: content_block_delta
data: {
  "type": "content_block_delta",
  "index": 0,
  "delta": {
    "type": "signature_delta",
    "signature": "sig_abc123"
  }
}
```

##### 2.4 思考块结束

```
event: content_block_stop
data: {
  "type": "content_block_stop",
  "index": 0
}
```

#### 3. 文本内容块

**代码位置**: 第 376-435 行

##### 3.1 文本块开始

```
event: content_block_start
data: {
  "type": "content_block_start",
  "index": 1,
  "content_block": {
    "type": "text",
    "text": ""
  }
}
```

##### 3.2 文本增量

```
event: content_block_delta
data: {
  "type": "content_block_delta",
  "index": 1,
  "delta": {
    "type": "text_delta",
    "text": "Hello"
  }
}
```

##### 3.3 文本块结束

```
event: content_block_stop
data: {
  "type": "content_block_stop",
  "index": 1
}
```

#### 4. 工具调用块

**代码位置**: 第 486-588 行

##### 4.1 工具块开始

```
event: content_block_start
data: {
  "type": "content_block_start",
  "index": 2,
  "content_block": {
    "type": "tool_use",
    "id": "call_abc123",
    "name": "get_weather",
    "input": {}
  }
}
```

##### 4.2 工具参数增量

```
event: content_block_delta
data: {
  "type": "content_block_delta",
  "index": 2,
  "delta": {
    "type": "input_json_delta",
    "partial_json": "{\"location\":"
  }
}

event: content_block_delta
data: {
  "type": "content_block_delta",
  "index": 2,
  "delta": {
    "type": "input_json_delta",
    "partial_json": "\"SF\"}"
  }
}
```

##### 4.3 工具块结束

```
event: content_block_stop
data: {
  "type": "content_block_stop",
  "index": 2
}
```

#### 5. 消息完成

**代码位置**: 第 589-620 行

##### 5.1 消息增量 (包含 usage)

```
event: message_delta
data: {
  "type": "message_delta",
  "delta": {
    "stop_reason": "end_turn",
    "stop_sequence": null
  },
  "usage": {
    "input_tokens": 80,
    "output_tokens": 50,
    "cache_read_input_tokens": 20
  }
}
```

##### 5.2 消息结束

```
event: message_stop
data: {
  "type": "message_stop"
}
```

### 完整流式事件序列示例

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":100,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me analyze..."}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_abc"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello!"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: content_block_start
data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call_123","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"location\":\"SF\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":2}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":80,"output_tokens":50,"cache_read_input_tokens":20}}

event: message_stop
data: {"type":"message_stop"}
```

---

## 认证方式

**代码位置**: `anthropic.transformer.ts` 第 20-34 行

### API Key 模式 (默认)

```typescript
headers["x-api-key"] = provider.apiKey;
```

**请求 Header**:
```
x-api-key: sk-ant-xxx
```

### Bearer Token 模式

```typescript
// 通过 options.UseBearer = true 启用
headers["authorization"] = `Bearer ${provider.apiKey}`;
```

**请求 Header**:
```
Authorization: Bearer sk-ant-xxx
```

---

## 完整示例

### 示例 1: 基本对话

**客户端请求 (Anthropic 格式)**:
```json
{
  "model": "claude-3-5-sonnet-20241022",
  "max_tokens": 1024,
  "system": "You are a helpful assistant.",
  "messages": [
    {
      "role": "user",
      "content": "Hello!"
    }
  ]
}
```

**转换后 (统一格式)**:
```json
{
  "model": "claude-3-5-sonnet-20241022",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant."
    },
    {
      "role": "user",
      "content": "Hello!"
    }
  ]
}
```

### 示例 2: 带工具调用

**客户端请求 (Anthropic 格式)**:
```json
{
  "model": "claude-3-5-sonnet-20241022",
  "max_tokens": 1024,
  "tools": [
    {
      "name": "get_weather",
      "description": "Get weather for a location",
      "input_schema": {
        "type": "object",
        "properties": {
          "location": { "type": "string" }
        },
        "required": ["location"]
      }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": "What's the weather in SF?"
    }
  ]
}
```

**转换后 (统一格式)**:
```json
{
  "model": "claude-3-5-sonnet-20241022",
  "max_tokens": 1024,
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
  "messages": [
    {
      "role": "user",
      "content": "What's the weather in SF?"
    }
  ]
}
```

### 示例 3: 带图片

**客户端请求 (Anthropic 格式)**:
```json
{
  "model": "claude-3-5-sonnet-20241022",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "What's in this image?"
        },
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/jpeg",
            "data": "/9j/4AAQSkZJRgABA..."
          }
        }
      ]
    }
  ]
}
```

**转换后 (统一格式)**:
```json
{
  "model": "claude-3-5-sonnet-20241022",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "What's in this image?"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/jpeg;base64,/9j/4AAQSkZJRgABA..."
          },
          "media_type": "image/jpeg"
        }
      ]
    }
  ]
}
```

### 示例 4: 带 Extended Thinking

**客户端请求 (Anthropic 格式)**:
```json
{
  "model": "claude-3-5-sonnet-20241022",
  "max_tokens": 8192,
  "thinking": {
    "type": "enabled",
    "budget_tokens": 5000
  },
  "messages": [
    {
      "role": "user",
      "content": "Solve this complex math problem..."
    }
  ]
}
```

**转换后 (统一格式)**:
```json
{
  "model": "claude-3-5-sonnet-20241022",
  "max_tokens": 8192,
  "reasoning": {
    "effort": "medium",
    "enabled": true
  },
  "messages": [
    {
      "role": "user",
      "content": "Solve this complex math problem..."
    }
  ]
}
```

---

## Vertex AI Claude 支持

**文件**: `src/transformer/vertex-claude.transformer.ts`, `src/utils/vertex-claude.util.ts`

### URL 格式

```
https://{location}-aiplatform.googleapis.com/v1/projects/{projectId}/locations/{location}/publishers/anthropic/models/{model}:rawPredict
```

流式:
```
https://{location}-aiplatform.googleapis.com/v1/projects/{projectId}/locations/{location}/publishers/anthropic/models/{model}:streamRawPredict
```

### 认证

使用 Google Cloud Service Account:
```typescript
const { GoogleAuth } = await import('google-auth-library');
const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform']
});
const client = await auth.getClient();
const accessToken = await client.getAccessToken();

// Header
headers["Authorization"] = `Bearer ${accessToken.token}`;
```

### 请求体差异

```json
{
  "anthropic_version": "vertex-2023-10-16",  // 固定版本标识
  "messages": [...],
  "max_tokens": 1024
}
```

### 环境变量

| 变量 | 说明 | 默认值 |
|-----|------|-------|
| `GOOGLE_CLOUD_PROJECT` | GCP 项目 ID | 从服务账户文件读取 |
| `GOOGLE_CLOUD_LOCATION` | 区域 | `us-east5` |
| `GOOGLE_APPLICATION_CREDENTIALS` | 服务账户密钥路径 | - |

---

## 工具参数解析

**文件**: `src/utils/toolArgumentsParser.ts`

当工具调用参数 JSON 格式有问题时，使用三级降级解析:

```typescript
// 1. 标准 JSON
JSON.parse(argsString)

// 2. JSON5 (允许尾逗号、注释)
JSON5.parse(argsString)

// 3. jsonrepair (自动修复)
jsonrepair(argsString)

// 4. 返回空对象
return "{}"
```

---

## 已知限制

1. **缓存控制**: `cache_control` 字段在转换过程中保留，但需要上游 API 支持
2. **工具参数解析**: 使用多级降级策略，可能修改原始参数格式
3. **流式签名**: 思考块必须在签名后才能关闭
4. **内容块索引**: 使用原子性自增，保证全局唯一

---

*文档生成时间: 2024-12*
*基于代码版本: v1.0.51*
