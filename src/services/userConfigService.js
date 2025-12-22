const redisClient = require('../models/redis')
const logger = require('../utils/logger')
const LRUCache = require('../utils/lruCache')

class UserConfigService {
  constructor() {
    this.redis = redisClient.client
    // L1 Cache: 500 items, default TTL handled by setter
    this.cache = new LRUCache(500)
  }

  _getKey(userId, type) {
    return `user_config:${userId}:${type}`
  }

  /**
   * Get model mapping configuration for a user
   * @param {string} userId - User ID
   * @returns {Promise<Object>} Model mapping object { 'claude-model': 'gemini-model' }
   */
  async getModelMapping(userId) {
    try {
      const key = this._getKey(userId, 'model_mapping')

      // 1. Check L1 Cache
      const cached = this.cache.get(key)
      if (cached !== undefined) {
        return cached
      }

      // 2. Fetch from Redis
      const mapping = await this.redis.get(key)
      const result = mapping ? JSON.parse(mapping) : {}

      // 3. Update L1 Cache (60s TTL)
      this.cache.set(key, result, 60 * 1000)

      return result
    } catch (error) {
      logger.error(`Failed to get model mapping for user ${userId}:`, error)
      return {}
    }
  }

  /**
   * Set model mapping configuration for a user
   * @param {string} userId - User ID
   * @param {Object} mapping - Model mapping object
   */
  async setModelMapping(userId, mapping) {
    try {
      const key = this._getKey(userId, 'model_mapping')
      await this.redis.set(key, JSON.stringify(mapping))

      // Update L1 Cache immediately
      this.cache.set(key, mapping, 60 * 1000)

      return true
    } catch (error) {
      logger.error(`Failed to set model mapping for user ${userId}:`, error)
      return false
    }
  }

  /**
   * Get system prompt configuration for a user
   * @param {string} userId - User ID
   * @returns {Promise<Object>} System prompt config { prompt: string, position: 'prepend'|'append' }
   */
  async getSystemPrompt(userId) {
    try {
      const key = this._getKey(userId, 'system_prompt')

      // 1. Check L1 Cache
      const cached = this.cache.get(key)
      if (cached !== undefined) {
        return cached
      }

      // 2. Fetch from Redis
      const config = await this.redis.get(key)
      const result = config ? JSON.parse(config) : { prompt: '', position: 'append' }

      // 3. Update L1 Cache (60s TTL)
      this.cache.set(key, result, 60 * 1000)

      return result
    } catch (error) {
      logger.error(`Failed to get system prompt for user ${userId}:`, error)
      return { prompt: '', position: 'append' }
    }
  }

  /**
   * Set system prompt configuration for a user
   * @param {string} userId - User ID
   * @param {string} prompt - Custom system prompt
   * @param {string} position - 'prepend' or 'append'
   */
  async setSystemPrompt(userId, prompt, position = 'append') {
    try {
      const key = this._getKey(userId, 'system_prompt')
      const config = { prompt, position }
      await this.redis.set(key, JSON.stringify(config))

      // Update L1 Cache immediately
      this.cache.set(key, config, 60 * 1000)

      return true
    } catch (error) {
      logger.error(`Failed to set system prompt for user ${userId}:`, error)
      return false
    }
  }

  /**
   * Check if Gemini direct routing is enabled for a user
   * @param {string} userId - User ID
   * @returns {Promise<boolean>}
   */
  async getGeminiDirectEnabled(userId) {
    try {
      const key = this._getKey(userId, 'gemini_direct_enabled')

      // 1. Check L1 Cache
      const cached = this.cache.get(key)
      if (cached !== undefined) {
        return cached
      }

      // 2. Fetch from Redis
      const enabled = await this.redis.get(key)
      const result = enabled === 'true'

      // 3. Update L1 Cache (60s TTL)
      this.cache.set(key, result, 60 * 1000)

      return result
    } catch (error) {
      logger.error(`Failed to get Gemini direct status for user ${userId}:`, error)
      return false
    }
  }

  /**
   * Set Gemini direct routing status for a user
   * @param {string} userId - User ID
   * @param {boolean} enabled
   */
  async setGeminiDirectEnabled(userId, enabled) {
    try {
      const key = this._getKey(userId, 'gemini_direct_enabled')
      await this.redis.set(key, String(enabled))

      // Update L1 Cache immediately
      this.cache.set(key, enabled === true || enabled === 'true', 60 * 1000)

      return true
    } catch (error) {
      logger.error(`Failed to set Gemini direct status for user ${userId}:`, error)
      return false
    }
  }
}

module.exports = new UserConfigService()
