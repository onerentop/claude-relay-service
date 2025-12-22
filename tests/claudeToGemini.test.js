/**
 * Claude 到 Gemini 转换逻辑测试
 *
 * 测试 src/services/claudeToGemini.js 中的核心转换逻辑：
 * - 请求转换 (Claude → Gemini)
 * - 响应转换 (Gemini → Claude)
 * - 流式响应转换
 * - JSON Schema 清洗
 * - 边缘情况处理
 */

// Mock logger to avoid console output during tests
jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  database: jest.fn(),
  security: jest.fn()
}))

// 模块导出的是实例，不是类
const converter = require('../src/services/claudeToGemini')

describe('ClaudeToGeminiConverter', () => {

  // ============================================
  // 请求转换测试
  // ============================================
  describe('Request Conversion (convertRequest)', () => {
    describe('角色映射', () => {
      it('should map user role to user', () => {
        const claudeBody = {
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100
        }

        const result = converter.convertRequest(claudeBody)

        expect(result.contents[0].role).toBe('user')
        expect(result.contents[0].parts[0].text).toBe('Hello')
      })

      it('should map assistant role to model', () => {
        const claudeBody = {
          messages: [
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello!' }
          ],
          max_tokens: 100
        }

        const result = converter.convertRequest(claudeBody)

        expect(result.contents[1].role).toBe('model')
        expect(result.contents[1].parts[0].text).toBe('Hello!')
      })

      it('should extract system message to systemInstruction', () => {
        const claudeBody = {
          system: 'You are a helpful assistant',
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100
        }

        const result = converter.convertRequest(claudeBody)

        expect(result.systemInstruction).toBeDefined()
        expect(result.systemInstruction.parts[0].text).toBe('You are a helpful assistant')
      })
    })

    describe('内容块转换', () => {
      it('should convert text content block', () => {
        const claudeBody = {
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: 'Test message' }]
            }
          ],
          max_tokens: 100
        }

        const result = converter.convertRequest(claudeBody)

        expect(result.contents[0].parts[0].text).toBe('Test message')
      })

      it('should convert base64 image to inlineData', () => {
        const claudeBody = {
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/jpeg',
                    data: 'base64EncodedData'
                  }
                }
              ]
            }
          ],
          max_tokens: 100
        }

        const result = converter.convertRequest(claudeBody)

        expect(result.contents[0].parts[0].inlineData).toBeDefined()
        expect(result.contents[0].parts[0].inlineData.mimeType).toBe('image/jpeg')
        expect(result.contents[0].parts[0].inlineData.data).toBe('base64EncodedData')
      })

      it('should convert document (PDF) to inlineData', () => {
        const claudeBody = {
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: 'pdfBase64Data'
                  }
                }
              ]
            }
          ],
          max_tokens: 100
        }

        const result = converter.convertRequest(claudeBody)

        expect(result.contents[0].parts[0].inlineData.mimeType).toBe('application/pdf')
      })

      it('should skip thinking block (not include in history) - gemini-cli official behavior', () => {
        // 根据 gemini-cli 官方做法 (geminiChat.ts:745):
        // const visibleParts = content.parts.filter((part) => !part.thought);
        // thinking 块不应该出现在历史消息中
        const claudeBody = {
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'thinking',
                  thinking: 'Let me think about this...',
                  signature: 'sig123'
                },
                {
                  type: 'text',
                  text: 'Here is my answer'
                }
              ]
            }
          ],
          max_tokens: 100
        }

        const result = converter.convertRequest(claudeBody)

        // thinking 块被跳过，只有 text 块
        expect(result.contents[0].parts.length).toBe(1)
        expect(result.contents[0].parts[0].text).toBe('Here is my answer')
        // 不包含 thinking 内容
        expect(result.contents[0].parts[0].thought).toBeUndefined()
      })

      it('should convert tool_use to functionCall', () => {
        const claudeBody = {
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'tool_123',
                  name: 'get_weather',
                  input: { location: 'Tokyo' }
                }
              ]
            }
          ],
          max_tokens: 100
        }

        const result = converter.convertRequest(claudeBody)

        expect(result.contents[0].parts[0].functionCall).toBeDefined()
        expect(result.contents[0].parts[0].functionCall.name).toBe('get_weather')
        expect(result.contents[0].parts[0].functionCall.args).toEqual({ location: 'Tokyo' })
      })

      it('should convert tool_result to functionResponse', () => {
        const claudeBody = {
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 'tool_123',
                  name: 'get_weather',
                  input: { location: 'Tokyo' }
                }
              ]
            },
            {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool_123',
                  content: '25°C, sunny'
                }
              ]
            }
          ],
          max_tokens: 100
        }

        const result = converter.convertRequest(claudeBody)

        const functionResponsePart = result.contents.find(
          (c) => c.parts.some((p) => p.functionResponse)
        )?.parts.find((p) => p.functionResponse)

        expect(functionResponsePart).toBeDefined()
        expect(functionResponsePart.functionResponse.name).toBe('get_weather')
        expect(functionResponsePart.functionResponse.response.result).toBe('25°C, sunny')
      })
    })

    describe('工具定义转换', () => {
      it('should convert tool input_schema to parametersJsonSchema', () => {
        const claudeBody = {
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100,
          tools: [
            {
              name: 'get_weather',
              description: 'Get weather info',
              input_schema: {
                type: 'object',
                properties: {
                  location: { type: 'string' }
                },
                required: ['location']
              }
            }
          ]
        }

        const result = converter.convertRequest(claudeBody)

        expect(result.tools).toBeDefined()
        expect(result.tools[0].functionDeclarations).toBeDefined()
        expect(result.tools[0].functionDeclarations[0].parametersJsonSchema).toBeDefined()
        expect(result.tools[0].functionDeclarations[0].parametersJsonSchema.type).toBe('OBJECT')
      })

      it('should convert web_search tool to googleSearch', () => {
        const claudeBody = {
          messages: [{ role: 'user', content: 'Search for news' }],
          max_tokens: 100,
          tools: [
            {
              name: 'web_search',
              description: 'Search the web'
            }
          ]
        }

        const result = converter.convertRequest(claudeBody)

        expect(result.tools).toBeDefined()
        expect(result.tools.some((t) => t.googleSearch !== undefined)).toBe(true)
      })
    })

    describe('配置参数映射', () => {
      it('should map temperature to generationConfig', () => {
        const claudeBody = {
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100,
          temperature: 0.7
        }

        const result = converter.convertRequest(claudeBody)

        expect(result.generationConfig.temperature).toBe(0.7)
      })

      it('should map max_tokens to maxOutputTokens', () => {
        const claudeBody = {
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 2048
        }

        const result = converter.convertRequest(claudeBody)

        expect(result.generationConfig.maxOutputTokens).toBe(2048)
      })

      it('should map top_p to topP', () => {
        const claudeBody = {
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100,
          top_p: 0.9
        }

        const result = converter.convertRequest(claudeBody)

        expect(result.generationConfig.topP).toBe(0.9)
      })

      it('should map stop_sequences to stopSequences', () => {
        const claudeBody = {
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100,
          stop_sequences: ['END', 'STOP']
        }

        const result = converter.convertRequest(claudeBody)

        expect(result.generationConfig.stopSequences).toEqual(['END', 'STOP'])
      })
    })

    describe('Thinking 配置', () => {
      it('should map thinking.budget_tokens to thinkingConfig.thinkingBudget for Gemini 2.5', () => {
        // 只有 Gemini 2.5 支持 thinkingConfig
        const claudeBody = {
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100,
          thinking: { budget_tokens: 5000 }
        }

        const result = converter.convertRequest(claudeBody, null, 'gemini-2.5-flash')

        expect(result.generationConfig.thinkingConfig).toBeDefined()
        expect(result.generationConfig.thinkingConfig.includeThoughts).toBe(true)
        expect(result.generationConfig.thinkingConfig.thinkingBudget).toBe(5000)
      })

      it('should NOT add thinkingConfig for Gemini 3 models (not supported)', () => {
        // 根据官方 gemini-cli (client.ts:58-67)，Gemini 3 不支持 thinkingConfig
        const claudeBody = {
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100,
          reasoning: { effort: 'medium' }
        }

        const result = converter.convertRequest(claudeBody, null, 'gemini-3-flash')

        // Gemini 3 不应该有 thinkingConfig
        expect(result.generationConfig.thinkingConfig).toBeUndefined()
      })

      it('should cap thinkingBudget at 32768 for Gemini 2.5', () => {
        // 只有 Gemini 2.5 支持 thinkingConfig
        const claudeBody = {
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100,
          thinking: { budget_tokens: 100000 }
        }

        const result = converter.convertRequest(claudeBody, null, 'gemini-2.5-flash')

        expect(result.generationConfig.thinkingConfig.thinkingBudget).toBe(32768)
      })

      it('should auto-add thinkingConfig for Gemini 2.5+ models even without thinking param', () => {
        // 🎯 根据 gemini-cli 官方做法 (client.ts:263-274)
        // Gemini 2.5+ 模型必须自动添加 thinkingConfig，否则会返回 500 错误
        const claudeBody = {
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100
          // 注意：没有 thinking 参数
        }

        const result = converter.convertRequest(claudeBody, null, 'gemini-2.5-pro')

        expect(result.generationConfig.thinkingConfig).toBeDefined()
        expect(result.generationConfig.thinkingConfig.includeThoughts).toBe(true)
        expect(result.generationConfig.thinkingConfig.thinkingBudget).toBe(-1) // -1 表示无限制
      })

      it('should NOT auto-add thinkingConfig for Gemini 3 models (not supported)', () => {
        // 🎯 根据 gemini-cli 官方做法 (client.ts:58-67)
        // Gemini 3 模型不支持 thinkingConfig，会返回 400 错误
        const claudeBody = {
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100
          // 注意：没有 thinking 参数
        }

        const result = converter.convertRequest(claudeBody, null, 'gemini-3-pro-preview')

        // Gemini 3 不应该有 thinkingConfig
        expect(result.generationConfig.thinkingConfig).toBeUndefined()
      })

      it('should NOT add thinkingConfig for non-thinking models', () => {
        const claudeBody = {
          messages: [{ role: 'user', content: 'Hello' }],
          max_tokens: 100
        }

        const result = converter.convertRequest(claudeBody, null, 'gemini-2.0-flash')

        expect(result.generationConfig.thinkingConfig).toBeUndefined()
      })
    })
  })

  // ============================================
  // JSON Schema 清洗测试
  // ============================================
  describe('JSON Schema Cleaning (_processJsonSchema)', () => {
    it('should convert type string to STRING uppercase', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' }
        }
      }

      const result = converter._processJsonSchema(schema)

      expect(result.type).toBe('OBJECT')
      expect(result.properties.name.type).toBe('STRING')
    })

    it('should convert type number to NUMBER uppercase', () => {
      const schema = {
        type: 'object',
        properties: {
          count: { type: 'number' }
        }
      }

      const result = converter._processJsonSchema(schema)

      expect(result.properties.count.type).toBe('NUMBER')
    })

    it('should convert type integer to INTEGER uppercase', () => {
      const schema = {
        type: 'object',
        properties: {
          age: { type: 'integer' }
        }
      }

      const result = converter._processJsonSchema(schema)

      expect(result.properties.age.type).toBe('INTEGER')
    })

    it('should handle nullable anyOf pattern', () => {
      const schema = {
        anyOf: [{ type: 'null' }, { type: 'string' }]
      }

      const result = converter._processJsonSchema(schema)

      expect(result.nullable).toBe(true)
      expect(result.type).toBe('STRING')
    })

    it('should remove additionalProperties', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' }
        },
        additionalProperties: false
      }

      const result = converter._processJsonSchema(schema)

      expect(result.additionalProperties).toBeUndefined()
    })

    it('should remove default field', () => {
      const schema = {
        type: 'string',
        default: 'hello'
      }

      const result = converter._processJsonSchema(schema)

      expect(result.default).toBeUndefined()
    })

    it('should remove unsupported fields', () => {
      const schema = {
        type: 'string',
        title: 'Name field',
        examples: ['John', 'Jane'],
        $schema: 'http://json-schema.org/draft-07/schema#',
        $id: 'name-schema',
        minLength: 1,
        maxLength: 100,
        pattern: '^[a-z]+$'
      }

      const result = converter._processJsonSchema(schema)

      expect(result.title).toBeUndefined()
      expect(result.examples).toBeUndefined()
      expect(result.$schema).toBeUndefined()
      expect(result.$id).toBeUndefined()
      expect(result.minLength).toBeUndefined()
      expect(result.maxLength).toBeUndefined()
      expect(result.pattern).toBeUndefined()
    })

    it('should preserve required field', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' }
        },
        required: ['name']
      }

      const result = converter._processJsonSchema(schema)

      expect(result.required).toEqual(['name'])
    })

    it('should preserve enum field', () => {
      const schema = {
        type: 'string',
        enum: ['red', 'green', 'blue']
      }

      const result = converter._processJsonSchema(schema)

      expect(result.enum).toEqual(['red', 'green', 'blue'])
    })

    it('should preserve format field', () => {
      const schema = {
        type: 'string',
        format: 'date-time'
      }

      const result = converter._processJsonSchema(schema)

      expect(result.format).toBe('date-time')
    })

    it('should process nested array items', () => {
      const schema = {
        type: 'array',
        items: {
          type: 'string'
        }
      }

      const result = converter._processJsonSchema(schema)

      expect(result.type).toBe('ARRAY')
      expect(result.items.type).toBe('STRING')
    })

    it('should handle type array with null', () => {
      const schema = {
        type: ['string', 'null']
      }

      const result = converter._processJsonSchema(schema)

      expect(result.nullable).toBe(true)
      expect(result.type).toBe('STRING')
    })
  })

  // ============================================
  // 响应转换测试
  // ============================================
  describe('Response Conversion (convertResponse)', () => {
    it('should convert simple text response', () => {
      const geminiResponse = {
        candidates: [
          {
            content: {
              parts: [{ text: 'Hello there!' }]
            },
            finishReason: 'STOP'
          }
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5
        }
      }

      const result = converter.convertResponse(geminiResponse, 'gemini-2.0-flash')

      expect(result.content[0].type).toBe('text')
      expect(result.content[0].text).toBe('Hello there!')
      expect(result.stop_reason).toBe('end_turn')
    })

    it('should convert thinking response (thought: true)', () => {
      const geminiResponse = {
        candidates: [
          {
            content: {
              parts: [{ text: 'Let me analyze...', thought: true }]
            },
            finishReason: 'STOP'
          }
        ]
      }

      const result = converter.convertResponse(geminiResponse, 'gemini-2.0-flash')

      expect(result.content[0].type).toBe('thinking')
      expect(result.content[0].thinking).toBe('Let me analyze...')
    })

    it('should convert thinking response with thoughtSignature', () => {
      const geminiResponse = {
        candidates: [
          {
            content: {
              parts: [
                { text: 'Thinking...', thoughtSignature: 'sig_abc123' },
                { text: 'Final answer' }
              ]
            },
            finishReason: 'STOP'
          }
        ]
      }

      const result = converter.convertResponse(geminiResponse, 'gemini-2.0-flash')

      const thinkingBlock = result.content.find((c) => c.type === 'thinking')
      expect(thinkingBlock).toBeDefined()
      expect(thinkingBlock.signature).toBe('sig_abc123')
    })

    it('should convert functionCall to tool_use', () => {
      const geminiResponse = {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'get_weather',
                    args: { location: 'Tokyo' }
                  }
                }
              ]
            },
            finishReason: 'TOOL_CALLS'
          }
        ]
      }

      const result = converter.convertResponse(geminiResponse, 'gemini-2.0-flash')

      expect(result.content[0].type).toBe('tool_use')
      expect(result.content[0].name).toBe('get_weather')
      expect(result.content[0].input).toEqual({ location: 'Tokyo' })
      expect(result.content[0].id).toMatch(/^toolu_/)
      expect(result.stop_reason).toBe('tool_use')
    })

    it('should map MAX_TOKENS to max_tokens stop_reason', () => {
      const geminiResponse = {
        candidates: [
          {
            content: {
              parts: [{ text: 'Truncated...' }]
            },
            finishReason: 'MAX_TOKENS'
          }
        ]
      }

      const result = converter.convertResponse(geminiResponse, 'gemini-2.0-flash')

      expect(result.stop_reason).toBe('max_tokens')
    })

    it('should map SAFETY to stop_sequence with message', () => {
      const geminiResponse = {
        candidates: [
          {
            content: {
              parts: []
            },
            finishReason: 'SAFETY'
          }
        ]
      }

      const result = converter.convertResponse(geminiResponse, 'gemini-2.0-flash')

      expect(result.stop_reason).toBe('stop_sequence')
      expect(result.content.some((c) => c.text?.includes('blocked'))).toBe(true)
    })

    it('should convert usageMetadata to usage', () => {
      const geminiResponse = {
        candidates: [
          {
            content: {
              parts: [{ text: 'Hello' }]
            },
            finishReason: 'STOP'
          }
        ],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          cachedContentTokenCount: 20
        }
      }

      const result = converter.convertResponse(geminiResponse, 'gemini-2.0-flash')

      expect(result.usage.input_tokens).toBe(100)
      expect(result.usage.output_tokens).toBe(50)
      expect(result.usage.cache_read_input_tokens).toBe(20)
    })

    it('should handle PA API nested response structure', () => {
      const geminiResponse = {
        response: {
          candidates: [
            {
              content: {
                parts: [{ text: 'Nested response' }]
              },
              finishReason: 'STOP'
            }
          ]
        }
      }

      const result = converter.convertResponse(geminiResponse, 'gemini-2.0-flash')

      expect(result.content[0].text).toBe('Nested response')
    })
  })

  // ============================================
  // 流式转换测试
  // ============================================
  describe('Stream Conversion (convertStreamChunk)', () => {
    it('should generate text_delta for text content', () => {
      const geminiChunk = {
        candidates: [
          {
            content: {
              parts: [{ text: 'Hello' }]
            }
          }
        ]
      }
      const streamState = {
        index: 0,
        currentType: null,
        hasToolUse: false,
        pendingText: '',
        hasTextContent: false,
        hasThinkingContent: false,
        hasThinkingDelta: false,
        thinkingText: '',
        signatureSent: false
      }

      const events = [...converter.convertStreamChunk(geminiChunk, streamState)]

      const textDelta = events.find(
        (e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta'
      )
      expect(textDelta).toBeDefined()
      expect(textDelta.delta.text).toBe('Hello')
    })

    it('should generate thinking_delta for thought content', () => {
      const geminiChunk = {
        candidates: [
          {
            content: {
              parts: [{ text: 'Thinking...', thought: true }]
            }
          }
        ]
      }
      const streamState = {
        index: 0,
        currentType: null,
        hasToolUse: false,
        pendingText: '',
        hasTextContent: false,
        hasThinkingContent: false,
        hasThinkingDelta: false,
        thinkingText: '',
        signatureSent: false
      }

      const events = [...converter.convertStreamChunk(geminiChunk, streamState)]

      const thinkingDelta = events.find(
        (e) => e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta'
      )
      expect(thinkingDelta).toBeDefined()
    })

    it('should generate signature_delta for thoughtSignature', () => {
      const geminiChunk = {
        candidates: [
          {
            content: {
              parts: [{ thoughtSignature: 'sig_123' }]
            }
          }
        ]
      }
      const streamState = {
        index: 0,
        currentType: 'thinking',
        hasToolUse: false,
        pendingText: '',
        hasTextContent: false,
        hasThinkingContent: true,
        hasThinkingDelta: true,
        thinkingText: 'thinking content',
        signatureSent: false
      }

      const events = [...converter.convertStreamChunk(geminiChunk, streamState)]

      const signatureDelta = events.find(
        (e) => e.type === 'content_block_delta' && e.delta?.type === 'signature_delta'
      )
      expect(signatureDelta).toBeDefined()
      expect(signatureDelta.delta.signature).toBe('sig_123')
    })

    it('should generate tool_use events for functionCall', () => {
      const geminiChunk = {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'get_weather',
                    args: { location: 'Tokyo' }
                  }
                }
              ]
            }
          }
        ]
      }
      const streamState = {
        index: 0,
        currentType: null,
        hasToolUse: false,
        pendingText: '',
        hasTextContent: false,
        hasThinkingContent: false,
        hasThinkingDelta: false,
        thinkingText: '',
        signatureSent: false
      }

      const events = [...converter.convertStreamChunk(geminiChunk, streamState)]

      const toolUseStart = events.find(
        (e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use'
      )
      expect(toolUseStart).toBeDefined()
      expect(toolUseStart.content_block.name).toBe('get_weather')

      const inputDelta = events.find(
        (e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta'
      )
      expect(inputDelta).toBeDefined()
    })

    it('should generate message_stop on finishReason', () => {
      const geminiChunk = {
        candidates: [
          {
            finishReason: 'STOP'
          }
        ],
        usageMetadata: {
          candidatesTokenCount: 50
        }
      }
      const streamState = {
        index: 1,
        currentType: 'text',
        hasToolUse: false,
        pendingText: '',
        hasTextContent: true,
        hasThinkingContent: false,
        hasThinkingDelta: false,
        thinkingText: '',
        signatureSent: false
      }

      const events = [...converter.convertStreamChunk(geminiChunk, streamState)]

      const messageStop = events.find((e) => e.type === 'message_stop')
      expect(messageStop).toBeDefined()

      const messageDelta = events.find((e) => e.type === 'message_delta')
      expect(messageDelta).toBeDefined()
      expect(messageDelta.delta.stop_reason).toBe('end_turn')
    })
  })

  // ============================================
  // 边缘情况测试
  // ============================================
  describe('Edge Cases', () => {
    it('should handle empty parts by adding empty text', () => {
      const claudeBody = {
        messages: [
          {
            role: 'user',
            content: []
          }
        ],
        max_tokens: 100
      }

      const result = converter.convertRequest(claudeBody)

      expect(result.contents[0].parts.length).toBe(1)
      expect(result.contents[0].parts[0].text).toBe('')
    })

    it('should merge consecutive messages of same role', () => {
      const claudeBody = {
        messages: [
          { role: 'user', content: 'First' },
          { role: 'user', content: 'Second' }
        ],
        max_tokens: 100
      }

      const result = converter.convertRequest(claudeBody)

      // 应该合并为一条消息
      expect(result.contents.length).toBe(1)
      expect(result.contents[0].parts.length).toBe(2)
    })

    it('should handle SAFETY block with empty content', () => {
      const geminiResponse = {
        candidates: [
          {
            content: { parts: [] },
            finishReason: 'SAFETY'
          }
        ]
      }

      const result = converter.convertResponse(geminiResponse, 'gemini-2.0-flash')

      expect(result.content.length).toBeGreaterThan(0)
      expect(result.content[0].text).toContain('blocked')
    })

    it('should handle promptFeedback block reason', () => {
      const geminiResponse = {
        promptFeedback: {
          blockReason: 'PROHIBITED_CONTENT'
        }
      }

      const result = converter.convertResponse(geminiResponse, 'gemini-2.0-flash')

      expect(result.content[0].text).toContain('PROHIBITED_CONTENT')
    })

    it('should generate auto signature for Gemini 2.x without signature', () => {
      const geminiChunk = {
        candidates: [
          {
            content: {
              parts: [{ text: 'Final answer' }]
            }
          }
        ]
      }
      const streamState = {
        index: 0,
        currentType: 'thinking',
        hasToolUse: false,
        pendingText: '',
        hasTextContent: false,
        hasThinkingContent: true,
        hasThinkingDelta: true,
        thinkingText: 'some thinking',
        signatureSent: false
      }

      const events = [...converter.convertStreamChunk(geminiChunk, streamState)]

      // 应该生成自动签名 (base64 编码)
      const signatureDelta = events.find(
        (e) => e.type === 'content_block_delta' && e.delta?.type === 'signature_delta'
      )
      expect(signatureDelta).toBeDefined()
      // 签名是 base64 编码的，解码后验证
      const decodedSignature = Buffer.from(signatureDelta.delta.signature, 'base64').toString(
        'utf-8'
      )
      expect(decodedSignature).toMatch(/^auto_gemini2_/)
    })

    it('should attach thinking signature to tool_use (gemini-cli official behavior)', () => {
      // 根据 gemini-cli 官方做法 (client.ts:186-213):
      // - stripThoughts 默认为 false，保留 thoughtSignature
      // - functionCall 必须携带 thoughtSignature，否则 API 报错
      const claudeBody = {
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'Analysis...',
                signature: 'sig_real'
              },
              {
                type: 'tool_use',
                id: 'tool_1',
                name: 'search',
                input: {}
              },
              {
                type: 'tool_use',
                id: 'tool_2',
                name: 'fetch',
                input: {}
              }
            ]
          }
        ],
        max_tokens: 100
      }

      const result = converter.convertRequest(claudeBody)

      const functionCalls = result.contents[0].parts.filter((p) => p.functionCall)
      // thinking 块被过滤，但 functionCall 必须携带 thoughtSignature
      expect(functionCalls.length).toBe(2)
      expect(functionCalls[0].thoughtSignature).toBe('sig_real')
      expect(functionCalls[1].thoughtSignature).toBe('sig_real')
    })

    it('should filter out thinking blocks from all messages (gemini-cli official behavior)', () => {
      // 根据 gemini-cli 官方做法 (geminiChat.ts:745):
      // thinking 块在所有历史消息中都被过滤掉
      const claudeBody = {
        messages: [
          // 历史消息 1 (带 thinking)
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'Historical thinking 1...',
                signature: 'hist_sig_1'
              },
              {
                type: 'tool_use',
                id: 'hist_tool_1',
                name: 'search',
                input: {}
              }
            ]
          },
          { role: 'user', content: 'Continue' },
          // 历史消息 2 (带 thinking)
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'Historical thinking 2...',
                signature: 'hist_sig_2'
              },
              {
                type: 'tool_use',
                id: 'hist_tool_2',
                name: 'fetch',
                input: {}
              }
            ]
          },
          { role: 'user', content: 'Continue again' },
          // 最新消息 (带 thinking)
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'Latest thinking...',
                signature: 'latest_sig'
              },
              {
                type: 'tool_use',
                id: 'latest_tool',
                name: 'execute',
                input: {}
              }
            ]
          }
        ],
        max_tokens: 100
      }

      const result = converter.convertRequest(claudeBody)

      // 获取所有 model 消息
      const modelMessages = result.contents.filter((c) => c.role === 'model')

      // 根据 gemini-cli 官方做法 (client.ts:186-213)：
      // - thinking 块被过滤（不出现在 parts 中）
      // - 但 thoughtSignature 被附加到 functionCall 上（stripThoughts 默认 false）
      const expectedSigs = ['hist_sig_1', 'hist_sig_2', 'latest_sig']
      modelMessages.forEach((msg, index) => {
        const functionCalls = msg.parts.filter((p) => p.functionCall)
        expect(functionCalls.length).toBe(1)
        // thoughtSignature 必须被保留在 functionCall 上
        expect(functionCalls[0].thoughtSignature).toBe(expectedSigs[index])
        // 不应该有 thought 相关的 part（思考内容被过滤）
        const thoughtParts = msg.parts.filter((p) => p.thought === true)
        expect(thoughtParts.length).toBe(0)
      })
    })
  })
})
