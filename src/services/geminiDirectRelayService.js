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
const unifiedGeminiScheduler = require('./unifiedGeminiScheduler')
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
              logger.info(`[GeminiDirect] Original request msg[${i}] has signature in block:`, {
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

    // DEBUG: Log the converted request
    console.log('[GeminiDirect] Converted Gemini request body:')
    console.log(JSON.stringify(geminiBody, null, 2).substring(0, 2000))

    // Retry logic variables
    let retries = 0
    const MAX_RETRIES = 3
    let lastError = null

    while (retries < MAX_RETRIES) {
      let accountSelection = null
      let accountId = null
      let accountType = null

      try {
        // 2. 使用 Unified Scheduler 选择 Gemini 账号
        const sessionHash = sessionHelper.generateSessionHash(req.body)

        try {
          accountSelection = await unifiedGeminiScheduler.selectAccountForApiKey(
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
              message: error.message || 'No available Gemini accounts'
            }
          })
        }

        ;({ accountId, accountType } = accountSelection)

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
          if (
            !modelName.startsWith('models/') &&
            !modelName.startsWith('publishers/') &&
            !modelName.startsWith('projects/')
          ) {
            modelName = `models/${modelName}`
          }

          const action = stream ? 'streamGenerateContent' : 'generateContent'
          const url = `${endpointBase}/${modelName}:${action}?alt=sse&key=${account.apiKey}`

          // API Key 账户直接使用转换后的 body，但需要清洗 id
          const requestData = this._sanitizeForApiKey(geminiBody)

          const axiosConfig = {
            method: 'POST',
            url,
            headers: {
              'Content-Type': 'application/json'
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
            await this._handleStreamResponse(response, res, model, apiKeyId, accountId, accountType)
          } else {
            // Direct Response Conversion
            const claudeResponse = claudeToGemini.convertResponse(response.data, model)
            res.json(claudeResponse)
            if (claudeResponse.usage) {
              this._recordUsage(apiKeyId, claudeResponse.usage, model, accountId)
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
          const projectId = account.projectId || account.tempProjectId
          const sessionId = `${req.apiKey?.id || req.user?.id}_${projectId}`

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

            // 处理流式响应
            await this._handleStreamResponse(
              { data: streamResponse },
              res,
              model,
              apiKeyId,
              accountId,
              accountType
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
              // Direct Response Conversion
              const claudeResponse = claudeToGemini.convertResponse(responseData, model)
              res.json(claudeResponse)
              if (claudeResponse.usage) {
                this._recordUsage(apiKeyId, claudeResponse.usage, model, accountId)
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
            `[GeminiDirect] Account ${accountId} rate limited or overloaded. Marking as limited.`
          )
          // Use sessionHash to also clear sticky session
          const sessionHash = sessionHelper.generateSessionHash(req.body)
          try {
            await unifiedGeminiScheduler.markAccountRateLimited(accountId, accountType, sessionHash)
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
    _accountType
  ) {
    // Generate a unique request ID for this stream handling
    const streamRequestId = `sr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
    logger.info(
      `[GeminiDirect] [${streamRequestId}] Starting stream response handling for model: ${originalModel}`
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
    logger.info(
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
        const chunkStr = JSON.stringify(chunk)
        logger.info(
          `[GeminiDirect] Received chunk #${chunkCount}: length=${chunkStr.length}, keys=${Object.keys(chunk || {}).join(',')}`
        )
        logger.info(`[GeminiDirect] Chunk #${chunkCount} content: ${chunkStr.substring(0, 500)}`)

        if (chunk.usageMetadata) {
          finalUsage.input_tokens = chunk.usageMetadata.promptTokenCount || finalUsage.input_tokens
          finalUsage.output_tokens =
            chunk.usageMetadata.candidatesTokenCount || finalUsage.output_tokens
          finalUsage.cache_read_input_tokens =
            chunk.usageMetadata.cachedContentTokenCount || finalUsage.cache_read_input_tokens
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
              const deltaContent =
                event.delta.text || event.delta.thinking || event.delta.signature || ''
              logger.info(
                `[GeminiDirect] Event #${eventCount} type=${event.type}, index=${event.index}, deltaType=${event.delta.type}, content="${deltaContent.substring(0, 100)}..."`
              )
            } else if (
              event.type === 'content_block_start' ||
              event.type === 'content_block_stop'
            ) {
              logger.info(
                `[GeminiDirect] Event #${eventCount} type=${event.type}, index=${event.index}, blockType=${event.content_block?.type || 'N/A'}`
              )
            } else {
              logger.info(
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
        logger.info(`[GeminiDirect] res.end() callback fired - response fully sent`)
      })

      // Record Usage asynchronously
      this._recordUsage(apiKeyId, finalUsage, originalModel, accountId)
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
    logger.info(
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
      logger.info('[GeminiDirect] dataStream "end" event fired')

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

    logger.info(
      `[GeminiDirect] Chunk generator finished. Raw chunks: ${rawChunkCount}, Total bytes: ${totalRawBytes}, Yielded: ${yieldCount}`
    )
  }

  async _recordUsage(keyId, usage, model, accountId) {
    if (!usage || (usage.input_tokens === 0 && usage.output_tokens === 0)) {
      return
    }

    try {
      await apiKeyService.recordUsage(
        keyId,
        usage.input_tokens || 0,
        usage.output_tokens || 0,
        0,
        0,
        model,
        accountId
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
}

module.exports = new GeminiDirectRelayService()
