const redisClient = require('../models/redis')
const logger = require('../utils/logger')

class UserConfigService {
  constructor() {
    this.redis = redisClient.client
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
      const mapping = await this.redis.get(key)
      return mapping ? JSON.parse(mapping) : {}
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
      const config = await this.redis.get(key)
      return config ? JSON.parse(config) : { prompt: '', position: 'append' }
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
      await this.redis.set(key, JSON.stringify({ prompt, position }))
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
      const enabled = await this.redis.get(key)
      // Default to false if not set
      return enabled === 'true'
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
      return true
    } catch (error) {
      logger.error(`Failed to set Gemini direct status for user ${userId}:`, error)
      return false
    }
  }
}

module.exports = new UserConfigService()
