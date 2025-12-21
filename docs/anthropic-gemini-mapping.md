# Anthropic ↔ Gemini 转换规范文档

本文档基于 `src/transformer/anthropic.transformer.ts` 和 `src/utils/gemini.util.ts` 的实际代码逻辑，详细描述了 Claude (Anthropic) 格式与 Gemini 格式之间的双向转换规则。

## 1. Request: Anthropic → Gemini

**核心函数**: `src/utils/gemini.util.ts` -> `buildRequestBody`

### 1.1 角色 (Roles)

| Anthropic Role | Gemini Role | 转换逻辑 |
| :--- | :--- | :--- |
| `user` | `user` | 直接映射 |
| `assistant` | `model` | 直接映射 |
| `system` | `user` | **降级处理**: System Prompt 被转换为普通的 `user` 消息放在对话开头，**未**使用 `system_instruction` 字段。 |
| `tool` | `user` | 工具执行结果 (Tool Result) 作为 `user` 消息发送。 |

### 1.2 内容 (Content / Parts)

| Anthropic Content Block | Gemini Part | 详细结构映射 |
| :--- | :--- | :--- |
| `type: "text"` | `{ text: string }` | `text` 字段直接透传。 |
| `type: "image_url"` (http/https) | `{ file_data: ... }` | `source.url` -> `file_uri`, `source.media_type` -> `mime_type`。 |
| `type: "image"` (base64) | `{ inlineData: ... }` | `source.data` -> `data`, `source.media_type` -> `mime_type`。**注意字段名为驼峰 `inlineData`**。 |
| `type: "tool_use"` | `{ functionCall: ... }` | `name` -> `name`, `input` -> `args`。若无 ID，自动生成 `tool_{random}`。 |
| `type: "tool_result"` | `{ functionResponse: ... }` | `content` -> `response.result`。`tool_use_id` 用于回溯匹配函数名。 |
| (Reasoning Signature) | `{ thoughtSignature: ... }` | 如果 Anthropic 消息包含 `signature`，会被附加到 Part 中。 |

### 1.3 工具定义 (Tools)

| Anthropic Tool Definition | Gemini Function Declaration | 清洗逻辑 (`processJsonSchema`) |
| :--- | :--- | :--- |
| `name` | `name` | 直接映射 |
| `description` | `description` | 直接映射 |
| `input_schema` | `parameters` | **激进清洗**: <br>1. 移除 `additionalProperties`, `default`。<br>2. `type` 值转大写 (如 `STRING`)。<br>3. 处理 `anyOf` nullable 类型。<br>4. 若含 `$schema`，键名变为 `parametersJsonSchema`。 |
| (Tool: `web_search`) | `googleSearch: {}` | 特殊逻辑：若 tool 列表中有名为 `web_search` 的工具，转换为 Gemini 内置搜索。 |

### 1.4 配置参数 (Configuration)

#### 基础参数映射

| Anthropic Param | Gemini Param (`generationConfig`) | 逻辑 |
| :--- | :--- | :--- |
| `temperature` | `temperature` | 直接映射 |
| `top_p` | `topP` | 直接映射 |
| `top_k` | `topK` | 直接映射 |
| `max_tokens` | `maxOutputTokens` | 直接映射 |
| `stop_sequences` | `stopSequences` | 直接映射 |

#### 思考模式配置

| Anthropic Param | Gemini Param (`generationConfig`) | 逻辑 |
| :--- | :--- | :--- |
| `thinking.budget_tokens` | `thinkingConfig.thinkingBudget` | 对于 Gemini 2.x 模型，最大 32768 |
| `reasoning.effort` | `thinkingConfig.thinkingLevel` | 仅 Gemini 3 系列：`LOW/MEDIUM/HIGH` |
| - | `thinkingConfig.includeThoughts` | 启用时总是 `true` |

**budget → level 映射规则** (Gemini 3):
- ≤1024 → `LOW`
- ≤8192 → `MEDIUM`
- >8192 → `HIGH`

#### 工具调用配置

| Anthropic Param | Gemini Param (`toolConfig`) | 逻辑 |
| :--- | :--- | :--- |
| `tool_choice: { type: "auto" }` | `functionCallingConfig: { mode: "auto" }` | 自动选择 |
| `tool_choice: { type: "any" }` | `functionCallingConfig: { mode: "any" }` | 必须调用工具 |
| `tool_choice: { type: "tool", name: "X" }` | `functionCallingConfig: { mode: "any", allowedFunctionNames: ["X"] }` | 指定工具 |
| `tool_choice: { type: "none" }` | `functionCallingConfig: { mode: "none" }` | 禁用工具 |

---

## 2. Response: Gemini → Anthropic

**核心函数**: `src/utils/gemini.util.ts` -> `transformResponseOut`

### 2.1 消息内容 (Parts → Content Blocks)

Gemini 的响应可能包含混合的思考过程和最终文本。

| Gemini Part Type | Anthropic Block | 转换逻辑 |
| :--- | :--- | :--- |
| `thought: true` | `type: "thinking"` (非标准) | 所有标记为思考的文本会被聚合，放入非标准的 `thinking` 字段（或流式中的 `thinking_delta`）。 |
| `thoughtSignature` | `type: "redacted_thinking"` | 签名信息被提取。 |
| `functionCall` | `type: "tool_use"` | `name` -> `name`, `args` -> `input`。ID 如果缺失则生成。 |
| `text` (thought=false) | `type: "text"` | 普通文本响应。 |
| `groundingMetadata` | `annotations` (非标准) | ���用源被转换为 `url_citation` 类型的注释对象。 |

### 2.2 使用量统计 (Usage)

| Gemini `usageMetadata` | Anthropic `usage` |
| :--- | :--- |
| `promptTokenCount` | `input_tokens` |
| `candidatesTokenCount` | `output_tokens` |
| `totalTokenCount` | (无直接对应，Anthropic 只有 input/output) |
| (Reasoning) | `output_tokens_details.reasoning_tokens` | 若有思考过程，统计思考 token。 |

### 2.3 流式映射 (SSE)

Gemini 的 SSE 流被转换为 Anthropic 风格的 SSE 事件。

*   `event: content_block_start`: 当遇到新的 Content Block (如 text 或 tool_use) 时发送。
*   `event: content_block_delta`:
    *   `type: text_delta`: 普通文本增量。
    *   `type: thinking_delta`: 思考过程增量。
    *   `type: input_json_delta`: 工具参数增量。
*   `event: content_block_stop`: Block 结束。
*   `event: message_delta`: 更新 usage stats 或 stop_reason。
*   `event: message_stop`: 流结束。

## 3. 关键差异总结

1.  **System Prompt**: ✅ 正确映射到 `systemInstruction` 字段（对象格式 `{ parts: [{ text }] }`）
2.  **安全设置**: 固定为 `BLOCK_NONE`（所有类别），暂不支持自定义配置
3.  **参数映射**: ✅ 已完整实现 `temperature`, `top_p`, `top_k`, `max_tokens`, `stop_sequences`
4.  **JSON Schema 兼容性**: 复杂 Schema（`additionalProperties`, `default`）会在转换过程中被移除

---

## 4. PA API vs Standard API

项目中对不同账户类型使用不同的 Gemini API：

| 账户类型 | API 端点 | 特点 |
| :--- | :--- | :--- |
| OAuth 账户 | `cloudcode-pa.googleapis.com/v1internal` | PA API，支持更多功能 |
| API Key 账户 | `generativelanguage.googleapis.com/v1beta` | 标准公网 API |

### 4.1 PA API 特殊格式

1. **工具参数字段**: 使用 `parametersJsonSchema` 而非 `parameters`
2. **响应嵌套**: 可能返回 `{ response: { candidates: [...] } }` 结构
3. **systemInstruction**: 格式为 `{ parts: [{ text }] }`（不含 role 字段）
4. **认证头**: `Authorization: Bearer <access_token>`

### 4.2 Standard API 特殊格式

1. **工具参数字段**: 使用 `parameters`
2. **响应格式**: 直接返回 `{ candidates: [...] }`
3. **认证方式**: URL 查询参数 `?key=<api_key>`
4. **functionResponse 限制**: 仅支持 `name` 和 `response` 字段，不支持 `id`

### 4.3 核心代码位置

| 功能 | 文件路径 |
| :--- | :--- |
| Claude ↔ Gemini 转换 | `src/services/claudeToGemini.js` |
| 直连服务入口 | `src/services/geminiDirectRelayService.js` |
| OAuth 账户管理 | `src/services/geminiAccountService.js` |
| API Key 账户管理 | `src/services/geminiApiAccountService.js` |
