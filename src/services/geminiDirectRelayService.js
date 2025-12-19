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
    const { model } = req.body

    // 1. 获取配置（用户配置优先 > 全局配置）
    const apiKeyId = req.user.id
    const { userId } = req.user
    let userMapping = {}
    let systemPromptConfig = null
    let globalConfig = null

    if (userId) {
      userMapping = await userConfigService.getModelMapping(userId)
      systemPromptConfig = await userConfigService.getSystemPrompt(userId)
    }

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
      // Claude模型需要映射
      targetModel = userMapping[model]
      if (!targetModel && globalConfig?.geminiDirectGlobalMapping) {
        targetModel = globalConfig.geminiDirectGlobalMapping[model]
      }
      if (!targetModel) {
        targetModel = this.modelMapping[model] || config.claudeToGeminiConversion?.defaultGeminiModel
      }
    }

    if (!systemPromptConfig && globalConfig?.geminiDirectGlobalSystemPrompt?.prompt) {
      systemPromptConfig = globalConfig.geminiDirectGlobalSystemPrompt
    }

    logger.info(`[GeminiDirect] Counting tokens for model ${model} -> ${targetModel}`)

    // 2. 选择账号 (借用 Unified Scheduler)
    const sessionHash = sessionHelper.generateSessionHash(req.body)
    let accountSelection
    try {
      accountSelection = await unifiedGeminiScheduler.selectAccountForApiKey(
        req.apiKey,
        sessionHash,
        targetModel,
        { allowApiAccounts: true }
      )
    } catch (error) {
      logger.error('[GeminiDirect] Account selection failed for countTokens:', error)
      // 如果没有可用账户，返回 0 而不是报错，保证流程继续
      return res.json({ input_tokens: 0 })
    }

    const { accountId, accountType } = accountSelection
    let account
    let authHeader
    let endpointBase

    if (accountType === 'gemini-api') {
      account = await geminiApiAccountService.getAccount(accountId)
      authHeader = {}
      endpointBase = account.baseUrl || GEMINI_PUBLIC_API_BASE
    } else {
      account = await geminiAccountService.getAccount(accountId)
      // OAuth Token 刷新逻辑
      if (geminiAccountService.isTokenExpired(account)) {
        await geminiAccountService.refreshAccountToken(accountId)
        account = await geminiAccountService.getAccount(accountId)
      }
      authHeader = { Authorization: `Bearer ${account.accessToken}` }
      endpointBase = GEMINI_PA_API_BASE
    }

    // 3. 转换请求体 (New Direct Pipeline)
    const geminiBody = claudeToGemini.convertRequest(req.body, systemPromptConfig, targetModel)

    // 4. 发送 countTokens 请求
    try {
      let url
      let requestData

      let modelName = targetModel
      if (
        !modelName.startsWith('models/') &&
        !modelName.startsWith('publishers/') &&
        !modelName.startsWith('projects/')
      ) {
        modelName = `models/${modelName}`
      }

      if (accountType === 'gemini-api') {
        // API Key Account: POST .../models/{model}:countTokens?key=API_KEY
        url = `${endpointBase}/${modelName}:countTokens?key=${account.apiKey}`
        requestData = this._sanitizeForApiKey(geminiBody)

        const axiosConfig = {
          method: 'POST',
          url,
          headers: {
            'Content-Type': 'application/json'
          },
          data: requestData,
          timeout: 10000 // 短超时
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

        const response = await axios(axiosConfig)
        const totalTokens = response.data.totalTokens || 0

        logger.info(`[GeminiDirect] Counted tokens: ${totalTokens}`)
        return res.json({ input_tokens: totalTokens })
      } else {
        // OAuth Account: Delegate to geminiAccountService
        const client = await geminiAccountService.getOauthClient(
          account.accessToken,
          account.refreshToken,
          account.proxy
        )

        if (!client) {
          throw new Error('Failed to create OAuth client for countTokens')
        }

        // geminiAccountService.countTokens adds 'models/' prefix automatically
        // So we must ensure the model name does NOT have it here
        let serviceModel = targetModel
        if (serviceModel.startsWith('models/')) {
          serviceModel = serviceModel.replace('models/', '')
        }

        const response = await geminiAccountService.countTokens(
          client,
          geminiBody, // Pass full body (contents, tools, systemInstruction, etc.)
          serviceModel,
          account.proxy
        )

        const totalTokens = response.totalTokens || 0
        logger.info(`[GeminiDirect] Counted tokens (via service): ${totalTokens}`)
        return res.json({ input_tokens: totalTokens })
      }
    } catch (error) {
      logger.warn('[GeminiDirect] countTokens failed, returning 0:', error.message)
      // Fallback to 0 on error
      return res.json({ input_tokens: 0 })
    }
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
        targetModel = this.modelMapping[model] || config.claudeToGeminiConversion?.defaultGeminiModel
      }
    }

    // 合并 System Prompt：如果用户没配，尝试用全局配置
    if (!systemPromptConfig && globalConfig?.geminiDirectGlobalSystemPrompt?.prompt) {
      systemPromptConfig = globalConfig.geminiDirectGlobalSystemPrompt
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

        accountId = accountSelection.accountId
        accountType = accountSelection.accountType

        let account
        let authHeader
        let endpointBase

        // 3. 获取账号详情和认证信息
        if (accountType === 'gemini-api') {
          account = await geminiApiAccountService.getAccount(accountId)
          authHeader = {} // API Key goes in query param
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
          authHeader = { Authorization: `Bearer ${accessToken}` }

          // OAuth 账户强制使用 Google Cloud Code PA API (v1internal)
          endpointBase = GEMINI_PA_API_BASE
        }

        if (!account) {
          throw new Error('Selected account not found')
        }

        // 5. 发送请���
        if (accountType === 'gemini-api') {
          // --- API Key 账户逻辑 ---
          let url
          let requestData

          let modelName = targetModel
          if (
            !modelName.startsWith('models/') &&
            !modelName.startsWith('publishers/') &&
            !modelName.startsWith('projects/')
          ) {
            modelName = `models/${modelName}`
          }

          const action = stream ? 'streamGenerateContent' : 'generateContent'
          url = `${endpointBase}/${modelName}:${action}?alt=sse&key=${account.apiKey}`

          // API Key 账户直接使用转换后的 body，但需要清洗 id
          requestData = this._sanitizeForApiKey(geminiBody)

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
          const sessionId = req.apiKey?.id || req.user?.id

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
              account.projectId || account.tempProjectId,
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
              account.projectId || account.tempProjectId,
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

        logger.error(`[GeminiDirect] Request failed (Attempt ${retries}/${MAX_RETRIES}):`, {
          message: error.message,
          status: error.response?.status,
          response: error.response?.data
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

  async _handleStreamResponse(axiosResponse, res, originalModel, apiKeyId, accountId, accountType) {
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
              const deltaContent = event.delta.text || event.delta.thinking || event.delta.signature || ''
              logger.info(
                `[GeminiDirect] Event #${eventCount} type=${event.type}, index=${event.index}, deltaType=${event.delta.type}, content="${deltaContent.substring(0, 100)}..."`
              )
            } else if (event.type === 'content_block_start' || event.type === 'content_block_stop') {
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
    // Use proper buffering to handle SSE data split across chunks
    logger.info(
      `[GeminiDirect] Starting chunk generator, dataStream type: ${typeof dataStream}, isNull: ${dataStream === null}, isUndefined: ${dataStream === undefined}`
    )

    // Debug: Check if dataStream is iterable
    if (dataStream) {
      logger.info(
        `[GeminiDirect] dataStream constructor: ${dataStream.constructor?.name || 'unknown'}`
      )
      logger.info(
        `[GeminiDirect] dataStream has on: ${typeof dataStream.on}, has pipe: ${typeof dataStream.pipe}`
      )

      // Add event listeners to debug stream behavior
      let streamEnded = false
      let streamErrored = false
      dataStream.on('end', () => {
        streamEnded = true
        logger.info('[GeminiDirect] dataStream "end" event fired')
      })
      dataStream.on('close', () => {
        logger.info('[GeminiDirect] dataStream "close" event fired')
      })
      dataStream.on('error', (err) => {
        streamErrored = true
        logger.error('[GeminiDirect] dataStream "error" event:', err)
      })

      // Check if stream is already ended
      if (dataStream.readableEnded) {
        logger.warn(
          '[GeminiDirect] WARNING: dataStream.readableEnded is already true before iteration!'
        )
      }
      if (dataStream.destroyed) {
        logger.warn(
          '[GeminiDirect] WARNING: dataStream.destroyed is already true before iteration!'
        )
      }
    }

    // Proper SSE parsing with cross-chunk buffering
    let buffer = ''
    let rawChunkCount = 0
    let totalRawBytes = 0
    let yieldCount = 0
    const decoder = new StringDecoder('utf8')

    try {
      logger.info('[GeminiDirect] Entering for-await loop on dataStream...')
      for await (const rawChunk of dataStream) {
        rawChunkCount++
        // CRITICAL: Use StringDecoder to handle multi-byte characters split across chunks
        const chunkStr = decoder.write(rawChunk)
        totalRawBytes += rawChunk.length
        logger.info(
          `[GeminiDirect] Raw chunk #${rawChunkCount}: length=${chunkStr.length}, first100chars=${chunkStr.substring(0, 100).replace(/\n/g, '\\n')}`
        )

        // Append to buffer
        buffer += chunkStr

        // Split by double newline (SSE event separator)
        const parts = buffer.split('\n\n')

        // Keep the last part in buffer (might be incomplete)
        buffer = parts.pop() || ''

        // Process complete events
        for (const part of parts) {
          const lines = part.split('\n')
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim()
              if (data && data !== '[DONE]') {
                try {
                  yieldCount++
                  yield JSON.parse(data)
                } catch (e) {
                  logger.debug(
                    '[GeminiDirect] Failed to parse JSON:',
                    e.message,
                    'data:',
                    data.substring(0, 100)
                  )
                }
              }
            }
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        const lines = buffer.split('\n')
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data && data !== '[DONE]') {
              try {
                yieldCount++
                yield JSON.parse(data)
              } catch (e) {
                logger.debug('[GeminiDirect] Failed to parse remaining JSON:', e.message)
              }
            }
          }
        }
      }
    } catch (streamError) {
      logger.error('[GeminiDirect] Stream iteration error:', streamError)
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
