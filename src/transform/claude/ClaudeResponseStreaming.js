const { rememberToolThoughtSignature } = require("./ToolThoughtSignatureStore");
const { isMcpXmlEnabled, createMcpXmlStreamParser } = require("../../mcp/mcpXmlBridge");
const { makeToolUseId, toClaudeUsage } = require("./ClaudeResponseUtils");
const {
  emitWebSearchBlocks,
  makeSrvToolUseId,
  resolveWebSearchRedirectUrls,
  toWebSearchResults,
} = require("./ClaudeWebSearchGrounding");

// ==================== 签名管理器 ====================
class SignatureManager {
  constructor() {
    this.pending = null;
  }

  // 存储签名
  store(signature) {
    if (signature) this.pending = signature;
  }

  // 消费并返回签名
  consume() {
    const sig = this.pending;
    this.pending = null;
    return sig;
  }

  // 是否有暂存的签名
  hasPending() {
    return !!this.pending;
  }
}

// ==================== 流式状态机 ====================
class StreamingState {
  // 块类型常量
  static BLOCK_NONE = 0;
  static BLOCK_TEXT = 1;
  static BLOCK_THINKING = 2;
  static BLOCK_FUNCTION = 3;

  constructor(encoder, controller) {
    this.encoder = encoder;
    this.controller = controller;
    this.blockType = StreamingState.BLOCK_NONE;
    this.blockIndex = 0;
    this.messageStartSent = false;
    this.messageStopSent = false;
    this.overrideModel = null;
    this.maxContextTokens = null;
    this.usedTool = false;
    this.hasThinking = false;
    this.signatures = new SignatureManager(); // thinking/FC 签名
    this.trailingSignature = null; // 空 text 带签名（必须单独用空 thinking 块承载）
    // 上游偶发：thought:true 的空 part 携带 thoughtSignature，后面紧跟 functionCall。
    // 对下游（Claude SSE）应表现为 thinking 的 signature_delta，但我们仍需把它缓存为该 tool_use 的签名，供下一轮请求回填。
    this.pendingToolThoughtSignature = null;

    // web_search（grounding）专用：先实时输出 thinking，再在 finish 时补齐 server_tool_use / tool_result / citations / 最终文本
    this.webSearchMode = false;
    this.webSearch = {
      toolUseId: null,
      query: "",
      results: [],
      supports: [],
      bufferedTextParts: [],
    };
  }

  // 发送 SSE 事件
  emit(eventType, data) {
    this.controller.enqueue(this.encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`));
  }

  // 发送 message_start 事件
  emitMessageStart(rawJSON) {
    if (this.messageStartSent) return;

    // message_start 包含初始 usage (input tokens)，output_tokens 为 0
    // 最终 usage 在 message_delta 中更新
    const usage = rawJSON.usageMetadata ? toClaudeUsage(rawJSON.usageMetadata, { maxContextTokens: this.maxContextTokens }) : undefined;

    this.emit("message_start", {
      type: "message_start",
      message: {
        id: rawJSON.responseId || "msg_" + Math.random().toString(36).substring(2),
        type: "message",
        role: "assistant",
        content: [],
        model: this.overrideModel || rawJSON.modelVersion,
        stop_reason: null,
        stop_sequence: null,
        ...(usage ? { usage } : {}),
      },
    });
    this.messageStartSent = true;
  }

  // 开始新的内容块
  startBlock(type, contentBlock) {
    if (this.blockType !== StreamingState.BLOCK_NONE) {
      this.endBlock();
    }

    // Claude 官方 SSE：thinking block start 总是带 signature 字段（即便为空串）
    if (contentBlock?.type === "thinking" && !Object.prototype.hasOwnProperty.call(contentBlock, "signature")) {
      contentBlock = { ...contentBlock, signature: "" };
    }

    this.emit("content_block_start", {
      type: "content_block_start",
      index: this.blockIndex,
      content_block: contentBlock,
    });
    this.blockType = type;
  }

  // 结束当前内容块
  endBlock() {
    if (this.blockType === StreamingState.BLOCK_NONE) return;

    // 如果是 thinking 块结束，先发送暂存的签名（来自 thinking part）
    if (this.blockType === StreamingState.BLOCK_THINKING && this.signatures.hasPending()) {
      this.emitDelta("signature_delta", { signature: this.signatures.consume() });
    }

    this.emit("content_block_stop", {
      type: "content_block_stop",
      index: this.blockIndex,
    });
    this.blockIndex++;
    this.blockType = StreamingState.BLOCK_NONE;
  }

  // 发送 delta 事件
  emitDelta(deltaType, deltaContent) {
    this.emit("content_block_delta", {
      type: "content_block_delta",
      index: this.blockIndex,
      delta: { type: deltaType, ...deltaContent },
    });
  }

  // 发送结束事件
  emitFinish(finishReason, usageMetadata, extraUsage) {
    // 关闭最后一个块
    this.endBlock();

    // 根据官方文档（PDF 776-778 行）：签名可能在空文本 part 上返回
    // trailingSignature 是来自空 text part 的签名，必须用独立的空 thinking 块承载
    // 不能附加到之前的 thinking 块（签名必须在收到它的 part 位置返回）
    // 注意：Claude Code 在未启用 thinking 时可能不接受 thinking 块。
    // 当本次响应里没有出现任何 thinking（part.thought=true）时，丢弃 trailingSignature，
    // 以保持响应结构与官方一致（纯 text/tool_use）。
    if (this.trailingSignature && this.hasThinking) {
      this.emit("content_block_start", {
        type: "content_block_start",
        index: this.blockIndex,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      this.emitDelta("thinking_delta", { thinking: "" });
      this.emitDelta("signature_delta", { signature: this.trailingSignature });
      this.emit("content_block_stop", {
        type: "content_block_stop",
        index: this.blockIndex,
      });
      this.blockIndex++;
      this.trailingSignature = null;
    } else if (this.trailingSignature) {
      this.trailingSignature = null;
    }

    // 确定 stop_reason
    let stopReason = "end_turn";
    if (this.usedTool) {
      stopReason = "tool_use";
    } else if (finishReason === "MAX_TOKENS") {
      stopReason = "max_tokens";
    }

    const usage = toClaudeUsage(usageMetadata || {}, { maxContextTokens: this.maxContextTokens, log: true });
    const mergedUsage = extraUsage && typeof extraUsage === "object" ? { ...usage, ...extraUsage } : usage;

    this.emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: mergedUsage,
    });

    if (!this.messageStopSent) {
      this.controller.enqueue(this.encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
      this.messageStopSent = true;
    }
  }
}

// ==================== Part 处理器 ====================
class PartProcessor {
  constructor(state) {
    this.state = state;
  }

  // 处理单个 part
  process(part) {
    const signature = part.thoughtSignature;

    // pendingToolThoughtSignature 只用于“紧随空 thought part 的下一次 functionCall”。
    // 如果中间出现了非 functionCall 的实际内容（例如普通 text），则清空，避免误绑定到后续无关工具调用。
    const isEmptyThoughtPart = part?.thought && part?.text !== undefined && String(part.text).length === 0;
    if (this.state.pendingToolThoughtSignature && !part.functionCall && !isEmptyThoughtPart) {
      this.state.pendingToolThoughtSignature = null;
    }

    // 函数调用处理
    // 根据官方文档（PDF 44行）：签名必须原样返回到收到签名的那个 part
    // - Gemini 3 Pro：签名在第一个 FC（PDF 784行）
    // - Gemini 2.5：签名在第一个 part，不论类型（PDF 785行）
    // 所以 FC 只使用自己的签名，不消费 thinking 的签名
    if (part.functionCall) {
      // 修复场景 B4/C3：空 text 带签名后跟 FC
      // 必须先输出空 thinking 块承载 trailingSignature，再处理 FC
      if (this.state.trailingSignature) {
        // Claude Code 在未启用 thinking 时可能不接受 thinking 块；当本次响应未出现 thinking 时丢弃签名
        if (this.state.hasThinking) {
          this.state.startBlock(StreamingState.BLOCK_THINKING, { type: "thinking", thinking: "" });
          this.state.emitDelta("thinking_delta", { thinking: "" });
          this.state.emitDelta("signature_delta", { signature: this.state.trailingSignature });
          this.state.endBlock();
        }
        this.state.trailingSignature = null;
      }

      const sigForToolCache = signature || this.state.pendingToolThoughtSignature;
      this.state.pendingToolThoughtSignature = null;

      // 对下游（Claude SSE）：签名应跟随 thinking 的 signature_delta，而非挂到 tool_use 上。
      // 若签名出现在 functionCall part 上，尽量把它作为“thinking 的签名”输出在 tool_use 之前。
      if (signature) {
        if (this.state.blockType === StreamingState.BLOCK_THINKING) {
          this.state.signatures.store(signature);
        } else {
          // tool signature 载体：在 tool_use 之前用一个空 thinking 块输出 signature_delta
          this.state.startBlock(StreamingState.BLOCK_THINKING, { type: "thinking", thinking: "" });
          this.state.emitDelta("thinking_delta", { thinking: "" });
          this.state.emitDelta("signature_delta", { signature });
          this.state.endBlock();
        }
      }

      this.processFunctionCall(part.functionCall, sigForToolCache);
      return;
    }

    // 空 text 带签名：暂存到 trailingSignature，不能混入 thinking 的签名
    if (part.text !== undefined && !part.thought && part.text.length === 0) {
      if (signature) {
        this.state.trailingSignature = signature;
      }
      return;
    }

    if (part.text !== undefined) {
      if (part.thought) {
        // thinking 场景
        this.state.hasThinking = true;

        // 修复：如果有 trailingSignature（来自之前的空 text），先输出空 thinking 块
        // 根据规范（PDF 44行）：签名必须在收到它的 part 位置返回
        if (this.state.trailingSignature) {
          this.state.startBlock(StreamingState.BLOCK_THINKING, { type: "thinking", thinking: "" });
          this.state.emitDelta("thinking_delta", { thinking: "" });
          this.state.emitDelta("signature_delta", { signature: this.state.trailingSignature });
          this.state.endBlock();
          this.state.trailingSignature = null;
        }

        this.processThinking(part.text);
        // 签名暂存，在 thinking 块结束时发送
        if (signature) {
          this.state.signatures.store(signature);
          // 空 thought part 的签名可能对应后续的 functionCall：额外暂存一份用于 tool_use.id -> signature 缓存。
          if (part.text.length === 0) this.state.pendingToolThoughtSignature = signature;
        }
      } else {
        // 非 thinking text 场景

        // 修复：如果有 trailingSignature（来自之前的空 text），先输出空 thinking 块
        // 根据规范（PDF 44行）：签名必须在收到它的 part 位置返回
        if (this.state.trailingSignature) {
          // Claude Code 在未启用 thinking 时可能不接受 thinking 块；当本次响应未出现 thinking 时丢弃签名
          if (this.state.hasThinking) {
            this.state.startBlock(StreamingState.BLOCK_THINKING, { type: "thinking", thinking: "" });
            this.state.emitDelta("thinking_delta", { thinking: "" });
            this.state.emitDelta("signature_delta", { signature: this.state.trailingSignature });
            this.state.endBlock();
          }
          this.state.trailingSignature = null;
        }

        if (signature) {
          // Claude Code 在未启用 thinking 时可能不接受 thinking 块；
          // 对于「text 上的 thoughtSignature」在无 thinking 的响应中直接忽略，保持官方同款结构。
          if (!this.state.hasThinking) {
            this.processText(part.text);
            return;
          }
          // 根据规范（PDF 行44）：非空 text 带签名必须立即处理，不能合并到当前 text 块
          // 1. 先关闭当前块
          this.state.endBlock();
          // 2. 开始新 text 块并发送内容
          this.state.startBlock(StreamingState.BLOCK_TEXT, { type: "text", text: "" });
          this.state.emitDelta("text_delta", { text: part.text });
          // 3. 关闭 text 块
          this.state.endBlock();
          // 4. 创建空 thinking 块承载签名（Claude 格式限制：text 不支持 signature）
          this.state.emit("content_block_start", {
            type: "content_block_start",
            index: this.state.blockIndex,
            content_block: { type: "thinking", thinking: "", signature: "" },
          });
          this.state.emitDelta("thinking_delta", { thinking: "" });
          this.state.emitDelta("signature_delta", { signature });
          this.state.emit("content_block_stop", {
            type: "content_block_stop",
            index: this.state.blockIndex,
          });
          this.state.blockIndex++;
        } else {
          this.processTextWithMcpXml(part.text);
        }
      }
      return;
    }
  }

  // 处理 thinking 内容（签名由调用方在 process() 中处理）
  processThinking(text) {
    if (this.state.blockType === StreamingState.BLOCK_THINKING) {
      // 继续 thinking
      this.state.emitDelta("thinking_delta", { thinking: text });
    } else {
      // 开始新的 thinking 块
      this.state.startBlock(StreamingState.BLOCK_THINKING, { type: "thinking", thinking: "" });
      this.state.emitDelta("thinking_delta", { thinking: text });
    }
  }

  // 处理普通文本
  processText(text) {
    if (this.state.blockType === StreamingState.BLOCK_TEXT) {
      // 继续 text
      this.state.emitDelta("text_delta", { text });
    } else {
      // 开始新的 text 块
      this.state.startBlock(StreamingState.BLOCK_TEXT, { type: "text", text: "" });
      this.state.emitDelta("text_delta", { text });
    }
  }

  processTextWithMcpXml(text) {
    const parser = this.state?.mcpXmlParser;
    if (!parser) {
      this.processText(text);
      return;
    }

    const segments = parser.pushText(text);
    for (const seg of segments) {
      if (seg?.type === "tool" && seg.name) {
        this.processFunctionCall({ name: seg.name, args: seg.input || {} }, null);
      } else if (seg?.type === "text" && seg.text) {
        this.processText(seg.text);
      }
    }
  }

  // 处理函数调用
  processFunctionCall(fc, sigForToolCache) {
    // 对下游（Claude SSE）：签名通过 thinking.signature_delta 输出；tool_use 不携带 signature 字段。
    // 但仍需缓存 tool_use.id -> signature，供下一轮请求回填到 Gemini functionCall part。
    const toolId = typeof fc.id === "string" && fc.id ? fc.id : makeToolUseId();

    const toolUseBlock = {
      type: "tool_use",
      id: toolId,
      name: fc.name,
      input: {},
    };

    if (sigForToolCache) {
      rememberToolThoughtSignature(toolId, sigForToolCache);
    }

    this.state.startBlock(StreamingState.BLOCK_FUNCTION, toolUseBlock);

    if (fc.args) {
      this.state.emitDelta("input_json_delta", { partial_json: JSON.stringify(fc.args) });
    }

    this.state.usedTool = true;
  }
}

// 处理流式响应
async function handleStreamingResponse(response, options = {}) {
  if (!response.body) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // 用于捕获最终 usageMetadata 的 holder（供外部回调使用）
  const usageHolder = options?.usageHolder;

  const stream = new ReadableStream({
    async start(controller) {
      const state = new StreamingState(encoder, controller);
      if (options?.overrideModel) state.overrideModel = options.overrideModel;
      if (options?.maxContextTokens && Number.isFinite(options.maxContextTokens)) {
        state.maxContextTokens = options.maxContextTokens;
      }
      const mcpXmlToolNames = Array.isArray(options?.mcpXmlToolNames) ? options.mcpXmlToolNames : [];
      if (isMcpXmlEnabled() && mcpXmlToolNames.length > 0) {
        state.mcpXmlParser = createMcpXmlStreamParser(mcpXmlToolNames);
      }
      // 保存 usageHolder 引用到 state，供 processSSELine 使用
      state.usageHolder = usageHolder;
      const processor = new PartProcessor(state);

      try {
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            await processSSELine(line, state, processor);
          }
        }

        // 处理剩余 buffer
        if (buffer) {
          await processSSELine(buffer, state, processor);
        }
      } catch (error) {
        controller.error(error);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: response.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// 处理单行 SSE 数据
async function processSSELine(line, state, processor) {
  if (!line.startsWith("data: ")) return;

  const dataStr = line.slice(6).trim();
  if (!dataStr) return;

  if (dataStr === "[DONE]") {
    if (!state.messageStopSent) {
      state.controller.enqueue(state.encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
      state.messageStopSent = true;
    }
    return;
  }

  try {
    let chunk = JSON.parse(dataStr);
    const rawJSON = chunk.response || chunk;

    const candidate = rawJSON.candidates?.[0] || null;
    const hasGrounding =
      candidate &&
      (Object.prototype.hasOwnProperty.call(candidate, "groundingMetadata") ||
        Object.prototype.hasOwnProperty.call(candidate, "groundingChunks") ||
        Object.prototype.hasOwnProperty.call(candidate, "groundingSupports"));

    // 发送 message_start
    state.emitMessageStart(rawJSON);

    // 进入 web_search 模式（基于 grounding 字段）
    if (!state.webSearchMode && hasGrounding) {
      state.webSearchMode = true;
      state.webSearch.toolUseId = makeSrvToolUseId();
    }

    // 处理所有 parts
    const parts = candidate?.content?.parts || [];
    if (!state.webSearchMode) {
      for (const part of parts) processor.process(part);
    } else {
      // web_search 模式：thinking 实时输出；非 thinking 文本缓存到最后一个 text block 再输出
      for (const part of parts) {
        if (part?.text === undefined) continue;
        if (part.thought) {
          processor.process(part);
        } else {
          state.webSearch.bufferedTextParts.push(String(part.text));
        }
      }

      // 更新 grounding 数据（通常在最后一个 chunk 才完整出现）
      const webSearchQueries = candidate?.groundingMetadata?.webSearchQueries;
      if (Array.isArray(webSearchQueries) && typeof webSearchQueries[0] === "string") {
        state.webSearch.query = webSearchQueries[0];
      }
      const groundingChunks = Array.isArray(candidate?.groundingChunks)
        ? candidate.groundingChunks
        : candidate?.groundingMetadata?.groundingChunks;
      if (Array.isArray(groundingChunks)) {
        state.webSearch.results = toWebSearchResults(groundingChunks);
      }
      const groundingSupports = Array.isArray(candidate?.groundingSupports)
        ? candidate.groundingSupports
        : candidate?.groundingMetadata?.groundingSupports;
      if (Array.isArray(groundingSupports)) {
        state.webSearch.supports = groundingSupports;
      }
    }

    // 检查是否结束
    const finishReason = candidate?.finishReason;
    if (finishReason) {
      // 捕获最终 usageMetadata 供回调使用
      if (state.usageHolder && rawJSON.usageMetadata) {
        state.usageHolder.usage = rawJSON.usageMetadata;
      }

      if (!state.webSearchMode) {
        if (state.mcpXmlParser) {
          const rest = state.mcpXmlParser.flush();
          for (const seg of rest) {
            if (seg?.type === "text" && seg.text) processor.processText(seg.text);
          }
        }
        state.emitFinish(finishReason, rawJSON.usageMetadata);
        return;
      }

      // web_search：在 message_delta 前补齐 server_tool_use / tool_result / citations / 最终文本
      await resolveWebSearchRedirectUrls(state.webSearch);
      emitWebSearchBlocks(state, StreamingState);
      state.emitFinish(finishReason, rawJSON.usageMetadata, {
        server_tool_use: { web_search_requests: 1 },
      });
    }
  } catch (e) {
    // 解析失败：默认打印（不节流），但不打断整个流
    try {
      const message = e && typeof e === "object" && "message" in e ? e.message : String(e);
      console.error("[ClaudeTransform] SSE parse error:", message);
      console.error("[ClaudeTransform] SSE data sample:", String(dataStr).slice(0, 2000));
    } catch (_) {}
  }
}

module.exports = {
  handleStreamingResponse,
};
