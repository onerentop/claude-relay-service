# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

这个文件为 Claude Code (claude.ai/code) 提供在此代码库中工作的指导。

## 项目概述

Claude Relay Service 是一个多平台 AI API 中转服务，支持 **Claude (官方/Console)、Gemini (API/OAuth)、OpenAI Responses (Codex)、AWS Bedrock、Azure OpenAI、Droid (Factory.ai)、CCR** 等多种账户类型。该服务作为中间件，允许客户端（如 Claude Code, Cherry Studio 等）使用 Claude 格式的请求调用各种后端模型，提供认证、限流、监控、定价计算、成本统计和多账户统一调度功能。

## 常用命令

### 开发与运行
- **启动服务**: `npm start` (生产模式) 或 `npm run dev` (开发模式/热重载)
- **服务管理 (Daemon)**:
  - 启动: `npm run service:start:daemon`
  - 停止: `npm run service:stop`
  - 重启: `npm run service:restart:daemon`
  - 查看日志: `npm run service:logs`
  - 查看状态: `npm run service:status`
- **代码检查与格式化**:
  - 检查: `npm run lint`
  - 格式化: `npm run format` (使用 Prettier)
- **测试**: `npm test` (运行 Jest 测试)

### 数据与维护
- **初始化/重置**: `npm run setup` (生成配置和管理员凭据)
- **更新模型价格**: `npm run update:pricing`
- **初始化成本数据**: `npm run init:costs`
- **Redis 数据管理**:
  - 导出: `npm run data:export` (或 `data:export:encrypted` 保留加密)
  - 导入: `npm run data:import`
  - 调试 Key: `npm run data:debug`

### 监控
- **系统状态**: `npm run status` (简略) 或 `npm run status:detail` (详细)
- **实时监控**: `npm run monitor` (基于终端的仪表盘)

## 核心架构

### 关键架构概念

- **统一调度系统**: 使用 `unifiedClaudeScheduler`、`unifiedGeminiScheduler` 等实现跨账户类型的智能调度。
- **Gemini Direct 管道**: 新一代 Gemini 转发机制，支持 Claude 格式直接转 Gemini 格式，完美支持 Claude 3.7 Thinking 模式到 Gemini Thinking 的映射，以及 Google Search 工具的转换。
- **用户配置覆盖**: 支持用户级别的模型映射 (`model_mapping`) 和系统提示词 (`system_prompt`)，允许不同用户自定义转发行为。
- **多账户支持**: 支持 claude-official, claude-console, bedrock, gemini, openai, azure-openai 等。
- **数据加密**: 敏感数据（Token, 凭据）使用 AES 加密存储在 Redis。
- **粘性会话**: 基于请求特征哈希的会话绑定，确保多轮对话上下文一致性。
- **并发请求排队**: 智能的请求排队机制，防止上游 API 限流 (429)，支持优先级和超时控制。

### 主要服务组件

#### 核心转发服务 (src/services/)
- **claudeRelayService.js**: Claude 官方 API 转发。
- **geminiDirectRelayService.js**: **(核心)** 新版 Gemini 转发服务，处理 Claude -> Gemini 的转换、流式响应映射 (SSE)、Thinking Block 处理和 Google Search 工具调用。
- **claudeConsoleRelayService.js**: Claude Console 网页版模拟转发。
- **bedrockRelayService.js**: AWS Bedrock 转发。
- **azureOpenaiRelayService.js**: Azure OpenAI 转发。
- **openaiResponsesRelayService.js**: OpenAI 兼容格式转发。

#### 账户管理服务
- **claudeAccountService.js**: Claude OAuth 账户管理与 Token 刷新。
- **geminiAccountService.js**: Gemini OAuth 账户管理。
- **geminiApiAccountService.js**: Gemini API Key 账户管理。
- **userConfigService.js**: **(核心)** 管���用户级配置（模型映射、自定义 System Prompt、Gemini Direct 开关）。

#### 转换与工具服务
- **claudeToGemini.js**: **(核心)** 负责 Claude 请求体到 Gemini 格式的转换，以及 Gemini 响应（含流式 chunks）到 Claude 格式的逆向转换。支持 JSON Schema 转换和 Thinking 协议适配。
- **openaiToClaude.js**: OpenAI 格式转 Claude 格式。
- **pricingService.js**: 模型计费与成本估算。
- **apiKeyService.js**: API Key 验证、权限控制与 Usage 记录。

### 数据流与存储 (Redis)

- **API Keys**: `api_key:{id}`, `api_key_hash:{hash}`
- **用户配置**: `user_config:{userId}:model_mapping`, `user_config:{userId}:system_prompt`
- **账户数据**: `claude_account:{id}`, `gemini_account:{id}` 等（加密存储）
- **会话与并发**: `sticky_session:{hash}`, `concurrency:{accountId}`, `concurrency:queue:{apiKeyId}`
- **统计**: `usage:daily:{date}:{key}:{model}`

## 开发规范

### 代码风格
- **格式化**: 必须使用 Prettier。提交前运行 `npm run format`。
- **语言**: 必须使用 **中文** 编写注释和文档。
- **命名**: 服务层使用 `Service` 后缀 (e.g., `userService.js`)，工具类使用 `Helper` 或功能名。

### 安全要求
- **零信任**: 所有 API 路由必须经过 `authenticateApiKey` 或 `authenticateAdmin` 中��件。
- **加密**: 任何 OAuth Token、Refresh Token 或第三方 API Key 存入 Redis 前必须加密。
- **日志**: 禁止在日志中打印完整的 Token 或请求体敏感信息（使用 `tokenMask` 工具）。

### 前端开发 (web/admin-spa)
- **技术栈**: Vue 3 + Tailwind CSS。
- **暗黑模式**: 必须适配暗黑模式 (`dark:` 类)。
- **构建**: 修改前端后需运行 `npm run build:web`。

## 故障排查

- **Token 刷新失败**: 检查 `logs/token-refresh-error.log`，通常是 Refresh Token 过期或代理配置问题。
- **Gemini 报错**: 检查是否启用了 `geminiDirectRelayService`，查看 `logs/claude-relay-combined.log` 中的 `[GeminiDirect]` 标签日志。
- **529/429 错误**: 系统会自动标记过载账户并暂时排除。检查 Redis 中的 `overload:{accountId}` 键。
