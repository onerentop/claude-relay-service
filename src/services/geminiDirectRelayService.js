const axios = require('axios')
const https = require('https')
const { StringDecoder } = require('string_decoder')
const { v4: uuidv4 } = require('uuid')
const config = require('../../config/config')
const logger = require('../utils/logger')
const apiKeyService = require('./apiKeyService')
const userConfigService = require('./userConfigService')
const claudeToGemini = require('./claudeToGemini')

const geminiAccountService = require('./geminiAccountService')
const geminiApiAccountService = require('./geminiApiAccountService')
const unifiedMixedScheduler = require('./unifiedMixedScheduler')
const claudeRelayService = require('./claudeRelayService')
const claudeConsoleRelayService = require('./claudeConsoleRelayService')
const bedrockRelayService = require('./bedrockRelayService')
const ccrRelayService = require('./ccrRelayService')
const ProxyHelper = require('../utils/proxyHelper')
const sessionHelper = require('../utils/sessionHelper')

// Align with src/services/geminiAccountService.js
const GEMINI_PA_API_BASE = 'https://cloudcode-pa.googleapis.com/v1internal'
const GEMINI_PUBLIC_API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

// TCP Keep-Alive Agent 配置 (参考 geminiAccountService.js)
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  timeout: 120000,
  maxSockets: 100,
  maxFreeSockets: 10
})

class GeminiDirectRelayService {
  constructor() {
    this.modelMapping = config.claudeToGeminiConversion?.modelMapping || {}
  }

  async countTokens(req, res) {
    const { model, messages, system } = req.body

    // 🚀 优化：直接返回本地估算值，不调用 Gemini API
    // 原因：
    // 1. count_tokens 只是预估，不需要精确值
    // 2. Claude Code CLI 启动时会发送大量并发 count_tokens 请求
    // 3. 调用真正的 API 会触发限流 (429)，导致后续所有请求失败
    //
    // 估算规则（参考 Claude 官方）：
    // - 英文: ~4 字符/token
    // - 中文: ~1.5 字符/token
    // - 代码: ~3 字符/token
    // 采用保守估计：平均 3 字符/token

    let totalChars = 0

    // 计算 system prompt 长度
    if (system) {
      if (typeof system === 'string') {
        totalChars += system.length
      } else if (Array.isArray(system)) {
        for (const block of system) {
          if (block.type === 'text' && block.text) {
            totalChars += block.text.length
          }
        }
      }
    }

    // 计算 messages 长度
    if (messages && Array.isArray(messages)) {
      for (const msg of messages) {
        if (typeof msg.content === 'string') {
          totalChars += msg.content.length
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'text' && block.text) {
              totalChars += block.text.length
            } else if (block.type === 'tool_use') {
              // 工具调用也计算
              totalChars += JSON.stringify(block.input || {}).length + (block.name?.length || 0)
            } else if (block.type === 'tool_result') {
              if (typeof block.content === 'string') {
                totalChars += block.content.length
              } else if (Array.isArray(block.content)) {
                for (const r of block.content) {
                  if (r.type === 'text' && r.text) {
                    totalChars += r.text.length
                  }
                }
              }
            }
          }
        }
      }
    }

    // 估算 token 数量（保守估计：3 字符/token）
    const estimatedTokens = Math.ceil(totalChars / 3)

    logger.debug(
      `[GeminiDirect] countTokens (local estimate): model=${model}, chars=${totalChars}, tokens=${estimatedTokens}`
    )

    return res.json({ input_tokens: estimatedTokens })
  }

  async handleRequest(req, res) {
    const { model, stream } = req.body
    const apiKeyId = req.user.id
    const { userId } = req.user

    // 1. 获取配置（用户置优先 > 全局配置）
    let userMapping = {}
    let systemPromptConfig = null
    let globalConfig = null

    if (userId) {
      userMapping = await userConfigService.getModelMapping(userId)
      systemPromptConfig = await userConfigService.getSystemPrompt(userId)
    }

    // 获取全局配置作为 fallback
    const claudeRelayConfigService = require('./claudeRelayConfigService')
    try {
      globalConfig = await claudeRelayConfigService.getConfig()
    } catch (e) {
      logger.warn('[GeminiDirect] Failed to load global config:', e)
    }

    // 如果模型名已经是 Gemini 格式（以 gemini- 开头），直接使用，不要映射
    let targetModel
    if (model.startsWith('gemini-')) {
      targetModel = model
    } else {
      // Claude模型需要映射：用户配置优先 > 全局动态配置 > 静态文件配置
      targetModel = userMapping[model]

      if (!targetModel && globalConfig?.geminiDirectGlobalMapping) {
        targetModel = globalConfig.geminiDirectGlobalMapping[model]
      }

      if (!targetModel) {
        targetModel =
          this.modelMapping[model] || config.claudeToGeminiConversion?.defaultGeminiModel
      }
    }

    // 合并 System Prompt：如果用户没配，尝试用全局配置
    if (!systemPromptConfig && globalConfig?.geminiDirectGlobalSystemPrompt?.prompt) {
      systemPromptConfig = globalConfig.geminiDirectGlobalSystemPrompt
    }

    // DEBUG: 打印原始请求中的消息结构，用于调试 thoughtSignature 来源
    if (req.body.messages) {
      for (let i = 0; i < req.body.messages.length; i++) {
        const msg = req.body.messages[i]
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.signature || block.thought_signature || block.thoughtSignature) {
              logger.debug(`[GeminiDirect] Original request msg[${i}] has signature in block:`, {
                role: msg.role,
                blockType: block.type,
                hasSignature: !!(
                  block.signature ||
                  block.thought_signature ||
                  block.thoughtSignature
                )
              })
            }
          }
        }
      }
    }

    // 4. 转换请求 (New Direct Pipeline)
    const geminiBody = claudeToGemini.convertRequest(req.body, systemPromptConfig, targetModel)

    // Retry logic variables
    let retries = 0
    const MAX_RETRIES = 3
    let lastError = null

    while (retries < MAX_RETRIES) {
      let accountSelection = null
      let accountId = null
      let accountType = null

      try {
        // 2. 使用 Mixed Scheduler 选择账号（支持 Claude + Gemini 混合调度）
        const sessionHash = sessionHelper.generateSessionHash(req.body)

        try {
          accountSelection = await unifiedMixedScheduler.selectAccountForApiKey(
            req.apiKey,
            sessionHash,
            targetModel,
            { allowApiAccounts: true }
          )
        } catch (error) {
          logger.error('[GeminiDirect] Account selection failed:', error)
          // If this is a retry and we ran out of accounts, throw the last error to return 429/original error
          if (retries > 0 && lastError) {
            throw lastError
          }
          return res.status(503).json({
            type: 'error',
            error: {
              type: 'service_unavailable',
              message: error.message || 'No available accounts'
            }
          })
        }

        ;({ accountId, accountType } = accountSelection)

        // 🔀 账户类型分流：如果是 Claude 类型账户，委托给对应的 relay service
        if (
          accountType === 'claude-official' ||
          accountType === 'claude-console' ||
          accountType === 'bedrock' ||
          accountType === 'ccr'
        ) {
          logger.info(
            `[GeminiDirect] Selected Claude-type account: ${accountId} (${accountType}), delegating to native relay service`
          )
          return await this._delegateToClaudeRelayByType(
            req,
            res,
            accountId,
            accountType,
            apiKeyId,
            model,
            sessionHash
          )
        }

        let account
        let _authHeader
        let endpointBase

        // 3. 获取账号详情和认证信息
        if (accountType === 'gemini-api') {
          account = await geminiApiAccountService.getAccount(accountId)
          _authHeader = {} // API Key goes in query param
          // API Key 账户使用公网 API (generativelanguage.googleapis.com)
          endpointBase = account.baseUrl || GEMINI_PUBLIC_API_BASE
        } else {
          // Gemini OAuth
          account = await geminiAccountService.getAccount(accountId)

          // Check for token expiry and refresh if needed
          if (geminiAccountService.isTokenExpired(account)) {
            logger.info(
              `[GeminiDirect] Token for account ${account.name} (${accountId}) is expired, refreshing...`
            )
            await geminiAccountService.refreshAccountToken(accountId)
            // Reload account to get new token
            account = await geminiAccountService.getAccount(accountId)
          }

          const { accessToken } = account
          _authHeader = { Authorization: `Bearer ${accessToken}` }

          // OAuth 账户强制使用 Google Cloud Code PA API (v1internal)
          endpointBase = GEMINI_PA_API_BASE
        }

        if (!account) {
          throw new Error('Selected account not found')
        }

        // 5. 发送请���
        if (accountType === 'gemini-api') {
          // --- API Key 账户逻辑 ---
          let modelName = targetModel

          // 🐛 修复：移除模型名中可能存在的前缀，避免重复
          modelName = modelName.replace(/^(models|publishers|projects)\//, '')

          // 检查 baseUrl 格式（参考 geminiHandlers.js）
          // - 新格式（以 /models 结尾）: https://xxx.com/v1beta/models -> 直接拼接 /{model}:action
          // - 旧格式（不以 /models 结尾）: https://xxx.com/v1beta -> 拼接 /models/{model}:action
          const normalizedBaseUrl = endpointBase.replace(/\/+$/, '')
          const isNewFormat = normalizedBaseUrl.endsWith('/models')

          const action = stream ? 'streamGenerateContent' : 'generateContent'
          const queryParams = new URLSearchParams()
          if (stream) {
            queryParams.set('alt', 'sse')
          }
          queryParams.set('key', account.apiKey)
          const queryString = queryParams.toString()
          let url

          if (isNewFormat) {
            // 新格式: baseUrl 已包含 /v1beta/models，直接拼接 /{model}:action
            url = `${normalizedBaseUrl}/${modelName}:${action}?${queryString}`
          } else {
            // 旧格式: 需要添加 /models/
            if (!modelName.startsWith('publishers/') && !modelName.startsWith('projects/')) {
              modelName = `models/${modelName}`
            }
            url = `${normalizedBaseUrl}/${modelName}:${action}?${queryString}`
          }

          // API Key 账户直接使用转换后的 body，但需要清洗 id
          const requestData = this._sanitizeForApiKey(geminiBody)

          // 根据 gemini-cli 官方做法，添加 User-Agent 头
          const userAgent = `GeminiCLI/1.0.0 (${process.platform}; ${process.arch})`
          const axiosConfig = {
            method: 'POST',
            url,
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': userAgent
            },
            data: requestData,
            responseType: stream ? 'stream' : 'json',
            timeout: config.requestTimeout || 600000
          }

          // 代理配置
          if (account.proxy) {
            const proxyAgent = ProxyHelper.createProxyAgent(account.proxy)
            if (proxyAgent) {
              axiosConfig.httpsAgent = proxyAgent
              axiosConfig.proxy = false
            }
          } else {
            axiosConfig.httpsAgent = keepAliveAgent
          }

          logger.info(`[GeminiDirect] Sending request to ${url} (Account: ${account.name})`)
          const response = await axios(axiosConfig)

          if (stream) {
            // 传入 targetModel 用于统计记录（Gemini 模型名），model 用于响应格式（原始请求模型名）
            await this._handleStreamResponse(
              response,
              res,
              model,
              apiKeyId,
              accountId,
              accountType,
              targetModel
            )
          } else {
            // Direct Response Conversion - 使用原始模型名返回给客户端
            const claudeResponse = claudeToGemini.convertResponse(response.data, model)
            res.json(claudeResponse)
            if (claudeResponse.usage) {
              // 使用 targetModel（Gemini 模型名）进行统计记录
              this._recordUsage(apiKeyId, claudeResponse.usage, targetModel, accountId)
            }
          }
          return // Success, exit loop and function
        } else {
          // --- OAuth 账户逻辑 (委托给 geminiAccountService) ---
          logger.info(
            `[GeminiDirect] Delegating request to geminiAccountService for account ${account.name}`
          )

          // 移除 models/ 前缀以配合 PA API
          let serviceModel = targetModel
          if (serviceModel.startsWith('models/')) {
            serviceModel = serviceModel.replace('models/', '')
          }

          const requestData = {
            model: serviceModel,
            request: geminiBody
          }

          const userPromptId = `${uuidv4()}########0`
          // Session ID 需要包含项目信息，因为 Gemini session 是项目级别的
          // 跨项目使用相同的 session_id 会导致 400 INVALID_ARGUMENT
          const projectId = account.projectId || account.tempProjectId || ''
          // 确保 sessionId 格式正确，避免末尾带下划线
          const baseSessionId = req.apiKey?.id || req.user?.id || uuidv4()
          const sessionId = projectId ? `${baseSessionId}_${projectId}` : baseSessionId

          // 获取 OAuth Client
          const client = await geminiAccountService.getOauthClient(
            account.accessToken,
            account.refreshToken,
            account.proxy
          )

          if (!client) {
            throw new Error('Failed to create OAuth client')
          }

          if (stream) {
            // 调用流式接口
            const streamResponse = await geminiAccountService.generateContentStream(
              client,
              requestData,
              userPromptId,
              projectId,
              sessionId,
              null, // signal
              account.proxy
            )

            // 处理流式响应 - 传入 targetModel 用于统计记录
            await this._handleStreamResponse(
              { data: streamResponse },
              res,
              model,
              apiKeyId,
              accountId,
              accountType,
              targetModel
            )
          } else {
            // 调用非流式接口
            const responseData = await geminiAccountService.generateContent(
              client,
              requestData,
              userPromptId,
              projectId,
              sessionId,
              account.proxy
            )

            try {
              // Direct Response Conversion - 使用原始模型名返回给客户端
              const claudeResponse = claudeToGemini.convertResponse(responseData, model)
              res.json(claudeResponse)
              if (claudeResponse.usage) {
                // 使用 targetModel（Gemini 模型名）进行统计记录
                this._recordUsage(apiKeyId, claudeResponse.usage, targetModel, accountId)
              }
            } catch (convertError) {
              logger.error(
                '[GeminiDirect] Response conversion failed. Raw response:',
                JSON.stringify(responseData, null, 2)
              )
              throw convertError
            }
          }
          return // Success, exit loop and function
        }
      } catch (error) {
        lastError = error
        retries++

        // 尝试读取错误响应体（如果是流）
        let errorDetails = error.response?.data
        if (errorDetails && typeof errorDetails === 'object' && errorDetails.readable) {
          // 这是一个流对象，尝试读取它
          try {
            const chunks = []
            for await (const chunk of errorDetails) {
              chunks.push(chunk)
            }
            errorDetails = Buffer.concat(chunks).toString('utf-8')
            try {
              errorDetails = JSON.parse(errorDetails)
            } catch (e) {
              // 保持字符串格式
            }
          } catch (readError) {
            logger.warn('[GeminiDirect] Failed to read error response stream:', readError.message)
            errorDetails = '[Unable to read error stream]'
          }
        }

        logger.error(`[GeminiDirect] Request failed (Attempt ${retries}/${MAX_RETRIES}):`, {
          message: error.message,
          status: error.response?.status,
          response: errorDetails
        })

        // Handle Rate Limits (429) or Service Unavailable (503)
        // Mark account as limited so the scheduler picks a different one next time
        if (accountId && (error.response?.status === 429 || error.response?.status === 503)) {
          logger.warn(
            `[GeminiDirect] Account ${accountId} (${accountType}) rate limited or overloaded. Marking as limited.`
          )
          // Use sessionHash to also clear sticky session
          const sessionHash = sessionHelper.generateSessionHash(req.body)
          try {
            await unifiedMixedScheduler.markAccountRateLimited(accountId, accountType, sessionHash)
          } catch (limitError) {
            logger.warn('[GeminiDirect] Failed to mark account as rate limited:', limitError)
          }
        }
      }
    }

    // If loop finishes without success
    if (lastError) {
      this._handleFinalError(lastError, res, stream)
    }
  }

  _handleFinalError(error, res, stream) {
    // If response already committed, we can't send error json
    if (res.headersSent) {
      // If it was a stream and not ended, try to send error event
      if (stream && !res.writableEnded) {
        res.write(
          `event: error\ndata: ${JSON.stringify({
            type: 'error',
            error: {
              type: 'api_error',
              message: error.message || 'Request failed after retries'
            }
          })}\n\n`
        )
        res.end()
      }
      return
    }

    const status = error.response?.status || 500
    const message = error.response?.data?.error?.message || error.message || 'Internal Server Error'

    res.status(status).json({
      type: 'error',
      error: {
        type: 'api_error',
        message
      }
    })
  }

  async _handleStreamResponse(
    axiosResponse,
    res,
    originalModel,
    apiKeyId,
    accountId,
    _accountType,
    statsModel = null // Gemini 模型名，用于统计记录；如果不传则使用 originalModel
  ) {
    // 统计使用的模型名：优先使用 statsModel（Gemini 模型名），否则使用 originalModel
    const modelForStats = statsModel || originalModel

    // Generate a unique request ID for this stream handling
    const streamRequestId = `sr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
    logger.info(
      `[GeminiDirect] [${streamRequestId}] Starting stream response handling for model: ${originalModel} (stats: ${modelForStats})`
    )

    // Set response headers using writeHead (same pattern as ccrRelayService)
    if (!res.headersSent) {
      const existingConnection = res.getHeader ? res.getHeader('Connection') : null
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: existingConnection || 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
      })
    }

    // SSE Heartbeat mechanism
    let lastDataTime = Date.now()
    const HEARTBEAT_INTERVAL = 15000
    const heartbeatTimer = setInterval(() => {
      const timeSinceLastData = Date.now() - lastDataTime
      if (timeSinceLastData >= HEARTBEAT_INTERVAL && !res.destroyed) {
        res.write('event: ping\ndata: {}\n\n')
      }
    }, HEARTBEAT_INTERVAL)

    const finalUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }

    // Send message_start event
    const messageStartEvent = {
      type: 'message_start',
      message: {
        id: `msg_${uuidv4()}`,
        type: 'message',
        role: 'assistant',
        model: originalModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    }
    const messageStartSSE = `event: message_start\ndata: ${JSON.stringify(messageStartEvent)}\n\n`
    const startWriteResult = res.write(messageStartSSE)
    logger.debug(
      `[GeminiDirect] Sent message_start event, write=${startWriteResult}, len=${messageStartSSE.length}`
    )

    const streamState = { index: 0, currentType: null, hasToolUse: false, pendingText: '' }

    try {
      // Create source stream from Gemini SSE
      const geminiChunks = this._geminiChunkGenerator(axiosResponse.data)
      let chunkCount = 0

      for await (const chunk of geminiChunks) {
        chunkCount++
        lastDataTime = Date.now()

        // Detailed chunk inspection
        const chunkKeys = Object.keys(chunk || {})
        const responseKeys = chunk.response ? Object.keys(chunk.response) : []
        logger.debug(
          `[GeminiDirect] Chunk #${chunkCount}: keys=[${chunkKeys.join(',')}], response.keys=[${responseKeys.join(',')}]`
        )

        // 兼容 PA API 的嵌套结构：usageMetadata 可能在 chunk 或 chunk.response 中
        const usageMetadata = chunk.usageMetadata || chunk.response?.usageMetadata
        if (usageMetadata) {
          finalUsage.input_tokens = usageMetadata.promptTokenCount || finalUsage.input_tokens
          finalUsage.output_tokens = usageMetadata.candidatesTokenCount || finalUsage.output_tokens
          finalUsage.cache_read_input_tokens =
            usageMetadata.cachedContentTokenCount || finalUsage.cache_read_input_tokens
        }

        let eventCount = 0
        for (const event of claudeToGemini.convertStreamChunk(chunk, streamState)) {
          eventCount++
          let writeResult
          if (event.type === 'message_stop') {
            // Already handled at the end of loop
            continue
          } else {
            // Claude API expects type in both event name AND data payload
            // Using standard SSE format with space after colon
            const sseData = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
            writeResult = res.write(sseData)
            // 详细日志：记录实际发送的内容
            if (event.type === 'content_block_delta' && event.delta) {
              // Skip logging content detail to reduce noise
            } else if (
              event.type === 'content_block_start' ||
              event.type === 'content_block_stop'
            ) {
              logger.debug(
                `[GeminiDirect] Event #${eventCount} type=${event.type}, index=${event.index}, blockType=${event.content_block?.type || 'N/A'}`
              )
            } else {
              logger.debug(
                `[GeminiDirect] Event #${eventCount} type=${event.type}, write=${writeResult}, len=${sseData.length}`
              )
            }
          }
          // Try explicit flush if available
          if (typeof res.flush === 'function') {
            res.flush()
          }
        }
        if (eventCount === 0) {
          logger.warn(`[GeminiDirect] Chunk #${chunkCount} produced 0 events`)
        }
      }

      // Send final usage stats via message_delta after stream is complete
      const messageDeltaEvent = {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: {
          output_tokens: finalUsage.output_tokens
        }
      }
      res.write(`event: message_delta\ndata: ${JSON.stringify(messageDeltaEvent)}\n\n`)

      res.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`)
      logger.info(`[GeminiDirect] Stream completed. Total chunks: ${chunkCount}`)
      logger.info(
        `[GeminiDirect] Response state: headersSent=${res.headersSent}, writableEnded=${res.writableEnded}, destroyed=${res.destroyed}`
      )

      res.end(() => {
        logger.debug(`[GeminiDirect] res.end() callback fired - response fully sent`)
      })

      // Log usage data before recording
      if (finalUsage.input_tokens === 0 && finalUsage.output_tokens === 0) {
        logger.warn(
          `[GeminiDirect] No usageMetadata captured from Gemini response! Model: ${originalModel} -> ${modelForStats}, Chunks: ${chunkCount}`
        )
      } else {
        logger.info(
          `[GeminiDirect] Usage captured - Model: ${modelForStats}, Input: ${finalUsage.input_tokens}, Output: ${finalUsage.output_tokens}, CacheRead: ${finalUsage.cache_read_input_tokens}`
        )
      }

      // Record Usage asynchronously - 使用 modelForStats（Gemini 模型名）进行统计
      this._recordUsage(apiKeyId, finalUsage, modelForStats, accountId)
    } catch (err) {
      logger.error('[GeminiDirect] Stream processing error:', err)
      if (!res.writableEnded) {
        res.write(
          `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'internal_error', message: 'Stream interrupted' } })}\n\n`
        )
        res.end()
      }
    } finally {
      clearInterval(heartbeatTimer)
    }
  }

  async *_geminiChunkGenerator(dataStream) {
    // 使用事件监听替代 for-await 循环
    // 原因：Gemini PA API 返回 Content-Length: 0，导致 for-await 不执行
    logger.debug(
      `[GeminiDirect] Starting chunk generator, dataStream type: ${typeof dataStream}, constructor: ${dataStream?.constructor?.name || 'unknown'}`
    )

    if (!dataStream) {
      logger.error('[GeminiDirect] dataStream is null or undefined')
      return
    }

    let buffer = ''
    let rawChunkCount = 0
    let totalRawBytes = 0
    let yieldCount = 0
    const decoder = new StringDecoder('utf8')

    // 创建一个队列来存储解析后的 chunks
    const chunks = []
    let resolveNext = null
    let streamEnded = false
    let streamError = null

    // 处理 SSE 数据的辅助函数
    const processBuffer = () => {
      const parts = buffer.split('\n\n')
      buffer = parts.pop() || ''

      for (const part of parts) {
        const lines = part.split('\n')
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data && data !== '[DONE]') {
              try {
                const parsed = JSON.parse(data)
                chunks.push(parsed)
                // 如果有等待的 Promise，立即 resolve
                if (resolveNext) {
                  resolveNext()
                  resolveNext = null
                }
              } catch (e) {
                logger.warn('[GeminiDirect] Failed to parse JSON chunk', {
                  error: e.message,
                  dataPreview: data.substring(0, 200),
                  dataLength: data.length,
                  rawChunkCount
                })
              }
            }
          }
        }
      }
    }

    // 设置事件监听器
    dataStream.on('data', (rawChunk) => {
      rawChunkCount++
      const chunkStr = decoder.write(rawChunk)
      totalRawBytes += rawChunk.length

      logger.debug(
        `[GeminiDirect] Raw chunk #${rawChunkCount}: bytes=${rawChunk.length}, chars=${chunkStr.length}`
      )

      buffer += chunkStr
      processBuffer()
    })

    dataStream.on('end', () => {
      logger.debug('[GeminiDirect] dataStream "end" event fired')

      // 处理 StringDecoder 残留的多字节字符
      const remaining = decoder.end()
      if (remaining) {
        logger.debug(
          '[GeminiDirect] StringDecoder end() returned remaining bytes:',
          remaining.length
        )
        buffer += remaining
      }

      // 处理剩余 buffer
      if (buffer.trim()) {
        const lines = buffer.split('\n')
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data && data !== '[DONE]') {
              try {
                const parsed = JSON.parse(data)
                chunks.push(parsed)
              } catch (e) {
                logger.warn('[GeminiDirect] Failed to parse remaining JSON', {
                  error: e.message,
                  dataPreview: data.substring(0, 200),
                  dataLength: data.length
                })
              }
            }
          }
        }
      }

      streamEnded = true
      if (resolveNext) {
        resolveNext()
        resolveNext = null
      }
    })

    dataStream.on('error', (err) => {
      logger.error('[GeminiDirect] dataStream "error" event:', err)
      streamError = err
      streamEnded = true
      if (resolveNext) {
        resolveNext()
        resolveNext = null
      }
    })

    dataStream.on('close', () => {
      logger.debug('[GeminiDirect] dataStream "close" event fired')
    })

    // 使用 yield 返回解析后的 chunks
    while (!streamEnded || chunks.length > 0) {
      if (chunks.length > 0) {
        yieldCount++
        yield chunks.shift()
      } else if (!streamEnded) {
        // 等待新数据或流结束
        await new Promise((resolve) => {
          resolveNext = resolve
        })
      }
    }

    if (streamError) {
      logger.error('[GeminiDirect] Stream completed with error:', streamError)
    }

    logger.debug(
      `[GeminiDirect] Chunk generator finished. Raw chunks: ${rawChunkCount}, Total bytes: ${totalRawBytes}, Yielded: ${yieldCount}`
    )
  }

  async _recordUsage(keyId, usage, model, accountId) {
    if (!usage || (usage.input_tokens === 0 && usage.output_tokens === 0)) {
      return
    }

    try {
      // 构建完整的 usage 对象
      const usageObject = {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0
      }

      // 使用 recordUsageWithDetails 获得完整的统计功能
      await apiKeyService.recordUsageWithDetails(
        keyId,
        usageObject,
        model,
        accountId,
        'gemini-direct'
      )

      logger.debug(
        `[GeminiDirect] Usage recorded - Model: ${model}, Input: ${usageObject.input_tokens}, Output: ${usageObject.output_tokens}, CacheRead: ${usageObject.cache_read_input_tokens}`
      )
    } catch (e) {
      logger.error('[GeminiDirect] Failed to record usage:', e)
    }
  }

  /**
   * Sanitize request body for API Key accounts
   * Specifically, remove 'id' from functionResponse as Standard API doesn't support it
   */
  _sanitizeForApiKey(body) {
    if (!body || !body.contents) {
      return body
    }

    const newBody = JSON.parse(JSON.stringify(body))

    for (const content of newBody.contents) {
      if (content.parts) {
        for (const part of content.parts) {
          if (part.functionResponse) {
            // Standard API (API Key) does not support 'id' in functionResponse
            // Only 'name' and 'response' are allowed
            if (part.functionResponse.id) {
              delete part.functionResponse.id
            }
            // Also check nested response structure just in case
            if (part.functionResponse.response && part.functionResponse.response.id) {
              delete part.functionResponse.response.id
            }
          }
        }
      }
    }
    return newBody
  }

  /**
   * 🔀 委托给对应的 Claude Relay Service
   * 当混合调度选中 Claude 类型账户时，将请求转发到原生 relay service
   */
  async _delegateToClaudeRelayByType(
    req,
    res,
    accountId,
    accountType,
    apiKeyId,
    model,
    sessionHash
  ) {
    const { stream } = req.body

    try {
      if (accountType === 'claude-official') {
        // Claude Official：使用 claudeRelayService
        logger.info(`[GeminiDirect] Delegating to claudeRelayService for account ${accountId}`)

        if (stream) {
          await claudeRelayService.relayStreamRequestWithUsageCapture(
            req.body,
            req.apiKey,
            res,
            req.headers,
            (usageData) => {
              if (usageData?.input_tokens !== undefined) {
                this._recordClaudeUsage(apiKeyId, usageData, model, accountId, 'claude-official')
              }
            }
          )
        } else {
          const response = await claudeRelayService.relayRequest(
            req.body,
            req.apiKey,
            req,
            res,
            req.headers
          )
          this._handleClaudeNonStreamResponse(res, response, apiKeyId, model, accountId)
        }
      } else if (accountType === 'claude-console') {
        // Claude Console：使用 claudeConsoleRelayService
        logger.info(
          `[GeminiDirect] Delegating to claudeConsoleRelayService for account ${accountId}`
        )

        if (stream) {
          // 参数顺序: requestBody, apiKeyData, responseStream, clientHeaders, usageCallback, accountId
          await claudeConsoleRelayService.relayStreamRequestWithUsageCapture(
            req.body,
            req.apiKey,
            res,
            req.headers,
            (usageData) => {
              if (usageData?.input_tokens !== undefined) {
                this._recordClaudeUsage(apiKeyId, usageData, model, accountId, 'claude-console')
              }
            },
            accountId
          )
        } else {
          // 参数顺序: requestBody, apiKeyData, clientRequest, clientResponse, clientHeaders, accountId
          const response = await claudeConsoleRelayService.relayRequest(
            req.body,
            req.apiKey,
            req,
            res,
            req.headers,
            accountId
          )
          this._handleClaudeNonStreamResponse(res, response, apiKeyId, model, accountId)
        }
      } else if (accountType === 'bedrock') {
        // Bedrock：使用 bedrockRelayService
        logger.info(`[GeminiDirect] Delegating to bedrockRelayService for account ${accountId}`)

        if (stream) {
          await bedrockRelayService.handleStreamRequest(req, res, accountId, (usageData) => {
            if (usageData?.input_tokens !== undefined) {
              this._recordClaudeUsage(apiKeyId, usageData, model, accountId, 'bedrock')
            }
          })
        } else {
          await bedrockRelayService.handleRequest(req, res, accountId, (usageData) => {
            if (usageData?.input_tokens !== undefined) {
              this._recordClaudeUsage(apiKeyId, usageData, model, accountId, 'bedrock')
            }
          })
        }
      } else if (accountType === 'ccr') {
        // CCR：使用 ccrRelayService
        logger.info(`[GeminiDirect] Delegating to ccrRelayService for account ${accountId}`)

        if (stream) {
          await ccrRelayService.relayStreamRequestWithUsageCapture(
            accountId,
            req.body,
            req.apiKey,
            res,
            req.headers,
            (usageData) => {
              if (usageData?.input_tokens !== undefined) {
                this._recordClaudeUsage(apiKeyId, usageData, model, accountId, 'ccr')
              }
            }
          )
        } else {
          const response = await ccrRelayService.relayRequest(
            accountId,
            req.body,
            req.apiKey,
            res,
            req.headers
          )
          this._handleClaudeNonStreamResponse(res, response, apiKeyId, model, accountId)
        }
      } else {
        throw new Error(`Unknown Claude account type: ${accountType}`)
      }
    } catch (error) {
      logger.error(
        `[GeminiDirect] Claude relay delegation failed for ${accountType}:`,
        error.message
      )

      // 标记限流并清除会话映射
      if (error.response?.status === 429 || error.response?.status === 503) {
        try {
          await unifiedMixedScheduler.markAccountRateLimited(accountId, accountType, sessionHash)
        } catch (limitError) {
          logger.warn('[GeminiDirect] Failed to mark Claude account as rate limited:', limitError)
        }
      }

      // 如果响应已经发送，不再处理
      if (res.headersSent) {
        return
      }

      const status = error.response?.status || 500
      const message = error.message || 'Internal Server Error'

      res.status(status).json({
        type: 'error',
        error: {
          type: 'api_error',
          message
        }
      })
    }
  }

  /**
   * 处理 Claude 非流式响应
   */
  _handleClaudeNonStreamResponse(res, response, apiKeyId, model, accountId) {
    try {
      const jsonData = typeof response.body === 'string' ? JSON.parse(response.body) : response.body
      if (jsonData.usage) {
        this._recordClaudeUsage(
          apiKeyId,
          jsonData.usage,
          jsonData.model || model,
          accountId,
          'claude'
        )
      }
      res.status(response.statusCode || 200).json(jsonData)
    } catch (e) {
      res.status(response.statusCode || 200).send(response.body)
    }
  }

  /**
   * 记录 Claude 账户的使用量
   */
  async _recordClaudeUsage(keyId, usage, model, accountId, sourceType) {
    if (!usage || (usage.input_tokens === 0 && usage.output_tokens === 0)) {
      return
    }

    try {
      const usageObject = {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0
      }

      await apiKeyService.recordUsageWithDetails(keyId, usageObject, model, accountId, sourceType)

      logger.debug(
        `[GeminiDirect] Claude usage recorded - Source: ${sourceType}, Model: ${model}, Input: ${usageObject.input_tokens}, Output: ${usageObject.output_tokens}`
      )
    } catch (e) {
      logger.error('[GeminiDirect] Failed to record Claude usage:', e)
    }
  }
}

module.exports = new GeminiDirectRelayService()
