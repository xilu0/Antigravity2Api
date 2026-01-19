const fs = require("fs");
const path = require("path");
const { maybeInjectMcpHintIntoSystemText } = require("../../mcp/claudeTransformerMcp");
const {
  isMcpXmlEnabled,
  getMcpTools,
  buildMcpXmlSystemPrompt,
  isMcpToolName,
  buildMcpToolCallXml,
  buildMcpToolResultXml,
} = require("../../mcp/mcpXmlBridge");
const { getToolThoughtSignature, deleteToolThoughtSignature, rememberToolThoughtSignature, isDebugEnabled } = require("./ToolThoughtSignatureStore");
const { cleanJsonSchema, extractInlineDataPartsFromClaudeToolResultContent } = require("./ClaudeRequestUtils");

function normalizeAntigravitySystemInstructionText(text) {
  if (typeof text !== "string") return "";
  // Allow the file to be pasted from JSON logs (single line with literal "\n"/"\t" escapes).
  if (!text.includes("\n") && text.includes("\\n")) {
    return text
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "\r")
      .replace(/\\\\/g, "\\");
  }
  return text;
}

let antigravitySystemInstructionText = "";
try {
  antigravitySystemInstructionText = fs.readFileSync(path.resolve(__dirname, "antigravity_system_instruction.txt"), "utf8");
  antigravitySystemInstructionText = normalizeAntigravitySystemInstructionText(antigravitySystemInstructionText);
} catch (_) {}

/**
 * Claude 模型名映射到 Gemini 模型名
 */
function mapClaudeModelToGemini(claudeModel) {
  const supportedModels = [
    "claude-opus-4-5-thinking",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-thinking",
    "gemini-3-pro-high",
    "gemini-3-pro-low",
    "gemini-3-flash",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gpt-oss-120b-medium",
  ];
  if (supportedModels.includes(claudeModel)) return claudeModel;

  const mapping = {
    "claude-sonnet-4-5-20250929": "claude-sonnet-4-5-thinking",
    "claude-opus-4-5-20251101": "claude-opus-4-5-thinking",
    "claude-opus-4-5": "claude-opus-4-5-thinking",
  };
  return mapping[claudeModel];
}

/**
 * 转换 Claude 请求为 v1internal 请求 body（不包含 URL/Authorization）。
 * @param {Object} claudeReq - Claude 格式的请求
 * @param {string} projectId - 项目 ID
 * @param {Object} [options]
 * @param {boolean} [options.forwardThoughtSignatures=true] - 是否转发 thoughtSignature / thought=true
 * @param {number} [options.signatureSegmentStartIndex] - 只转发 messages[>=start] 内的签名（用于跨模型段隔离）
 * @returns {{ body: object }} 包含 v1internal body 的对象
 */
function transformClaudeRequestIn(claudeReq, projectId, options = {}) {
  // 需要 crypto 模块生成 requestId
  const crypto = require("crypto");

  const hasWebSearchTool = Array.isArray(claudeReq.tools) && claudeReq.tools.some((tool) => tool?.name === "web_search");

  const isClaudeModel = String(mapClaudeModelToGemini(claudeReq.model)).startsWith("claude");
  const mcpXmlEnabled = isMcpXmlEnabled() && getMcpTools(claudeReq?.tools).length > 0;

  // thoughtSignature（Thought Signatures 协议）：
  // - 同模型链路（Claude↔Claude / Gemini↔Gemini）必须原样转发，否则会出现签名缺失/不匹配导致 400。
  // - 跨模型切换时应在路由层按“段”清洗（避免把上一段模型签名带到另一段上游）。
  const forwardThoughtSignaturesByDefault = options?.forwardThoughtSignatures !== false;
  const signatureSegmentStartIndex = Number.isInteger(options?.signatureSegmentStartIndex) ? options.signatureSegmentStartIndex : null;

  // 记录 tool_use id 到 name 的映射，便于后续 tool_result 还原函数名
  const toolIdToName = new Map();

  // 1. System Instruction
  let systemInstruction = undefined;
  if (claudeReq.system) {
    const systemParts = [];
    let injectedMcpHintIntoSystem = false;
    if (Array.isArray(claudeReq.system)) {
      for (const item of claudeReq.system) {
        if (item && item.type === "text") {
          let text = item.text || "";
          // Claude Code 会注入一整段“CLI 工具说明/内置工具列表/使用规则”等超长提示词；
          // 对上游模型没有必要且容易触发 "Prompt is too long"，这里直接丢弃该段。
          // if (
          //   typeof text === "string" &&
          //   text.includes("You are an interactive CLI tool that helps users with software engineering tasks.")
          // ) {
          //   continue;
          // }
          if (!mcpXmlEnabled) {
            const injectedResult = maybeInjectMcpHintIntoSystemText({
              text,
              claudeReq,
              isClaudeModel,
              injected: injectedMcpHintIntoSystem,
            });
            text = injectedResult.text;
            injectedMcpHintIntoSystem = injectedResult.injected;
          }
          systemParts.push({ text });
        }
      }
    } else if (typeof claudeReq.system === "string") {
      systemParts.push({ text: claudeReq.system });
    }

    if (systemParts.length > 0) {
      systemInstruction = {
        role: "user",
        parts: systemParts,
      };
    }
  }

  // Some upstream models (e.g. claude-*, gemini-3-pro*) require an Antigravity-style systemInstruction,
  // otherwise they may respond with 429 RESOURCE_EXHAUSTED even when quota exists.
  const modelNameForSystem = String(claudeReq?.model || "").toLowerCase();
  if ((modelNameForSystem.includes("claude") || modelNameForSystem.includes("gemini")) && antigravitySystemInstructionText) {
    if (systemInstruction && Array.isArray(systemInstruction.parts)) {
      let replaced = false;
      for (const part of systemInstruction.parts) {
        if (typeof part?.text === "string" && part.text.includes("You are Claude Code")) {
          part.text = antigravitySystemInstructionText;
          replaced = true;
        }
      }
      // If no Claude Code marker was found, prepend an Antigravity-style instruction.
      if (!replaced) {
        systemInstruction.parts.unshift({ text: antigravitySystemInstructionText });
      }
      systemInstruction.role = "user";
    } else {
      systemInstruction = {
        role: "user",
        parts: [{ text: antigravitySystemInstructionText }],
      };
    }
  }

  // MCP XML 方案：仅针对 mcp__* 工具，注入 XML 调用协议提示词（只影响上游）
  if (mcpXmlEnabled) {
    const mcpTools = getMcpTools(claudeReq?.tools);
    const mcpXmlPrompt = buildMcpXmlSystemPrompt(mcpTools);
    if (mcpXmlPrompt) {
      if (systemInstruction && Array.isArray(systemInstruction.parts)) {
        systemInstruction.parts.push({ text: mcpXmlPrompt });
      } else {
        systemInstruction = { role: "user", parts: [{ text: mcpXmlPrompt }] };
      }
    }
  }

  // 2. Contents (Messages)
  const contents = [];
  // Claude Code / 部分客户端会在每次 tool_result 后重复附带同一句“任务指令”文本。
  // 这通常只是上下文回显，并非新指令；为避免上游模型每轮都被重复文本误导，这里做一次轻量去重：
  // - 仅在「tool_result 后紧跟的 text」与上一轮用户任务文本完全一致（忽略空白）时跳过该 text。
  let lastUserTaskTextNormalized = null;
  if (claudeReq.messages) {
    for (let msgIndex = 0; msgIndex < claudeReq.messages.length; msgIndex++) {
      const msg = claudeReq.messages[msgIndex];
      const shouldForwardThoughtSignatures =
        forwardThoughtSignaturesByDefault && (signatureSegmentStartIndex == null || msgIndex >= signatureSegmentStartIndex);
      let role = msg.role;
      if (role === "assistant") {
        role = "model";
      }

      const clientContent = { role, parts: [] };
      // Claude extended-thinking blocks must be leading within an assistant message. If we ever see a
      // thinking block after any non-thinking content (text/tool/image/etc), drop it to avoid invalid
      // thought parts (and leaking late "thinking" as plain text).
      let sawNonThinkingContent = false;
      let previousWasToolResult = false;
      // Claude thinking.signature -> Gemini thoughtSignature 的归属：在该项目里，签名应附着到同一条 assistant
      // message 中「紧随 thinking 的下一个输出 part」，且当该 message 存在 tool_use 时优先附着到第一个 functionCall part。
      // 这是为了匹配 ai.google.dev Thought Signatures 的示例：签名出现在 functionCall/text part 上，而非 thought part 上。
      let pendingThoughtSignature = null;
      const messageHasFunctionCallToolUse =
        role === "model" &&
        Array.isArray(msg.content) &&
        msg.content.some((it) => it && it.type === "tool_use" && !(mcpXmlEnabled && isMcpToolName(it?.name)));

      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item.type === "text") {
            const text = typeof item.text === "string" ? item.text : "";
            if (!text || text === "(no content)") continue;
            if (
              role === "user" &&
              previousWasToolResult &&
              lastUserTaskTextNormalized &&
              text.replace(/\s+/g, "") === lastUserTaskTextNormalized
            ) {
              // Skip duplicated task text echoed after tool_result.
              previousWasToolResult = false;
              continue;
            }
            const part = { text };
            if (
              pendingThoughtSignature &&
              shouldForwardThoughtSignatures &&
              role === "model" &&
              !messageHasFunctionCallToolUse &&
              !part.thoughtSignature
            ) {
              part.thoughtSignature = pendingThoughtSignature;
              pendingThoughtSignature = null;
            }
            clientContent.parts.push(part);
            sawNonThinkingContent = true;
            previousWasToolResult = false;
            if (role === "user") lastUserTaskTextNormalized = text.replace(/\s+/g, "");
          } else if (item.type === "thinking") {
            // 根据官方文档：签名必须在收到签名的那个 part 上原样返回
            // 重要：我们在 response 侧会用一个空的 Claude "thinking" block 来承载“空 text part 的 thoughtSignature”（Claude text 不支持 signature）。
            // 这个 block 本质上是“空 text + signature”，不应当在 v1internal 中还原成 thought=true（否则会上游被当作 thinking block 校验，可能触发 400）。
            const thinkingText = typeof item.thinking === "string" ? item.thinking : "";
            const signature = typeof item.signature === "string" ? item.signature : "";

            // 避免请求侧发送空字符串字段（部分上游会直接 400）
            if (thinkingText.length === 0) {
              // signature-only thinking block：用作签名载体，等待附着到下一个输出 part；
              // 若本条 message 后续没有可承载的输出 part，再在 message 末尾兜底回填。
              if (signature && shouldForwardThoughtSignatures) {
                pendingThoughtSignature = signature;
              }
              continue;
            }

            // thinking blocks must be leading within the assistant message.
            if (sawNonThinkingContent) continue;

            // 记录签名，后续尽量附着到紧随其后的非 thought part（text / functionCall）。
            if (signature && shouldForwardThoughtSignatures) {
              pendingThoughtSignature = signature;
            }

            // 注意：签名不附着到 thought part，保持与官方示例一致（签名在 functionCall/text part）。
            // 当禁用签名转发时，降级为普通 text part，避免跨模型段污染。
            if (shouldForwardThoughtSignatures) {
              clientContent.parts.push({ text: thinkingText, thought: true });
            } else {
              clientContent.parts.push({ text: thinkingText });
              sawNonThinkingContent = true;
            }
            previousWasToolResult = false;
          } else if (item.type === "redacted_thinking") {
            const text = typeof item.data === "string" ? item.data : "";
            if (!text) continue;
            if (sawNonThinkingContent) continue;
            // redacted_thinking 同样可能没有签名，按普通文本降级，避免上游签名校验报错
            clientContent.parts.push({ text });
            sawNonThinkingContent = true;
            previousWasToolResult = false;
          } else if (item.type === "image") {
            // Handle image
            const source = item.source || {};
            if (source.type === "base64") {
              clientContent.parts.push({
                inlineData: {
                  mimeType: source.media_type || "image/png",
                  data: source.data || "",
                },
              });
              sawNonThinkingContent = true;
            }
            previousWasToolResult = false;
          } else if (item.type === "tool_use") {
            if (mcpXmlEnabled && isMcpToolName(item?.name)) {
              if (item.id && item.name) {
                toolIdToName.set(item.id, item.name);
              }
              clientContent.parts.push({ text: buildMcpToolCallXml(item.name, item.input || {}) });
              sawNonThinkingContent = true;
              previousWasToolResult = false;
              continue;
            }
            // 根据官方文档：签名必须在收到签名的那个 functionCall part 上原样返回
            const fcPart = {
              functionCall: {
                name: item.name,
                args: item.input || {},
                id: item.id,
              },
            };
            if (item.id && item.name) {
              toolIdToName.set(item.id, item.name);
            }
            // Claude Code：一旦开始回传 tool_use.signature，后续会持续回传；此时本地缓存可删除。
            if (typeof item.signature === "string" && item.signature) {
              deleteToolThoughtSignature(item.id);
            }
            const pendingSig = shouldForwardThoughtSignatures ? pendingThoughtSignature : null;

            // 优先使用“下游回传”的签名（tool_use.signature 或紧邻的 thinking.signature），保证严格按收到的值回放。
            // 只有当下游没有回传时，才从本地缓存补回（Claude Code 通常不会回传 tool_use.signature）。
            let sig = null;
            if (typeof item.signature === "string" && item.signature) {
              sig = item.signature;
            } else if (pendingSig) {
              sig = pendingSig;
              // 下游回传了签名，更新缓存（而非删除）以备后续请求中签名丢失时恢复。
              if (item.id) rememberToolThoughtSignature(item.id, sig);
            } else {
              sig = getToolThoughtSignature(item.id);
            }

            // 消费 pending：无论是否使用（例如 tool_use 已自带签名），都认为已到达“thinking 之后的第一个输出 part”。
            if (pendingSig) pendingThoughtSignature = null;
            if (sig && shouldForwardThoughtSignatures && !fcPart.thoughtSignature) {
              fcPart.thoughtSignature = sig;
              if (!item.signature && isDebugEnabled() && item.id && sig !== pendingSig) {
                console.log(`[ThoughtSignature] injected tool_use.id=${item.id}`);
              }
            }
            clientContent.parts.push(fcPart);
            sawNonThinkingContent = true;
            previousWasToolResult = false;
          } else if (item.type === "tool_result") {
            // 优先用先前记录的 tool_use id -> name 映射，还原原始函数名
            let funcName = toolIdToName.get(item.tool_use_id) || item.tool_use_id;

            const rawContent = item.content;
            const extracted = extractInlineDataPartsFromClaudeToolResultContent(rawContent);
            const contentText = extracted.contentText || "";
            const isError = item.is_error === true;

            if (mcpXmlEnabled && isMcpToolName(funcName)) {
              clientContent.parts.push({
                text: buildMcpToolResultXml(funcName, item.tool_use_id, contentText, {
                  is_error: isError,
                  content: extracted.sanitizedContent,
                }),
              });
              if (extracted.inlineParts.length > 0) {
                clientContent.parts.push(...extracted.inlineParts);
              }
            } else if (mcpXmlEnabled && funcName === item.tool_use_id) {
              // Best-effort fallback: unknown tool name, but still wrap as MCP result text.
              clientContent.parts.push({
                text: buildMcpToolResultXml("", item.tool_use_id, contentText, {
                  is_error: isError,
                  content: extracted.sanitizedContent,
                }),
              });
              if (extracted.inlineParts.length > 0) {
                clientContent.parts.push(...extracted.inlineParts);
              }
            } else {
              clientContent.parts.push({
                functionResponse: {
                  name: funcName,
                  response: { result: contentText, is_error: isError, content: extracted.sanitizedContent },
                  id: item.tool_use_id,
                },
              });
              if (extracted.inlineParts.length > 0) {
                clientContent.parts.push(...extracted.inlineParts);
              }
            }
            sawNonThinkingContent = true;
            previousWasToolResult = true;
          }
        }
      } else if (typeof msg.content === "string") {
        const text = msg.content;
        if (text) {
          clientContent.parts.push({ text });
          if (role === "user") lastUserTaskTextNormalized = String(text).replace(/\s+/g, "");
        }
      }

      // 如果遇到“signature-only thinking block”但后面没有任何可承载的输出 part，作为兜底把签名回填到上一条可承载的 part。
      if (pendingThoughtSignature && shouldForwardThoughtSignatures && role === "model") {
        for (let i = clientContent.parts.length - 1; i >= 0; i--) {
          const p = clientContent.parts[i];
          if (!p || typeof p !== "object" || p.thoughtSignature) continue;
          if (p.functionCall) {
            p.thoughtSignature = pendingThoughtSignature;
            pendingThoughtSignature = null;
            break;
          }
          if (typeof p.text === "string" && p.thought !== true && p.text.length > 0) {
            p.thoughtSignature = pendingThoughtSignature;
            pendingThoughtSignature = null;
            break;
          }
        }
      }

      // Claude tool-use protocol is strict: when the previous assistant message contains tool_use,
      // the next user message must provide tool_result blocks immediately. If we mix MCP XML text
      // results with regular functionResponse parts, ensure functionResponse (and their inlineData
      // attachments) come first so upstream validation doesn't treat tool_results as "missing".
      if (role === "user" && clientContent.parts.length > 0) {
        const hasFunctionResponse = clientContent.parts.some((p) => p && p.functionResponse);
        if (hasFunctionResponse) {
          const reordered = [];
          const deferred = [];
          for (let i = 0; i < clientContent.parts.length; i++) {
            const part = clientContent.parts[i];
            if (part && part.functionResponse) {
              reordered.push(part);
              while (
                i + 1 < clientContent.parts.length &&
                clientContent.parts[i + 1] &&
                typeof clientContent.parts[i + 1] === "object" &&
                clientContent.parts[i + 1].inlineData
              ) {
                reordered.push(clientContent.parts[i + 1]);
                i++;
              }
              continue;
            }
            deferred.push(part);
          }
          clientContent.parts = [...reordered, ...deferred];
        }
      }

      if (clientContent.parts.length > 0) {
        contents.push(clientContent);
      }
    }
  }

  // 3. Tools
  let tools = undefined;
  if (claudeReq.tools && Array.isArray(claudeReq.tools)) {
    if (hasWebSearchTool) {
      // 映射 web_search 到 googleSearch 工具，带增强配置
      tools = [
        {
          googleSearch: {
            enhancedContent: {
              imageSearch: {
                maxResultCount: 5,
              },
            },
          },
        },
      ];
    } else {
      tools = [{ functionDeclarations: [] }];

      for (const tool of claudeReq.tools) {
        if (mcpXmlEnabled && isMcpToolName(tool?.name)) continue;
        // Claude 模型下：不把 mcp__ 工具暴露给上游（避免上游尝试 tool_use）
        // if (
        //   isClaudeModel &&
        //   typeof tool?.name === "string" &&
        //   tool.name.startsWith("mcp__")
        // ) {
        //   continue;
        // }
        if (tool.input_schema) {
          const toolDecl = {
            name: tool.name,
            description: tool.description,
            parameters: cleanJsonSchema(tool.input_schema),
          };
          tools[0].functionDeclarations.push(toolDecl);
        }
      }
    }
  }

  // 4. Generation Config & Thinking
  const generationConfig = {};

  // Thinking - 只要启用 thinking 就必须设置 includeThoughts: true
  if (claudeReq.thinking && claudeReq.thinking.type === "enabled") {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
    };
    // 如果提供了 budget_tokens，则设置 thinkingBudget
    if (claudeReq.thinking.budget_tokens) {
      let budget = claudeReq.thinking.budget_tokens;
      // 使用 gemini-2.5-flash 时官方上限 24576，其余模型不强制改动
      const isFlashModel = hasWebSearchTool || (claudeReq.model && claudeReq.model.includes("gemini-2.5-flash"));
      if (isFlashModel) {
        budget = Math.min(budget, 24576);
      }
      generationConfig.thinkingConfig.thinkingBudget = budget;
    }
  }

  // if (claudeReq.temperature !== undefined) {
  //   generationConfig.temperature = claudeReq.temperature;
  // }
  if (claudeReq.top_p !== undefined) {
    generationConfig.topP = claudeReq.top_p;
  }
  if (claudeReq.top_k !== undefined) {
    generationConfig.topK = claudeReq.top_k;
  }

  // web_search 场景强制 candidateCount=1
  if (hasWebSearchTool) {
    generationConfig.candidateCount = 1;
  }

  // max_tokens 映射到 maxOutputTokens，且不超过 64000
  // if (claudeReq.max_tokens !== undefined) {
  //   generationConfig.maxOutputTokens = Math.min(claudeReq.max_tokens, 64000);
  // }
  generationConfig.maxOutputTokens = 64000;
  // Safety Settings
  const safetySettings = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
    { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" },
  ];

  // Build Request Body
  const innerRequest = {
    contents,
    tools:
      tools && tools.length > 0 && tools[0].functionDeclarations && tools[0].functionDeclarations.length > 0
        ? tools
        : tools && tools.length > 0 && tools[0].googleSearch
          ? tools
          : undefined,
  };

  if (systemInstruction) {
    innerRequest.systemInstruction = systemInstruction;
  }

  // Add generationConfig if not empty
  if (Object.keys(generationConfig).length > 0) {
    innerRequest.generationConfig = generationConfig;
  }

  innerRequest.safetySettings = safetySettings;

  let geminiModel = mapClaudeModelToGemini(claudeReq.model);
  if (hasWebSearchTool) {
    geminiModel = "gemini-2.5-flash";
  }
  const requestId = `agent-${crypto.randomUUID()}`;
  const requestType = hasWebSearchTool ? "web_search" : "agent";

  const body = {
    project: projectId,
    requestId: requestId,
    request: innerRequest,
    model: geminiModel,
    userAgent: "antigravity",
    requestType,
  };

  // 如果调用方提供了 metadata.user_id，则复用为 sessionId
  if (claudeReq.metadata && claudeReq.metadata.user_id) {
    body.request.sessionId = claudeReq.metadata.user_id;
  }

  return {
    body: body,
  };
}

module.exports = {
  transformClaudeRequestIn,
  mapClaudeModelToGemini,
};
