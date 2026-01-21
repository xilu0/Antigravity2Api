const { rememberToolThoughtSignature } = require("./ToolThoughtSignatureStore");
const { isMcpXmlEnabled, createMcpXmlStreamParser } = require("../../mcp/mcpXmlBridge");
const { makeToolUseId, toClaudeUsage } = require("./ClaudeResponseUtils");
const { buildNonStreamingWebSearchMessage } = require("./ClaudeWebSearchGrounding");

// ==================== 非流式处理器 ====================
class NonStreamingProcessor {
  constructor(rawJSON, options = {}) {
    this.raw = rawJSON;
    this.options = options;
    this.contentBlocks = [];
    this.textBuilder = "";
    this.thinkingBuilder = "";
    this.hasToolCall = false;
    this.hasThinking = false;
    // 分离两种签名来源：
    // thinkingSignature: 来自 thought=true 的 part，随 thinking 块输出
    // trailingSignature: 来自空普通文本的 part，在 process() 末尾用空 thinking 块承载
    this.thinkingSignature = null;
    this.trailingSignature = null;
    // 上游偶发：thought:true 的空 part 携带 thoughtSignature，后面紧跟 functionCall。
    // 对下游（Claude JSON）应表现为 thinking.signature，但我们仍需把它缓存为该 tool_use 的签名，供下一轮请求回填。
    this.pendingToolThoughtSignature = null;

    const mcpXmlToolNames = Array.isArray(options?.mcpXmlToolNames) ? options.mcpXmlToolNames : [];
    this.mcpXmlParser =
      isMcpXmlEnabled() && mcpXmlToolNames.length > 0 ? createMcpXmlStreamParser(mcpXmlToolNames) : null;
  }

  process() {
    const parts = this.raw.candidates?.[0]?.content?.parts || [];

    // 非流式可一次性预扫，确保“本次响应是否启用 thinking”判断不会被顺序影响
    this.hasThinking = parts.some((p) => p?.thought);

    for (const part of parts) {
      this.processPart(part);
    }

    if (this.mcpXmlParser) {
      const rest = this.mcpXmlParser.flush();
      for (const seg of rest) {
        if (seg?.type === "text" && seg.text) this.textBuilder += seg.text;
      }
    }

    // 刷新剩余内容（按原始顺序）
    this.flushThinking();
    this.flushText();

    // 处理空普通文本带签名的场景（PDF 776-778）
    // 签名在最后一个 part，但那是空文本，需要输出空 thinking 块承载签名
    // 注意：当本次响应完全没有 thinking（part.thought=true）时，丢弃 trailingSignature，
    // 避免在非 thinking 模式下返回额外的 thinking 块（Claude Code 兼容性）。
    if (this.trailingSignature && this.hasThinking) {
      this.contentBlocks.push({
        type: "thinking",
        thinking: "",
        signature: this.trailingSignature,
      });
      this.trailingSignature = null;
    } else if (this.trailingSignature) {
      this.trailingSignature = null;
    }

    return this.buildResponse();
  }

  processPart(part) {
    const signature = part.thoughtSignature;

    // pendingToolThoughtSignature 只用于“紧随空 thought part 的下一次 functionCall”。
    // 如果中间出现了非 functionCall 的实际内容（例如普通 text），则清空，避免误绑定到后续无关工具调用。
    const isEmptyThoughtPart = part?.thought && part?.text !== undefined && String(part.text).length === 0;
    if (this.pendingToolThoughtSignature && !part.functionCall && !isEmptyThoughtPart) {
      this.pendingToolThoughtSignature = null;
    }

    // FC 处理：先刷新之前的内容，再处理 FC（防止 FC 签名污染 thinking 块）
    if (part.functionCall) {
      // 对下游（Claude JSON）：签名应放在 thinking.signature（在 tool_use 之前），tool_use 不携带 signature 字段。
      // 但仍需缓存 tool_use.id -> signature，供下一轮请求回填到 Gemini functionCall part。

      // 若签名出现在 functionCall part 上，尽量把它作为“thinking 的签名”输出在 tool_use 之前。
      if (signature && this.hasThinking) {
        this.thinkingSignature = signature;
      }
      this.flushThinking();
      this.flushText();

      // 修复场景 B4/C3：空 text 带签名后跟 FC（Gemini 2.5 风格）
      // 必须先输出空 thinking 块承载 trailingSignature，再处理 FC
      if (this.trailingSignature) {
        // Claude Code 在未启用 thinking 时可能不接受 thinking 块；当本次响应未出现 thinking 时丢弃签名
        if (this.hasThinking) {
          this.contentBlocks.push({
            type: "thinking",
            thinking: "",
            signature: this.trailingSignature,
          });
        }
        this.trailingSignature = null;
      }

      // tool signature 载体：当上游未返回任何 thought:true part（includeThoughts 关闭），但 functionCall part 自带 thoughtSignature 时，
      // 在 tool_use 之前用一个空 thinking 块承载签名（避免把 signature 挂到 tool_use 上）。
      if (signature && !this.hasThinking) {
        this.contentBlocks.push({
          type: "thinking",
          thinking: "",
          signature,
        });
      }

      this.hasToolCall = true;

      // 优先复用上游的 functionCall.id
      const toolId =
        typeof part.functionCall.id === "string" && part.functionCall.id ? part.functionCall.id : makeToolUseId();

      const toolUseBlock = {
        type: "tool_use",
        id: toolId,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
      };

      const sigForToolCache = signature || this.pendingToolThoughtSignature;
      this.pendingToolThoughtSignature = null;
      if (sigForToolCache) {
        rememberToolThoughtSignature(toolId, sigForToolCache);
      }

      this.contentBlocks.push(toolUseBlock);
      return;
    }

    // 使用 !== undefined 判断，确保空字符串 thinking 也能正确处理签名
    if (part.text !== undefined) {
      if (part.thought) {
        this.flushText();

        // 修复：如果有 trailingSignature（来自之前的空 text），先输出空 thinking 块
        // 根据规范（PDF 44行）：签名必须在收到它的 part 位置返回
        if (this.trailingSignature) {
          this.flushThinking(); // 先刷新之前累积的 thinking
          if (this.hasThinking) {
            this.contentBlocks.push({
              type: "thinking",
              thinking: "",
              signature: this.trailingSignature,
            });
          }
          this.trailingSignature = null;
        }

        this.thinkingBuilder += part.text;
        // thinking 的签名暂存到 thinkingSignature，在 flushThinking 时消费
        if (signature) {
          this.thinkingSignature = signature;
          // 空 thought part 的签名可能对应后续的 functionCall：额外暂存一份用于 tool_use.id -> signature 缓存。
          if (part.text.length === 0) this.pendingToolThoughtSignature = signature;
        }
      } else {
        // 根据官方规范（PDF 行44）：签名必须在收到它的 part 位置返回
        // 非空 text 带签名时，先刷新当前 text，再输出空 thinking 块承载签名
        // 空 text 带签名时，暂存到 trailingSignature，在 process() 末尾消费
        if (part.text.length === 0) {
          // 空普通文本的签名暂存
          if (signature) {
            this.trailingSignature = signature;
          }
          return;
        }

        this.flushThinking();

        // 修复：如果有 trailingSignature（来自之前的空 text），先输出空 thinking 块
        // 根据规范（PDF 44行）：签名必须在收到它的 part 位置返回
        if (this.trailingSignature) {
          this.flushText(); // 先刷新之前累积的 text
          // Claude Code 在未启用 thinking 时可能不接受 thinking 块；当本次响应未出现 thinking 时丢弃签名
          if (this.hasThinking) {
            this.contentBlocks.push({
              type: "thinking",
              thinking: "",
              signature: this.trailingSignature,
            });
          }
          this.trailingSignature = null;
        }

        if (this.mcpXmlParser && !signature) {
          const segments = this.mcpXmlParser.pushText(part.text);
          for (const seg of segments) {
            if (seg?.type === "tool" && seg.name) {
              this.flushText();
              this.hasToolCall = true;
              this.contentBlocks.push({
                type: "tool_use",
                id: makeToolUseId(),
                name: seg.name,
                input: seg.input || {},
              });
            } else if (seg?.type === "text" && seg.text) {
              this.textBuilder += seg.text;
            }
          }
        } else {
          this.textBuilder += part.text;
        }

        // 非空 text 带签名：仅在本次响应里出现过 thinking 时才输出空 thinking 块承载签名；
        // 否则丢弃该签名，保持响应结构与官方一致（纯 text/tool_use）。
        if (signature && this.hasThinking) {
          this.flushText();
          this.contentBlocks.push({
            type: "thinking",
            thinking: "",
            signature: signature,
          });
        }
      }
    }
  }

  flushText() {
    if (this.textBuilder.length === 0) return;
    this.contentBlocks.push({
      type: "text",
      text: this.textBuilder,
    });
    this.textBuilder = "";
  }

  flushThinking() {
    // 如果没有 thinking 内容且没有 thinking 签名，直接返回
    // 有 thinkingSignature 时必须输出（即使 thinking 为空），保证签名在正确位置
    if (this.thinkingBuilder.length === 0 && !this.thinkingSignature) return;

    const block = {
      type: "thinking",
      thinking: this.thinkingBuilder || "",
    };

    // 如果有 thinking 签名，附加到 thinking 块
    if (this.thinkingSignature) {
      block.signature = this.thinkingSignature;
      this.thinkingSignature = null;
    }

    this.contentBlocks.push(block);
    this.thinkingBuilder = "";
  }

  buildResponse() {
    const finish = this.raw.candidates?.[0]?.finishReason;
    let stopReason = "end_turn";

    if (this.hasToolCall) {
      stopReason = "tool_use";
    } else if (finish === "MAX_TOKENS") {
      stopReason = "max_tokens";
    }

    const response = {
      id: this.raw.responseId || "",
      type: "message",
      role: "assistant",
      model: this.raw.modelVersion || "",
      content: this.contentBlocks,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: toClaudeUsage(this.raw.usageMetadata, { maxContextTokens: this.options?.maxContextTokens, log: true }),
    };

    // 如果没有 usage 数据，删除该字段
    if (response.usage.input_tokens === 0 && response.usage.output_tokens === 0) {
      if (!this.raw.usageMetadata) {
        delete response.usage;
      }
    }

    return response;
  }
}

// 处理非流式响应
async function handleNonStreamingResponse(response, options = {}) {
  let json = await response.json();
  json = json.response || json;

  // 捕获 usageMetadata 供回调使用
  const usageHolder = options?.usageHolder;
  if (usageHolder && json?.usageMetadata) {
    usageHolder.usage = json.usageMetadata;
  }

  // v1internal grounding(web search) -> Claude 的 server_tool_use/web_search_tool_result 结构
  const candidate = json?.candidates?.[0] || null;
  const groundingMetadata = candidate?.groundingMetadata || null;
  const hasWebSearchQueries =
    Array.isArray(groundingMetadata?.webSearchQueries) && typeof groundingMetadata.webSearchQueries[0] === "string";
  const hasGroundingChunks = Array.isArray(candidate?.groundingChunks) || Array.isArray(groundingMetadata?.groundingChunks);
  const hasGroundingSupports =
    Array.isArray(candidate?.groundingSupports) || Array.isArray(groundingMetadata?.groundingSupports);
  const isWebSearch = hasWebSearchQueries || hasGroundingChunks || hasGroundingSupports;

  if (isWebSearch) {
    const message = await buildNonStreamingWebSearchMessage(json, options, toClaudeUsage);
    if (options?.overrideModel) message.model = options.overrideModel;
    return new Response(JSON.stringify(message), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  const processor = new NonStreamingProcessor(json, options);
  const result = processor.process();
  if (options?.overrideModel) result.model = options.overrideModel;

  return new Response(JSON.stringify(result), {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}

module.exports = {
  handleNonStreamingResponse,
};

