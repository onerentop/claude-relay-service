# Google Cloud Code PA API (v1internal) 接口文档

本文档基于 `src/handlers/geminiHandlers.js` 和 `src/services/geminiAccountService.js` 的实现整理，描述了 Google Cloud Code Private API (`v1internal`) 的交互细节。此 API 主要用于 Gemini Direct 模式下的 OAuth 账户连接。

## 1. 概述

*   **API 类型**: Private API (非公开)
*   **Base URL**: `https://cloudcode-pa.googleapis.com/v1internal` (或 `https://clients6.google.com`)
*   **认证方式**: OAuth 2.0 (Bearer Token)
*   **适用场景**: IDE 插件 (VS Code, IntelliJ) 与 Gemini 的交互

## 2. 鉴权与上下文

所有请求必须包含以下 Header：

```http
Authorization: Bearer <OAuth_Access_Token>
Content-Type: application/json
X-Goog-Api-Client: genai-js/0.1.0
X-Goog-Auth-User: 0
```

## 3. 核心端点

### 3.1 生成内容 (非流式)

*   **URL**: `/projects/{projectId}/locations/global/publishers/google/models/{model}:generateContent`
*   **Method**: `POST`

#### 请求体 (Request Body)

```json
{
  "request": {
    "contents": [
      {
        "role": "user",
        "parts": [{ "text": "Hello" }]
      }
    ],
    "generationConfig": {
      "temperature": 0.7,
      "maxOutputTokens": 4096,
      "topP": 0.95,
      "topK": 40,
      "candidateCount": 1
    },
    "tools": [],
    "systemInstruction": {
      "parts": [{ "text": "System prompt here" }]
    }
  },
  "project": "projects/{projectId}",
  "user_prompt_id": "UUID-########0"
}
```

**注意**:
1.  内容包裹在 `request` 字段中（区别于标准 API 直接在根对象）。
2.  需要提供 `user_prompt_id`，通常格式为 `UUID` 后跟 `########0`。
3.  `safetySettings` 字段在该接口中经常导致 400 错误，**建议省略**。

#### 响应体 (Response Body)

响应体包含特殊的嵌套结构：

```json
{
  "response": {
    "candidates": [
      {
        "content": {
          "parts": [{ "text": "Response text" }],
          "role": "model"
        },
        "finishReason": "STOP",
        "index": 0
      }
    ],
    "usageMetadata": {
      "promptTokenCount": 10,
      "candidatesTokenCount": 20,
      "totalTokenCount": 30
    }
  }
}
```

**偶发情况**: API 可能返回双重序列化的 JSON 字符串：
`{ "response": "{\"candidates\": ...}" }`
客户端需做防御性解析。

### 3.2 生成内容 (流式)

*   **URL**: `/projects/{projectId}/locations/global/publishers/google/models/{model}:streamGenerateContent`
*   **Method**: `POST`
*   **Query Param**: `alt=sse`

#### 请求体
同非流式接口。

#### 响应格式 (SSE)

Server-Sent Events 格式，每行以 `data:` 开头。

```text
data: {"response": {"candidates": [...], "usageMetadata": ...}}

data: {"response": {"candidates": [...]}}
```

**Usage 处理**:
Usage 信息可能出现在流的最后几个包中。需累加 `usageMetadata`。

### 3.3 Project ID 获取 (LoadCodeAssist)

如果账号未配置 Project ID，可调用此端点动态获取。

*   **URL**: `/v1internal/projects/-/locations/global/codeAssist:loadCodeAssist`
*   **Method**: `POST`

#### 响应
```json
{
  "cloudaicompanionProject": "projects/123456789"
}
```
获取到的 ID 可用于后续请求。

## 4. 常见错误码

| HTTP Code | 描述 | 原因与处理 |
| :--- | :--- | :--- |
| **400** | Bad Request | 通常因请求体包含不支持字段 (如 `safetySettings`) 或 Project ID 格式错误。 |
| **401** | Unauthorized | Token 过期。需使用 Refresh Token 刷新。 |
| **403** | Forbidden | 账号无权访问该 Project，或未启用 Cloud AI Companion API。 |
| **429** | Too Many Requests | 触发配额限制。需等待或切换账号。 |
| **503** | Service Unavailable | 服务过载。建议指数退避重试。 |

## 5. 代理配置重要性

由于 `oauth2.googleapis.com` (Token 刷新) 和 `cloudcode-pa.googleapis.com` (API 调用) 在国内均无法直连，**必须**正确配置代理 (`https-proxy-agent`)。代码中需确保 `proxy` 参数在 `getOauthClient` 和 `axios` 请求中均被正确传递。
