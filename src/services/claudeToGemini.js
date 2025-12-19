const { v4: uuidv4 } = require('uuid')
const logger = require('../utils/logger')

/**
 * Service to handle format conversion between Claude and Gemini directly
 * Incorporates logic from musistudio/llms and claude-code-router
 */
class ClaudeToGeminiConverter {
  /**
   * Convert Claude request body to Gemini request body
   * @param {Object} claudeBody - Original Claude request body
   * @param {Object|string} systemPromptConfig - Custom system prompt config {prompt, position} or string
   * @param {string} targetModel - The target Gemini model name (e.g. "gemini-2.0-flash-exp")
   * @returns {Object} Gemini request body
   */
  convertRequest(claudeBody, systemPromptConfig = null, targetModel = '') {
    const {
      messages,
      system,
      tools,
      tool_choice,
      temperature,
      max_tokens,
      top_p,
      top_k,
      thinking,
      reasoning
    } = claudeBody

    // 1. Convert System Prompt
    // IMPORTANT: Use geminiBody.systemInstruction field for PA API compatibility
    // PA API requires systemInstruction field in request object
    let systemInstruction = ''
    if (system) {
      if (typeof system === 'string') {
        systemInstruction = system
      } else if (Array.isArray(system)) {
        systemInstruction = system.map((s) => s.text).join('\n')
      }
    }

    // Handle custom system prompt
    let customPrompt = ''
    let position = 'append'

    if (systemPromptConfig) {
      if (typeof systemPromptConfig === 'string') {
        customPrompt = systemPromptConfig
      } else if (typeof systemPromptConfig === 'object') {
        customPrompt = systemPromptConfig.prompt || ''
        position = systemPromptConfig.position || 'append'
      }
    }

    if (customPrompt) {
      if (position === 'prepend') {
        systemInstruction = systemInstruction
          ? `${customPrompt}\n\n${systemInstruction}`
          : customPrompt
      } else {
        // Default to append
        systemInstruction = systemInstruction
          ? `${systemInstruction}\n\n${customPrompt}`
          : customPrompt
      }
    }

    // 2. Convert Messages (do NOT inject system prompt as first user message)
    const contents = this._convertMessages(messages)

    // 3. Convert Tools
    let geminiTools = undefined
    let toolConfig = undefined

    const toolsToConvert = tools?.filter((t) => t.name !== 'web_search') || []

    if (tools && tools.length > 0) {
      const functionDeclarations = toolsToConvert.map((tool) => this._convertToolDefinition(tool))

      geminiTools = []
      if (functionDeclarations.length > 0) {
        // Wrap in tools object
        geminiTools.push({ functionDeclarations })
      }

      // Handle web_search -> googleSearch
      const webSearchTool = tools.find((t) => t.name === 'web_search')
      if (webSearchTool) {
        geminiTools.push({ googleSearch: {} })
      }

      // Handle tool_choice (matches llms library behavior)
      // Only set toolConfig if tool_choice is explicitly provided
      if (tool_choice) {
        if (tool_choice.type === 'auto') {
          toolConfig = { functionCallingConfig: { mode: 'auto' } }
        } else if (tool_choice.type === 'any') {
          // Gemini 'any' mode requires allowed_function_names to be specified
          const allToolNames = toolsToConvert.map((t) => t.name)
          toolConfig = {
            functionCallingConfig: {
              mode: 'any',
              allowedFunctionNames: allToolNames
            }
          }
        } else if (tool_choice.type === 'tool') {
          toolConfig = {
            functionCallingConfig: {
              mode: 'any',
              allowedFunctionNames: [tool_choice.name]
            }
          }
        } else if (tool_choice.type === 'none') {
          toolConfig = { functionCallingConfig: { mode: 'none' } }
        }
      }
      // Do NOT set default toolConfig - match llms library behavior exactly
    }

    // 4. Construct Gemini Request
    const geminiBody = {
      contents,
      generationConfig: {},
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
      ]
    }

    // Map standard generation config
    if (temperature !== undefined) {
      geminiBody.generationConfig.temperature = temperature
    }
    if (top_p !== undefined) {
      geminiBody.generationConfig.topP = top_p
    }
    if (top_k !== undefined) {
      geminiBody.generationConfig.topK = top_k
    }
    if (max_tokens !== undefined) {
      geminiBody.generationConfig.maxOutputTokens = max_tokens
    }

    // Map stop_sequences
    if (claudeBody.stop_sequences && claudeBody.stop_sequences.length > 0) {
      geminiBody.generationConfig.stopSequences = claudeBody.stop_sequences
    }

    // Handle thinking/reasoning config (Align with musistudio/llms)
    if (thinking || (reasoning && reasoning.effort)) {
      geminiBody.generationConfig.thinkingConfig = {
        includeThoughts: true
      }

      // Check target model for Gemini 3 specific logic
      const isGemini3 = targetModel && targetModel.includes('gemini-3')

      if (isGemini3) {
        // Gemini 3 uses thinkingLevel
        if (reasoning && reasoning.effort) {
          geminiBody.generationConfig.thinkingConfig.thinkingLevel = reasoning.effort.toUpperCase()
        } else if (thinking && thinking.budget_tokens) {
          // Map budget to level (Reference: llms/src/utils/thinking.ts)
          const budget = thinking.budget_tokens
          if (budget <= 1024) {
            geminiBody.generationConfig.thinkingConfig.thinkingLevel = 'LOW'
          } else if (budget <= 8192) {
            geminiBody.generationConfig.thinkingConfig.thinkingLevel = 'MEDIUM'
          } else {
            geminiBody.generationConfig.thinkingConfig.thinkingLevel = 'HIGH'
          }
        }
      } else {
        // Gemini 2 uses thinkingBudget
        const MAX_BUDGET = 32768
        if (thinking && thinking.budget_tokens) {
          let budget = thinking.budget_tokens
          if (budget > MAX_BUDGET) {
            budget = MAX_BUDGET
          }
          geminiBody.generationConfig.thinkingConfig.thinkingBudget = budget
        }
      }
    }
    // Do NOT add thinkingConfig when tools are present - matches llms library behavior

    if (geminiTools) {
      geminiBody.tools = geminiTools
    }

    if (toolConfig) {
      geminiBody.toolConfig = toolConfig
    }

    // Add systemInstruction field for PA API compatibility
    // Format: { role: 'user', parts: [{ text: '...' }] }
    if (systemInstruction) {
      geminiBody.systemInstruction = {
        role: 'user',
        parts: [{ text: systemInstruction }]
      }
    }

    return geminiBody
  }

  /**
   * Convert Messages from Claude to Gemini format
   * @param {Array} messages
   * @returns {Array} Gemini contents
   */
  _convertMessages(messages) {
    const contents = []

    for (const msg of messages) {
      const parts = []
      let pendingThinkingSignature = null // Store signature from thinking block to attach to tool_use

      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content })
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            const part = { text: block.text }
            if (pendingThinkingSignature) {
              part.thoughtSignature = pendingThinkingSignature
              pendingThinkingSignature = null
            }
            parts.push(part)
          } else if (block.type === 'image') {
            // Handle image: source.data is base64
            parts.push({
              inlineData: {
                mimeType: block.source.media_type,
                data: block.source.data
              }
            })
          } else if (block.type === 'document') {
            // Handle document (PDF): source.data is base64
            // Gemini supports application/pdf via inlineData
            parts.push({
              inlineData: {
                mimeType: block.source.media_type,
                data: block.source.data
              }
            })
          } else if (block.type === 'thinking') {
            // Handle Claude 3.7+ thinking/CoT blocks
            if (block.thinking) {
              const signature = block.signature || block.thought_signature || block.thoughtSignature

              if (signature) {
                pendingThinkingSignature = signature
                // Do NOT push any part for the thinking block itself.
                // The signature will be attached to the subsequent text or tool_use block.
              }
            }
          } else if (block.type === 'tool_use') {
            // Handle tool use -> function call
            const part = {
              functionCall: {
                name: block.name,
                args: block.input
              }
            }

            if (pendingThinkingSignature) {
              part.thoughtSignature = pendingThinkingSignature
              pendingThinkingSignature = null // Only attach to the first tool use
            }
            // FALLBACK: If no signature in current traversal, check if the previous part was a thinking block with signature
            else if (parts.length > 0) {
              const lastPart = parts[parts.length - 1]
              if (lastPart.thoughtSignature) {
                part.thoughtSignature = lastPart.thoughtSignature
              }
            }
            // CRITICAL FIX: Gemini PA API requires thoughtSignature field even if empty
            // Set to empty string if no signature was found
            if (!part.thoughtSignature) {
              part.thoughtSignature = ''
            }

            parts.push(part)
          } else if (block.type === 'tool_result') {
            // For tool_result, we need 'functionResponse' part
            parts.push({
              functionResponse: {
                name: this._findToolNameForId(messages, block.tool_use_id), // We need to look up name by ID
                response: {
                  result: block.content
                }
              }
            })
          }
        }
      }

      // Map roles
      let role = 'user'
      if (msg.role === 'assistant') {
        role = 'model'
      }

      // Merge consecutive messages of same role if needed (Gemini requirement: alternate roles)
      if (contents.length > 0 && contents[contents.length - 1].role === role) {
        contents[contents.length - 1].parts.push(...parts)
      } else {
        // Prevent empty parts (400 Bad Request)
        if (parts.length === 0) {
          parts.push({ text: '' })
        }
        contents.push({ role, parts })
      }
    }

    return contents
  }

  // Helper to find tool name by ID (Claude uses IDs, Gemini needs Names)
  _findToolNameForId(messages, toolUseId) {
    // Scan previous assistant messages to find the tool_use with this ID
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const toolUse = msg.content.find((c) => c.type === 'tool_use' && c.id === toolUseId)
        if (toolUse) {
          return toolUse.name
        }
      }
    }
    return 'unknown_tool'
  }

  /**
   * Convert Tool Definition (JSON Schema)
   */
  _convertToolDefinition(claudeTool) {
    // Gemini uses a subset of OpenAPI 3.0
    // We need to clean up input_schema and rename to parametersJsonSchema
    const parameters = this._processJsonSchema(claudeTool.input_schema)

    const toolDef = {
      name: claudeTool.name,
      description: claudeTool.description
    }

    // STRICT: Rename parameters to parametersJsonSchema
    if (parameters) {
      toolDef.parametersJsonSchema = parameters
    }

    return toolDef
  }

  _processJsonSchema(schema) {
    if (!schema) {
      return undefined
    }

    // Type definition
    const Type = {
      TYPE_UNSPECIFIED: 'TYPE_UNSPECIFIED',
      STRING: 'STRING',
      NUMBER: 'NUMBER',
      INTEGER: 'INTEGER',
      BOOLEAN: 'BOOLEAN',
      ARRAY: 'ARRAY',
      OBJECT: 'OBJECT',
      NULL: 'NULL'
    }

    // Helper to flatten type array to anyOf
    const flattenTypeArrayToAnyOf = (typeList, resultingSchema) => {
      if (typeList.includes('null')) {
        resultingSchema['nullable'] = true
      }
      const listWithoutNull = typeList.filter((type) => type !== 'null')

      if (listWithoutNull.length === 1) {
        const upperCaseType = listWithoutNull[0].toUpperCase()
        resultingSchema['type'] = Object.values(Type).includes(upperCaseType)
          ? upperCaseType
          : Type.TYPE_UNSPECIFIED
      } else {
        resultingSchema['anyOf'] = []
        for (const i of listWithoutNull) {
          const upperCaseType = i.toUpperCase()
          resultingSchema['anyOf'].push({
            type: Object.values(Type).includes(upperCaseType)
              ? upperCaseType
              : Type.TYPE_UNSPECIFIED
          })
        }
      }
    }

    const processRecursively = (_jsonSchema) => {
      const genAISchema = {}
      const schemaFieldNames = ['items']
      const listSchemaFieldNames = ['anyOf']
      const dictSchemaFieldNames = ['properties']

      if (_jsonSchema['type'] && _jsonSchema['anyOf']) {
        delete _jsonSchema['type']
      }

      /*
      Handle nullable array or object: {anyOf: [{type: 'null'}, {type: 'object'}]}
      */
      const incomingAnyOf = _jsonSchema['anyOf']
      if (incomingAnyOf != null && Array.isArray(incomingAnyOf) && incomingAnyOf.length == 2) {
        if (incomingAnyOf[0] && incomingAnyOf[0]['type'] === 'null') {
          genAISchema['nullable'] = true
          _jsonSchema = incomingAnyOf[1]
        } else if (incomingAnyOf[1] && incomingAnyOf[1]['type'] === 'null') {
          genAISchema['nullable'] = true
          _jsonSchema = incomingAnyOf[0]
        }
      }

      if (_jsonSchema['type'] && Array.isArray(_jsonSchema['type'])) {
        flattenTypeArrayToAnyOf(_jsonSchema['type'], genAISchema)
      }

      for (const [fieldName, fieldValue] of Object.entries(_jsonSchema)) {
        // Skip if the fieldValue is undefined or null.
        if (fieldValue == null) {
          continue
        }

        if (fieldName == 'type') {
          if (fieldValue === 'null') {
            continue
          }
          if (Array.isArray(fieldValue)) {
            continue
          }
          const upperCaseValue = fieldValue.toUpperCase()
          genAISchema['type'] = Object.values(Type).includes(upperCaseValue)
            ? upperCaseValue
            : Type.TYPE_UNSPECIFIED
        } else if (schemaFieldNames.includes(fieldName)) {
          genAISchema[fieldName] = processRecursively(fieldValue)
        } else if (listSchemaFieldNames.includes(fieldName)) {
          const listSchemaFieldValue = []
          for (const item of fieldValue) {
            if (item['type'] == 'null') {
              genAISchema['nullable'] = true
              continue
            }
            listSchemaFieldValue.push(processRecursively(item))
          }
          genAISchema[fieldName] = listSchemaFieldValue
        } else if (dictSchemaFieldNames.includes(fieldName)) {
          const dictSchemaFieldValue = {}
          for (const [key, value] of Object.entries(fieldValue)) {
            dictSchemaFieldValue[key] = processRecursively(value)
          }
          genAISchema[fieldName] = dictSchemaFieldValue
        } else {
          // additionalProperties is not included in JSONSchema, skipping it.
          if (fieldName === 'additionalProperties') {
            continue
          }
          // Skip unsupported fields
          const unsupported = [
            'default',
            'minItems',
            'maxItems',
            'uniqueItems',
            'pattern',
            'minLength',
            'maxLength',
            'title',
            'examples',
            '$schema',
            '$id'
          ]
          if (unsupported.includes(fieldName)) {
            continue
          }

          genAISchema[fieldName] = fieldValue
        }
      }
      return genAISchema
    }

    return processRecursively(schema)
  }

  /**
   * Convert Gemini JSON response to Claude response
   * @param {Object} geminiResponse
   * @param {string} model
   */
  convertResponse(geminiResponse, model) {
    // 0. 兼容 PA API 的嵌套结构
    let actualResponse = geminiResponse
    if (geminiResponse.response && geminiResponse.response.candidates) {
      actualResponse = geminiResponse.response
    } else if (geminiResponse.response && typeof geminiResponse.response === 'string') {
      try {
        const parsed = JSON.parse(geminiResponse.response)
        if (parsed.candidates) {
          actualResponse = parsed
        } else if (parsed.response && parsed.response.candidates) {
          actualResponse = parsed.response
        }
      } catch (e) {}
    }

    // 1. 尝试获取 Candidate
    let candidate = actualResponse.candidates?.[0]

    if (!candidate) {
      if (actualResponse.promptFeedback?.blockReason) {
        candidate = {
          content: {
            parts: [
              { text: `[Request blocked by Gemini: ${actualResponse.promptFeedback.blockReason}]` }
            ]
          },
          finishReason: 'SAFETY'
        }
      } else {
        candidate = {
          content: { parts: [{ text: '' }] },
          finishReason: 'STOP'
        }
        logger.warn('[ClaudeToGemini] Empty candidates in Gemini response', {
          response: JSON.stringify(geminiResponse)
        })
      }
    }

    const content = []
    const parts = candidate.content?.parts || []
    const usageMetadata = actualResponse.usageMetadata || geminiResponse.usageMetadata

    for (const part of parts) {
      const signature = part.thoughtSignature || part.thought_signature
      const isThought = part.thought === true || (signature && part.text)

      if (isThought && part.text) {
        content.push({
          type: 'thinking',
          thinking: part.text,
          signature
        })
      } else if (part.text) {
        content.push({ type: 'text', text: part.text })
      } else if (part.functionCall) {
        const toolUsePart = {
          type: 'tool_use',
          id: `toolu_${uuidv4().substring(0, 8)}`,
          name: part.functionCall.name,
          input: part.functionCall.args
        }
        content.push(toolUsePart)
      }
    }

    let stop_reason = 'end_turn'
    let stop_sequence = null

    if (candidate.finishReason === 'MAX_TOKENS') {
      stop_reason = 'max_tokens'
    } else if (candidate.finishReason === 'STOP') {
      stop_reason = 'end_turn'
    } else if (candidate.finishReason === 'SAFETY') {
      stop_reason = 'stop_sequence'
      stop_sequence = 'SAFETY'
      if (content.length === 0) {
        content.push({ type: 'text', text: '[Content blocked by Gemini Safety Filters]' })
      }
    } else if (candidate.finishReason === 'RECITATION') {
      stop_reason = 'stop_sequence'
      stop_sequence = 'RECITATION'
      if (content.length === 0) {
        content.push({ type: 'text', text: '[Content blocked by Gemini Recitation Checks]' })
      }
    }

    if (content.some((c) => c.type === 'tool_use')) {
      stop_reason = 'tool_use'
    }

    return {
      id: `msg_${uuidv4()}`,
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason,
      stop_sequence,
      usage: {
        input_tokens: usageMetadata?.promptTokenCount || 0,
        output_tokens: usageMetadata?.candidatesTokenCount || 0,
        cache_read_input_tokens: usageMetadata?.cachedContentTokenCount || 0
      }
    }
  }

  /**
   * Generator function for Stream Conversion
   * @param {Object} geminiChunk
   * @param {Object} streamState
   */
  *convertStreamChunk(
    geminiChunk,
    streamState = {
      index: 0,
      currentType: null,
      hasToolUse: false,
      pendingText: '',
      hasTextContent: false,
      hasThinkingContent: false,
      hasThinkingDelta: false,
      thinkingText: '' // 收集 thinking 文本内容
    }
  ) {
    // Handle PA API nested response structure: {response: {candidates: [...]}}
    // vs Standard API structure: {candidates: [...]}
    const actualChunk = geminiChunk.response || geminiChunk
    const candidate = actualChunk.candidates?.[0]
    const usage = actualChunk.usageMetadata || geminiChunk.usageMetadata

    if (streamState.pendingText === undefined) {
      streamState.pendingText = ''
    }
    if (streamState.hasTextContent === undefined) {
      streamState.hasTextContent = false
    }
    if (streamState.hasThinkingContent === undefined) {
      streamState.hasThinkingContent = false
    }
    if (streamState.hasThinkingDelta === undefined) {
      streamState.hasThinkingDelta = false
    }
    if (streamState.thinkingText === undefined) {
      streamState.thinkingText = ''
    }

    const parts = candidate?.content?.parts || []

    for (const part of parts) {
      const signature = part.thoughtSignature || part.thought_signature
      // FIX: Text accompanying a signature is usually the start of the actual response, NOT thinking content.
      // Only 'thought: true' marks explicit thinking content.
      const isThought = part.thought === true

      let targetType = null
      if (part.functionCall) {
        targetType = 'tool_use'
        streamState.hasToolUse = true
      } else if (part.text) {
        targetType = isThought ? 'thinking' : 'text'
        // Track if we have actual text content (not just thinking)
        if (!isThought && part.text.trim()) {
          streamState.hasTextContent = true
        }
      }
      // Track thinking content (signature or thought text)
      if (signature || isThought) {
        streamState.hasThinkingContent = true
      }

      if (!targetType && !signature) {
        continue
      }

      // CRITICAL: Skip thinking blocks that appear after text content
      // Gemini sometimes violates Claude API spec by sending text first, then thinking
      // We must ignore these out-of-order thinking blocks to avoid confusing the CLI
      // AND ensure we don't disrupt the current block index
      if (streamState.hasTextContent && (isThought || signature)) {
        continue
      }

      // Handle Block Switching
      // Only switch if we are changing types AND the new type is valid
      if (streamState.currentType && targetType && streamState.currentType !== targetType) {
        // Special case: If we are in 'thinking' and receive 'text', we MUST close the thinking block
        if (streamState.currentType === 'thinking' && targetType === 'text') {
           yield { type: 'content_block_stop', index: streamState.index }
           streamState.index++
           streamState.currentType = null
        }
        // If we are in 'text' and receive 'thinking', we should have skipped it above.
        // But if we are here, it means we are switching from text to something else (like tool_use)
        else if (streamState.currentType === 'text' && targetType === 'tool_use') {
           yield { type: 'content_block_stop', index: streamState.index }
           streamState.index++
           streamState.currentType = null
        }
        // If switching from text to text (shouldn't happen with logic above) or thinking to thinking, do nothing
      }

      // Start new block if needed
      if (targetType && !streamState.currentType) {
        streamState.currentType = targetType
        const contentBlock =
          targetType === 'thinking'
            ? { type: 'thinking', thinking: '' }
            : targetType === 'text'
              ? { type: 'text', text: '' }
              : null // tool_use handled separately below

        if (contentBlock) {
          yield {
            type: 'content_block_start',
            index: streamState.index,
            content_block: contentBlock
          }
        }
      }

      // Handle Content
      if (part.text) {
        if (!isThought && streamState.currentType === 'thinking') {
          streamState.pendingText += part.text
        } else {
          // Track that we sent a thinking delta with actual content
          if (isThought) {
            streamState.hasThinkingDelta = true
            // 收集 thinking 文本内容，稍后可能需要作为实际内容
            streamState.thinkingText += part.text
          }

          // 发送 thinking 或 text 事件
          yield {
            type: 'content_block_delta',
            index: streamState.index,
            delta: {
              type: isThought ? 'thinking_delta' : 'text_delta',
              [isThought ? 'thinking' : 'text']: part.text
            }
          }
        }
      }

      // Handle Signature
      if (signature) {
        if (streamState.currentType !== 'thinking') {
          if (!streamState.currentType) {
            streamState.currentType = 'thinking'
            yield {
              type: 'content_block_start',
              index: streamState.index,
              content_block: { type: 'thinking', thinking: '' }
            }
          }
        }

        // IMPORTANT: If no thinking content was sent, send a placeholder before signature
        // This matches CCR/llms library behavior - signature alone is not displayable
        if (!streamState.hasThinkingDelta) {
          yield {
            type: 'content_block_delta',
            index: streamState.index,
            delta: { type: 'thinking_delta', thinking: '(no content)' }
          }
        }

        yield {
          type: 'content_block_delta',
          index: streamState.index,
          delta: { type: 'signature_delta', signature }
        }

        yield { type: 'content_block_stop', index: streamState.index }
        streamState.index++
        streamState.currentType = null

        // Handle buffered text logic similar to llms project
        // llms uses 'pendingContent' buffer for Gemini 3 models to handle out-of-order text/signature
        // Here we simplify: if we have buffered text in 'pendingText' (which collects text while in thinking mode),
        // we emit it now. BUT we should have ensured that 'pendingText' only contains actual text, not thinking content.

        // In our loop above (lines 722-723), pendingText accumulates part.text if currentType is thinking and !isThought.
        // So pendingText IS legitimate text that arrived while the state machine was locked in thinking mode.
        // We should output it now.

        if (streamState.pendingText) {
          streamState.currentType = 'text'
          streamState.hasTextContent = true
          yield {
            type: 'content_block_start',
            index: streamState.index,
            content_block: { type: 'text', text: '' }
          }
          // Clean text
          const cleanedText = streamState.pendingText.replace(/^[\n\r\s]+/, '')
          if (cleanedText) {
            yield {
              type: 'content_block_delta',
              index: streamState.index,
              delta: { type: 'text_delta', text: cleanedText }
            }
          }
          streamState.pendingText = ''
        }

        // Strict separation: We DO NOT emit thinkingText as text content anymore.
        // This aligns with llms implementation which filters out thoughts from text content.
      }

      // Handle Grounding (Web Search)
      const groundingMetadata = candidate?.groundingMetadata
      if (groundingMetadata?.groundingChunks?.length) {
        if (streamState.currentType) {
          yield { type: 'content_block_stop', index: streamState.index }
          streamState.index++
          streamState.currentType = null
        }

        const content = groundingMetadata.groundingChunks.map((chunk, index) => ({
          type: 'web_search_result',
          title: chunk.web?.title || '',
          url: chunk.web?.uri || ''
        }))

        yield {
          type: 'content_block_start',
          index: streamState.index,
          content_block: {
            type: 'web_search_tool_result',
            tool_use_id: `srvtoolu_${uuidv4().substring(0, 8)}`,
            content
          }
        }

        yield { type: 'content_block_stop', index: streamState.index }
        streamState.index++
      }

      if (part.functionCall) {
        const toolUseId = `toolu_${uuidv4().substring(0, 8)}`
        yield {
          type: 'content_block_start',
          index: streamState.index,
          content_block: {
            type: 'tool_use',
            id: toolUseId,
            name: part.functionCall.name,
            input: {}
          }
        }

        yield {
          type: 'content_block_delta',
          index: streamState.index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(part.functionCall.args) }
        }

        yield { type: 'content_block_stop', index: streamState.index }
        streamState.index++
        streamState.currentType = null
      }
    }

    // Handle finish reason - emit message_delta and message_stop for ALL finish reasons
    if (candidate?.finishReason) {
      // Close any open content block before message termination
      if (streamState.currentType) {
        yield { type: 'content_block_stop', index: streamState.index }
        streamState.index++
        streamState.currentType = null
      }

      // CRITICAL FIX: If we had thinking content but no text content, add a text block with placeholder
      // Without this, Claude Code CLI won't display anything even though thinking was sent
      if (
        streamState.hasThinkingContent &&
        !streamState.hasTextContent &&
        !streamState.hasToolUse
      ) {
        // Create a minimal text block to satisfy CLI requirements
        yield {
          type: 'content_block_start',
          index: streamState.index,
          content_block: { type: 'text', text: '' }
        }
        yield {
          type: 'content_block_delta',
          index: streamState.index,
          delta: { type: 'text_delta', text: '[思考完成]' }
        }
        yield { type: 'content_block_stop', index: streamState.index }
        streamState.index++
      }

      let stop_reason = 'end_turn'
      let stop_sequence = null

      if (candidate.finishReason === 'MAX_TOKENS') {
        stop_reason = 'max_tokens'
      } else if (candidate.finishReason === 'SAFETY') {
        stop_reason = 'stop_sequence'
        stop_sequence = 'SAFETY'
      } else if (candidate.finishReason === 'RECITATION') {
        stop_reason = 'stop_sequence'
        stop_sequence = 'RECITATION'
      }
      // STOP and other reasons -> end_turn

      if (streamState.hasToolUse) {
        stop_reason = 'tool_use'
      }

      yield {
        type: 'message_delta',
        delta: { stop_reason, stop_sequence },
        usage: { output_tokens: usage?.candidatesTokenCount || 0 }
      }

      yield { type: 'message_stop' }
    }
  }
}

module.exports = new ClaudeToGeminiConverter()
