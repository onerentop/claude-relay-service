/**
 * 统一混合调度器
 * 在 Gemini Direct 模式下，合并 Claude 和 Gemini 账户池进行统一调度
 *
 * 支持的账户类型：
 * - claude-official: Claude 官方 API OAuth 账户
 * - claude-console: Claude Console 网页版账户
 * - bedrock: AWS Bedrock 账户
 * - ccr: CCR 服务账户
 * - gemini: Gemini OAuth 账户
 * - gemini-api: Gemini API Key 账户
 */

const claudeAccountService = require('./claudeAccountService')
const claudeConsoleAccountService = require('./claudeConsoleAccountService')
const bedrockAccountService = require('./bedrockAccountService')
const ccrAccountService = require('./ccrAccountService')
const geminiAccountService = require('./geminiAccountService')
const geminiApiAccountService = require('./geminiApiAccountService')
const accountGroupService = require('./accountGroupService')
const redis = require('../models/redis')
const logger = require('../utils/logger')

class UnifiedMixedScheduler {
  constructor() {
    this.SESSION_MAPPING_PREFIX = 'unified_mixed_session_mapping:'
  }

  // 🔧 辅助方法：检查账户是否可调度（兼容字符串和布尔值）
  _isSchedulable(schedulable) {
    if (schedulable === undefined || schedulable === null) {
      return true
    }
    return schedulable !== false && schedulable !== 'false'
  }

  // 🔧 辅助方法：检查账户是否激活（兼容字符串和布尔值）
  _isActive(isActive) {
    return isActive === true || isActive === 'true'
  }

  /**
   * 🎯 统一混合调度入口 - 在 Claude 和 Gemini 账户之间选择
   * @param {Object} apiKeyData - API Key 数据
   * @param {string} sessionHash - 会话哈希
   * @param {string} requestedModel - 请求的模型名称
   * @param {Object} options - 选项 { allowApiAccounts: boolean }
   * @returns {Object} { accountId, accountType }
   */
  async selectAccountForApiKey(
    apiKeyData,
    sessionHash = null,
    requestedModel = null,
    options = {}
  ) {
    const { allowApiAccounts = true } = options

    try {
      // 0. 检查 API Key 是否绑定了分组（Claude 或 Gemini）
      const claudeGroupId = this._extractGroupId(apiKeyData.claudeAccountId)
      const geminiGroupId = this._extractGroupId(apiKeyData.geminiAccountId)

      if (claudeGroupId || geminiGroupId) {
        // 绑定了分组，使用分组调度
        logger.info(
          `👥 [MixedScheduler] API Key ${apiKeyData.name} bound to group(s): Claude=${claudeGroupId || 'none'}, Gemini=${geminiGroupId || 'none'}`
        )
        return await this._selectAccountFromGroups(
          apiKeyData,
          sessionHash,
          requestedModel,
          claudeGroupId,
          geminiGroupId,
          allowApiAccounts
        )
      }

      // 未绑定分组，使用共享池调度
      logger.info(`📦 [MixedScheduler] API Key ${apiKeyData.name} using shared pool`)

      // 1. 检查会话粘性映射
      if (sessionHash) {
        const mappedAccount = await this._getSessionMapping(sessionHash)
        if (mappedAccount) {
          const isAvailable = await this._isAccountAvailable(
            mappedAccount.accountId,
            mappedAccount.accountType,
            requestedModel
          )
          if (isAvailable) {
            await this._extendSessionMappingTTL(sessionHash)
            logger.info(
              `🎯 [MixedScheduler] Using sticky session account: ${mappedAccount.accountId} (${mappedAccount.accountType}) for session ${sessionHash}`
            )
            // 更新账户的最后使用时间
            await this._markAccountUsed(mappedAccount.accountId, mappedAccount.accountType)
            return mappedAccount
          } else {
            logger.warn(
              `⚠️ [MixedScheduler] Mapped account ${mappedAccount.accountId} (${mappedAccount.accountType}) is no longer available, selecting new account`
            )
            await this._deleteSessionMapping(sessionHash)
          }
        }
      }

      // 2. 获取共享池中的可用账户（Claude + Gemini 混合）
      const availableAccounts = await this._getAllAvailableMixedAccounts(
        apiKeyData,
        requestedModel,
        allowApiAccounts
      )

      if (availableAccounts.length === 0) {
        throw new Error('No available accounts (neither Claude nor Gemini)')
      }

      // 3. 按统一优先级排序
      const sortedAccounts = this._sortAccountsByPriority(availableAccounts)
      const selectedAccount = sortedAccounts[0]

      // 4. 建立会话映射
      if (sessionHash) {
        await this._setSessionMapping(
          sessionHash,
          selectedAccount.accountId,
          selectedAccount.accountType
        )
        logger.info(
          `🎯 [MixedScheduler] Created new sticky session mapping: ${selectedAccount.name || selectedAccount.accountId} (${selectedAccount.accountType}) for session ${sessionHash}`
        )
      }

      logger.info(
        `🎯 [MixedScheduler] Selected account: ${selectedAccount.name || selectedAccount.accountId} (${selectedAccount.accountType}) with priority ${selectedAccount.priority} for API key ${apiKeyData.name}`
      )

      // 5. 更新账户的最后使用时间
      await this._markAccountUsed(selectedAccount.accountId, selectedAccount.accountType)

      return {
        accountId: selectedAccount.accountId,
        accountType: selectedAccount.accountType
      }
    } catch (error) {
      logger.error('[MixedScheduler] Failed to select account:', error)
      throw error
    }
  }

  /**
   * 📋 获取所有可用账户（合并 Claude + Gemini）
   */
  async _getAllAvailableMixedAccounts(apiKeyData, requestedModel = null, allowApiAccounts = true) {
    const availableAccounts = []

    // 并行获取所有账户类型
    const [geminiAccounts, claudeAccounts] = await Promise.all([
      this._getAvailableGeminiAccounts(apiKeyData, requestedModel, allowApiAccounts),
      this._getAvailableClaudeAccounts(apiKeyData, requestedModel)
    ])

    availableAccounts.push(...geminiAccounts)
    availableAccounts.push(...claudeAccounts)

    logger.info(
      `📊 [MixedScheduler] Total available accounts: ${availableAccounts.length} ` +
        `(Gemini: ${geminiAccounts.length}, Claude: ${claudeAccounts.length})`
    )

    return availableAccounts
  }

  /**
   * 🌐 获取可用的 Gemini 账户
   */
  async _getAvailableGeminiAccounts(apiKeyData, requestedModel = null, allowApiAccounts = true) {
    const availableAccounts = []

    try {
      // 获取所有 Gemini OAuth 账户（共享池）
      const geminiAccounts = await geminiAccountService.getAllAccounts()
      for (const account of geminiAccounts) {
        if (
          this._isActive(account.isActive) &&
          account.status !== 'error' &&
          (account.accountType === 'shared' || !account.accountType) &&
          this._isSchedulable(account.schedulable)
        ) {
          // 检查 token 是否过期
          const isExpired = geminiAccountService.isTokenExpired(account)
          if (isExpired && !account.refreshToken) {
            continue
          }

          // 检查模型支持
          if (requestedModel && account.supportedModels && account.supportedModels.length > 0) {
            const normalizedModel = requestedModel.replace('models/', '')
            const modelSupported = account.supportedModels.some(
              (model) => model.replace('models/', '') === normalizedModel
            )
            if (!modelSupported) {
              continue
            }
          }

          // 检查是否被限流
          const isRateLimited = await this._isGeminiAccountRateLimited(account.id, 'gemini')
          if (!isRateLimited) {
            availableAccounts.push({
              ...account,
              accountId: account.id,
              accountType: 'gemini',
              priority: parseInt(account.priority) || 50,
              lastUsedAt: account.lastUsedAt || '0'
            })
          }
        }
      }

      // 如果允许 API 账户，获取 Gemini API 账户
      if (allowApiAccounts) {
        const geminiApiAccounts = await geminiApiAccountService.getAllAccounts()
        for (const account of geminiApiAccounts) {
          if (
            this._isActive(account.isActive) &&
            account.status !== 'error' &&
            (account.accountType === 'shared' || !account.accountType) &&
            this._isSchedulable(account.schedulable)
          ) {
            // 检查模型支持
            if (requestedModel && account.supportedModels && account.supportedModels.length > 0) {
              const normalizedModel = requestedModel.replace('models/', '')
              const modelSupported = account.supportedModels.some(
                (model) => model.replace('models/', '') === normalizedModel
              )
              if (!modelSupported) {
                continue
              }
            }

            // 检查是否被限流
            const isRateLimited = await this._isGeminiAccountRateLimited(account.id, 'gemini-api')
            if (!isRateLimited) {
              availableAccounts.push({
                ...account,
                accountId: account.id,
                accountType: 'gemini-api',
                priority: parseInt(account.priority) || 50,
                lastUsedAt: account.lastUsedAt || '0'
              })
            }
          }
        }
      }
    } catch (error) {
      logger.error('[MixedScheduler] Error getting Gemini accounts:', error)
    }

    return availableAccounts
  }

  /**
   * 🤖 获取可用的 Claude 账户（所有类型）
   */
  async _getAvailableClaudeAccounts(apiKeyData, _requestedModel = null) {
    const availableAccounts = []

    try {
      // 1. 获取 Claude Official 账户 - 使用缓存版本提升性能
      const claudeAccounts = await claudeAccountService.getAllAccountsCached()
      logger.info(`[MixedScheduler] Found ${claudeAccounts.length} Claude Official accounts`)

      for (const account of claudeAccounts) {
        logger.info(
          `[MixedScheduler] Checking Official account: ${account.name} - isActive: ${account.isActive}, status: ${account.status}, accountType: ${account.accountType}, schedulable: ${account.schedulable}`
        )

        if (
          account.isActive === 'true' &&
          account.status !== 'error' &&
          account.status !== 'blocked' &&
          account.status !== 'temp_error' &&
          (account.accountType === 'shared' || !account.accountType) &&
          this._isSchedulable(account.schedulable)
        ) {
          // 检查是否被限流
          const isRateLimited = await claudeAccountService.isAccountRateLimited(account.id)
          if (isRateLimited) {
            logger.debug(`[MixedScheduler] Official account ${account.name} is rate limited`)
            continue
          }

          // 检查是否过载
          const isOverloaded = await claudeAccountService.isAccountOverloaded(account.id)
          if (isOverloaded) {
            logger.debug(`[MixedScheduler] Official account ${account.name} is overloaded`)
            continue
          }

          availableAccounts.push({
            ...account,
            accountId: account.id,
            accountType: 'claude-official',
            priority: parseInt(account.priority) || 50,
            lastUsedAt: account.lastUsedAt || '0'
          })
          logger.info(`[MixedScheduler] Added Official account: ${account.name}`)
        }
      }

      // 2. 获取 Claude Console 账户
      const consoleAccounts = await claudeConsoleAccountService.getAllAccounts()
      logger.info(`[MixedScheduler] Found ${consoleAccounts.length} Claude Console accounts`)
      const accountsNeedingConcurrencyCheck = []

      for (const account of consoleAccounts) {
        logger.info(
          `[MixedScheduler] Checking Console account: ${account.name} - isActive: ${account.isActive}, status: ${account.status}, accountType: ${account.accountType}, schedulable: ${account.schedulable}`
        )

        // 与 unifiedClaudeScheduler 保持一致的条件
        if (
          account.isActive === true &&
          account.status === 'active' &&
          account.accountType === 'shared' &&
          this._isSchedulable(account.schedulable)
        ) {
          // 检查订阅是否过期
          if (claudeConsoleAccountService.isSubscriptionExpired(account)) {
            logger.debug(`[MixedScheduler] Console account ${account.name} subscription expired`)
            continue
          }

          // 检查是否被限流或额度超限
          const isRateLimited = await claudeConsoleAccountService.isAccountRateLimited(account.id)
          const isQuotaExceeded = await claudeConsoleAccountService.isAccountQuotaExceeded(
            account.id
          )

          if (!isRateLimited && !isQuotaExceeded) {
            if (account.maxConcurrentTasks > 0) {
              accountsNeedingConcurrencyCheck.push(account)
            } else {
              availableAccounts.push({
                ...account,
                accountId: account.id,
                accountType: 'claude-console',
                priority: parseInt(account.priority) || 50,
                lastUsedAt: account.lastUsedAt || '0'
              })
              logger.info(`[MixedScheduler] Added Console account: ${account.name}`)
            }
          } else {
            logger.debug(
              `[MixedScheduler] Console account ${account.name} rate limited or quota exceeded`
            )
          }
        }
      }

      // 批量并发检查
      if (accountsNeedingConcurrencyCheck.length > 0) {
        logger.debug(
          `[MixedScheduler] Checking concurrency for ${accountsNeedingConcurrencyCheck.length} Console accounts`
        )
        const concurrencyResults = await Promise.all(
          accountsNeedingConcurrencyCheck.map((account) =>
            redis.getConsoleAccountConcurrency(account.id).then((currentConcurrency) => ({
              account,
              currentConcurrency
            }))
          )
        )

        for (const { account, currentConcurrency } of concurrencyResults) {
          if (currentConcurrency < account.maxConcurrentTasks) {
            availableAccounts.push({
              ...account,
              accountId: account.id,
              accountType: 'claude-console',
              priority: parseInt(account.priority) || 50,
              lastUsedAt: account.lastUsedAt || '0'
            })
            logger.info(
              `[MixedScheduler] Added Console account: ${account.name} (concurrency: ${currentConcurrency}/${account.maxConcurrentTasks})`
            )
          } else {
            logger.debug(
              `[MixedScheduler] Console account ${account.name} at concurrency limit: ${currentConcurrency}/${account.maxConcurrentTasks}`
            )
          }
        }
      }

      // 3. 获取 Bedrock 账户
      const bedrockAccountsResult = await bedrockAccountService.getAllAccounts()
      const bedrockAccounts = bedrockAccountsResult.success ? bedrockAccountsResult.data : []
      logger.debug(`[MixedScheduler] Found ${bedrockAccounts.length} Bedrock accounts`)

      for (const account of bedrockAccounts) {
        if (
          account.isActive === true &&
          account.accountType === 'shared' &&
          this._isSchedulable(account.schedulable)
        ) {
          availableAccounts.push({
            ...account,
            accountId: account.id,
            accountType: 'bedrock',
            priority: parseInt(account.priority) || 50,
            lastUsedAt: account.lastUsedAt || '0'
          })
          logger.info(`[MixedScheduler] Added Bedrock account: ${account.name}`)
        }
      }

      // 4. 获取 CCR 账户
      const ccrAccounts = await ccrAccountService.getAllAccounts()
      logger.debug(`[MixedScheduler] Found ${ccrAccounts.length} CCR accounts`)

      for (const account of ccrAccounts) {
        if (
          account.isActive === true &&
          account.status === 'active' &&
          account.accountType === 'shared' &&
          this._isSchedulable(account.schedulable)
        ) {
          // 检查订阅是否过期
          if (ccrAccountService.isSubscriptionExpired(account)) {
            logger.debug(`[MixedScheduler] CCR account ${account.name} subscription expired`)
            continue
          }

          // 检查是否被限流或额度超限
          const isRateLimited = await ccrAccountService.isAccountRateLimited(account.id)
          const isQuotaExceeded = await ccrAccountService.isAccountQuotaExceeded(account.id)

          if (!isRateLimited && !isQuotaExceeded) {
            availableAccounts.push({
              ...account,
              accountId: account.id,
              accountType: 'ccr',
              priority: parseInt(account.priority) || 50,
              lastUsedAt: account.lastUsedAt || '0'
            })
            logger.info(`[MixedScheduler] Added CCR account: ${account.name}`)
          }
        }
      }
    } catch (error) {
      logger.error('[MixedScheduler] Error getting Claude accounts:', error)
    }

    return availableAccounts
  }

  /**
   * 🔢 按优先级和最后使用时间排序账户
   */
  _sortAccountsByPriority(accounts) {
    return accounts.sort((a, b) => {
      // 首先按优先级排序（数字越小优先级越高）
      if (a.priority !== b.priority) {
        return a.priority - b.priority
      }

      // 优先级相同时，按最后使用时间排序（最久未使用的优先）
      const aLastUsed = new Date(a.lastUsedAt || 0).getTime()
      const bLastUsed = new Date(b.lastUsedAt || 0).getTime()
      return aLastUsed - bLastUsed
    })
  }

  /**
   * 🔍 检查账户是否可用
   */
  async _isAccountAvailable(accountId, accountType, _requestedModel = null) {
    try {
      // Gemini 账户
      if (accountType === 'gemini') {
        const account = await geminiAccountService.getAccount(accountId)
        if (!account || !this._isActive(account.isActive) || account.status === 'error') {
          return false
        }
        if (!this._isSchedulable(account.schedulable)) {
          return false
        }
        return !(await this._isGeminiAccountRateLimited(accountId, 'gemini'))
      }

      if (accountType === 'gemini-api') {
        const account = await geminiApiAccountService.getAccount(accountId)
        if (!account || !this._isActive(account.isActive) || account.status === 'error') {
          return false
        }
        if (!this._isSchedulable(account.schedulable)) {
          return false
        }
        return !(await this._isGeminiAccountRateLimited(accountId, 'gemini-api'))
      }

      // Claude Official
      if (accountType === 'claude-official') {
        const account = await redis.getClaudeAccount(accountId)
        if (
          !account ||
          account.isActive !== 'true' ||
          account.status === 'error' ||
          account.status === 'temp_error'
        ) {
          return false
        }
        if (!this._isSchedulable(account.schedulable)) {
          return false
        }
        const isRateLimited = await claudeAccountService.isAccountRateLimited(accountId)
        const isOverloaded = await claudeAccountService.isAccountOverloaded(accountId)
        return !isRateLimited && !isOverloaded
      }

      // Claude Console
      if (accountType === 'claude-console') {
        const account = await claudeConsoleAccountService.getAccount(accountId)
        if (!account || !this._isActive(account.isActive) || account.status === 'error') {
          return false
        }
        if (!this._isSchedulable(account.schedulable)) {
          return false
        }
        if (claudeConsoleAccountService.isSubscriptionExpired(account)) {
          return false
        }
        const isRateLimited = await claudeConsoleAccountService.isAccountRateLimited(accountId)
        const isQuotaExceeded = await claudeConsoleAccountService.isAccountQuotaExceeded(accountId)
        if (isRateLimited || isQuotaExceeded) {
          return false
        }
        // 检查并发
        if (account.maxConcurrentTasks > 0) {
          const currentConcurrency = await redis.getConsoleAccountConcurrency(accountId)
          if (currentConcurrency >= account.maxConcurrentTasks) {
            return false
          }
        }
        return true
      }

      // Bedrock
      if (accountType === 'bedrock') {
        const result = await bedrockAccountService.getAccount(accountId)
        if (!result.success || result.data.isActive !== true) {
          return false
        }
        return this._isSchedulable(result.data.schedulable)
      }

      // CCR
      if (accountType === 'ccr') {
        const account = await ccrAccountService.getAccount(accountId)
        if (!account || account.isActive !== true || account.status !== 'active') {
          return false
        }
        if (!this._isSchedulable(account.schedulable)) {
          return false
        }
        if (ccrAccountService.isSubscriptionExpired(account)) {
          return false
        }
        const isRateLimited = await ccrAccountService.isAccountRateLimited(accountId)
        const isQuotaExceeded = await ccrAccountService.isAccountQuotaExceeded(accountId)
        return !isRateLimited && !isQuotaExceeded
      }

      return false
    } catch (error) {
      logger.warn(`[MixedScheduler] Failed to check account availability: ${accountId}`, error)
      return false
    }
  }

  /**
   * 🔗 获取会话映射
   */
  async _getSessionMapping(sessionHash) {
    const client = redis.getClientSafe()
    const mappingData = await client.get(`${this.SESSION_MAPPING_PREFIX}${sessionHash}`)

    if (mappingData) {
      try {
        return JSON.parse(mappingData)
      } catch (error) {
        logger.warn('[MixedScheduler] Failed to parse session mapping:', error)
        return null
      }
    }
    return null
  }

  /**
   * 💾 设置会话映射
   */
  async _setSessionMapping(sessionHash, accountId, accountType) {
    const client = redis.getClientSafe()
    const mappingData = JSON.stringify({ accountId, accountType })
    const appConfig = require('../../config/config')
    const ttlHours = appConfig.session?.stickyTtlHours || 1
    const ttlSeconds = Math.max(1, Math.floor(ttlHours * 60 * 60))
    await client.setex(`${this.SESSION_MAPPING_PREFIX}${sessionHash}`, ttlSeconds, mappingData)
  }

  /**
   * 🗑️ 删除会话映射
   */
  async _deleteSessionMapping(sessionHash) {
    const client = redis.getClientSafe()
    await client.del(`${this.SESSION_MAPPING_PREFIX}${sessionHash}`)
  }

  /**
   * 🔄 清除会话映射（公开方法）
   */
  async clearSessionMapping(sessionHash) {
    await this._deleteSessionMapping(sessionHash)
  }

  /**
   * 🔁 续期会话映射 TTL
   */
  async _extendSessionMappingTTL(sessionHash) {
    try {
      const client = redis.getClientSafe()
      const key = `${this.SESSION_MAPPING_PREFIX}${sessionHash}`
      const remainingTTL = await client.ttl(key)

      if (remainingTTL === -2) {
        return false
      }
      if (remainingTTL === -1) {
        return true
      }

      const appConfig = require('../../config/config')
      const ttlHours = appConfig.session?.stickyTtlHours || 1
      const renewalThresholdMinutes = appConfig.session?.renewalThresholdMinutes || 0
      if (!renewalThresholdMinutes) {
        return true
      }

      const fullTTL = Math.max(1, Math.floor(ttlHours * 60 * 60))
      const threshold = Math.max(0, Math.floor(renewalThresholdMinutes * 60))

      if (remainingTTL < threshold) {
        await client.expire(key, fullTTL)
        logger.debug(
          `🔄 [MixedScheduler] Renewed session TTL: ${sessionHash} (was ${Math.round(remainingTTL / 60)}m, renewed to ${ttlHours}h)`
        )
      }
      return true
    } catch (error) {
      logger.error('[MixedScheduler] Failed to extend session TTL:', error)
      return false
    }
  }

  /**
   * 📝 更新账户最后使用时间
   */
  async _markAccountUsed(accountId, accountType) {
    try {
      const now = new Date().toISOString()
      if (accountType === 'gemini') {
        await geminiAccountService.markAccountUsed(accountId)
      } else if (accountType === 'gemini-api') {
        await geminiApiAccountService.markAccountUsed(accountId)
      } else if (accountType === 'claude-official') {
        // Claude 账户服务没有 markAccountUsed 方法，使用 updateAccount
        await claudeAccountService.updateAccount(accountId, { lastUsedAt: now })
      } else if (accountType === 'claude-console') {
        await claudeConsoleAccountService.updateAccount(accountId, { lastUsedAt: now })
      } else if (accountType === 'bedrock') {
        await bedrockAccountService.updateAccount(accountId, { lastUsedAt: now })
      } else if (accountType === 'ccr') {
        await ccrAccountService.updateAccount(accountId, { lastUsedAt: now })
      }
    } catch (error) {
      logger.warn(`[MixedScheduler] Failed to mark account used: ${accountId}`, error)
    }
  }

  /**
   * 🔍 检查 Gemini 账户是否限流
   */
  async _isGeminiAccountRateLimited(accountId, accountType) {
    try {
      let account = null
      if (accountType === 'gemini-api') {
        account = await geminiApiAccountService.getAccount(accountId)
      } else {
        account = await geminiAccountService.getAccount(accountId)
      }

      if (!account) {
        return false
      }

      if (account.rateLimitStatus === 'limited' && account.rateLimitedAt) {
        const limitedAt = new Date(account.rateLimitedAt).getTime()
        const now = Date.now()
        const rateLimitDuration = parseInt(account.rateLimitDuration) || 60
        const limitDuration = rateLimitDuration * 60 * 1000
        return now < limitedAt + limitDuration
      }
      return false
    } catch (error) {
      logger.error(`[MixedScheduler] Failed to check Gemini rate limit: ${accountId}`, error)
      return false
    }
  }

  /**
   * 🚫 标记账户为限流状态
   */
  async markAccountRateLimited(accountId, accountType, sessionHash = null) {
    try {
      if (accountType === 'gemini') {
        await geminiAccountService.setAccountRateLimited(accountId, true)
      } else if (accountType === 'gemini-api') {
        await geminiApiAccountService.setAccountRateLimited(accountId, true)
      } else if (accountType === 'claude-official') {
        await claudeAccountService.setAccountRateLimited(accountId, true)
      } else if (accountType === 'claude-console') {
        await claudeConsoleAccountService.setAccountRateLimited(accountId, true)
      } else if (accountType === 'ccr') {
        await ccrAccountService.setAccountRateLimited(accountId, true)
      }

      // 删除会话映射，下次请求重新选择账户
      if (sessionHash) {
        await this._deleteSessionMapping(sessionHash)
      }

      logger.info(
        `🚫 [MixedScheduler] Marked account as rate limited: ${accountId} (${accountType})`
      )
      return { success: true }
    } catch (error) {
      logger.error(
        `[MixedScheduler] Failed to mark account as rate limited: ${accountId} (${accountType})`,
        error
      )
      throw error
    }
  }

  /**
   * ✅ 移除账户的限流状态
   */
  async removeAccountRateLimit(accountId, accountType) {
    try {
      if (accountType === 'gemini') {
        await geminiAccountService.setAccountRateLimited(accountId, false)
      } else if (accountType === 'gemini-api') {
        await geminiApiAccountService.setAccountRateLimited(accountId, false)
      } else if (accountType === 'claude-official') {
        await claudeAccountService.setAccountRateLimited(accountId, false)
      } else if (accountType === 'claude-console') {
        await claudeConsoleAccountService.setAccountRateLimited(accountId, false)
      } else if (accountType === 'ccr') {
        await ccrAccountService.setAccountRateLimited(accountId, false)
      }

      logger.info(
        `✅ [MixedScheduler] Removed rate limit for account: ${accountId} (${accountType})`
      )
      return { success: true }
    } catch (error) {
      logger.error(
        `[MixedScheduler] Failed to remove rate limit for account: ${accountId} (${accountType})`,
        error
      )
      throw error
    }
  }

  /**
   * 🔍 从 accountId 中提取分组 ID
   */
  _extractGroupId(accountId) {
    if (!accountId) {
      return null
    }
    if (accountId.startsWith('group:')) {
      return accountId.replace('group:', '')
    }
    return null
  }

  /**
   * 👥 从分组中选择账户（支持 Claude + Gemini 混合分组调度）
   */
  async _selectAccountFromGroups(
    apiKeyData,
    sessionHash,
    requestedModel,
    claudeGroupId,
    geminiGroupId,
    allowApiAccounts
  ) {
    try {
      // 1. 检查会话粘性映射
      if (sessionHash) {
        const mappedAccount = await this._getSessionMapping(sessionHash)
        if (mappedAccount) {
          // 验证映射的账户是否属于某个分组
          let belongsToGroup = false

          if (claudeGroupId) {
            const claudeMembers = await accountGroupService.getGroupMembers(claudeGroupId)
            if (claudeMembers.includes(mappedAccount.accountId)) {
              belongsToGroup = true
            }
          }

          if (!belongsToGroup && geminiGroupId) {
            const geminiMembers = await accountGroupService.getGroupMembers(geminiGroupId)
            if (geminiMembers.includes(mappedAccount.accountId)) {
              belongsToGroup = true
            }
          }

          if (belongsToGroup) {
            const isAvailable = await this._isAccountAvailable(
              mappedAccount.accountId,
              mappedAccount.accountType,
              requestedModel
            )
            if (isAvailable) {
              await this._extendSessionMappingTTL(sessionHash)
              logger.info(
                `🎯 [MixedScheduler] Using sticky session account from group: ${mappedAccount.accountId} (${mappedAccount.accountType})`
              )
              await this._markAccountUsed(mappedAccount.accountId, mappedAccount.accountType)
              return mappedAccount
            }
          }
          // 映射的账户不可用或不在分组中
          await this._deleteSessionMapping(sessionHash)
        }
      }

      // 2. 获取分组内的所有可用账户
      const availableAccounts = []

      // 2.1 从 Claude 分组获取账户
      if (claudeGroupId) {
        const claudeGroup = await accountGroupService.getGroup(claudeGroupId)
        if (claudeGroup) {
          logger.info(`👥 [MixedScheduler] Loading Claude group: ${claudeGroup.name}`)
          const memberIds = await accountGroupService.getGroupMembers(claudeGroupId)

          for (const memberId of memberIds) {
            const accountInfo = await this._getGroupMemberAccount(memberId, 'claude')
            if (accountInfo) {
              const isAvailable = await this._isAccountAvailable(
                accountInfo.accountId,
                accountInfo.accountType,
                requestedModel
              )
              if (isAvailable) {
                availableAccounts.push(accountInfo)
                logger.info(
                  `[MixedScheduler] Added group member: ${accountInfo.name || accountInfo.accountId} (${accountInfo.accountType})`
                )
              }
            }
          }
        }
      }

      // 2.2 从 Gemini 分组获取账户
      if (geminiGroupId) {
        const geminiGroup = await accountGroupService.getGroup(geminiGroupId)
        if (geminiGroup) {
          logger.info(`👥 [MixedScheduler] Loading Gemini group: ${geminiGroup.name}`)
          const memberIds = await accountGroupService.getGroupMembers(geminiGroupId)

          for (const memberId of memberIds) {
            const accountInfo = await this._getGroupMemberAccount(
              memberId,
              'gemini',
              allowApiAccounts
            )
            if (accountInfo) {
              const isAvailable = await this._isAccountAvailable(
                accountInfo.accountId,
                accountInfo.accountType,
                requestedModel
              )
              if (isAvailable) {
                availableAccounts.push(accountInfo)
                logger.info(
                  `[MixedScheduler] Added group member: ${accountInfo.name || accountInfo.accountId} (${accountInfo.accountType})`
                )
              }
            }
          }
        }
      }

      logger.info(`📊 [MixedScheduler] Group accounts available: ${availableAccounts.length}`)

      if (availableAccounts.length === 0) {
        throw new Error('No available accounts in group(s)')
      }

      // 3. 按优先级排序选择
      const sortedAccounts = this._sortAccountsByPriority(availableAccounts)
      const selectedAccount = sortedAccounts[0]

      // 4. 建立会话映射
      if (sessionHash) {
        await this._setSessionMapping(
          sessionHash,
          selectedAccount.accountId,
          selectedAccount.accountType
        )
      }

      logger.info(
        `🎯 [MixedScheduler] Selected from group: ${selectedAccount.name || selectedAccount.accountId} (${selectedAccount.accountType})`
      )

      await this._markAccountUsed(selectedAccount.accountId, selectedAccount.accountType)

      return {
        accountId: selectedAccount.accountId,
        accountType: selectedAccount.accountType
      }
    } catch (error) {
      logger.error('[MixedScheduler] Group selection failed:', error)
      throw error
    }
  }

  /**
   * 🔍 获取分组成员账户信息
   */
  async _getGroupMemberAccount(memberId, platform, allowApiAccounts = true) {
    try {
      if (platform === 'claude') {
        // 尝试 Claude Official
        let account = await redis.getClaudeAccount(memberId)
        if (account?.id) {
          return {
            ...account,
            accountId: account.id,
            accountType: 'claude-official',
            priority: parseInt(account.priority) || 50,
            lastUsedAt: account.lastUsedAt || '0'
          }
        }

        // 尝试 Claude Console
        account = await claudeConsoleAccountService.getAccount(memberId)
        if (account) {
          return {
            ...account,
            accountId: account.id,
            accountType: 'claude-console',
            priority: parseInt(account.priority) || 50,
            lastUsedAt: account.lastUsedAt || '0'
          }
        }

        // 尝试 Bedrock
        const bedrockResult = await bedrockAccountService.getAccount(memberId)
        if (bedrockResult.success) {
          return {
            ...bedrockResult.data,
            accountId: bedrockResult.data.id,
            accountType: 'bedrock',
            priority: parseInt(bedrockResult.data.priority) || 50,
            lastUsedAt: bedrockResult.data.lastUsedAt || '0'
          }
        }

        // 尝试 CCR
        account = await ccrAccountService.getAccount(memberId)
        if (account) {
          return {
            ...account,
            accountId: account.id,
            accountType: 'ccr',
            priority: parseInt(account.priority) || 50,
            lastUsedAt: account.lastUsedAt || '0'
          }
        }
      } else if (platform === 'gemini') {
        // 尝试 Gemini OAuth
        let account = await geminiAccountService.getAccount(memberId)
        if (account) {
          return {
            ...account,
            accountId: account.id,
            accountType: 'gemini',
            priority: parseInt(account.priority) || 50,
            lastUsedAt: account.lastUsedAt || '0'
          }
        }

        // 尝试 Gemini API
        if (allowApiAccounts) {
          account = await geminiApiAccountService.getAccount(memberId)
          if (account) {
            return {
              ...account,
              accountId: account.id,
              accountType: 'gemini-api',
              priority: parseInt(account.priority) || 50,
              lastUsedAt: account.lastUsedAt || '0'
            }
          }
        }
      }

      return null
    } catch (error) {
      logger.warn(`[MixedScheduler] Failed to get group member account: ${memberId}`, error)
      return null
    }
  }
}

module.exports = new UnifiedMixedScheduler()
