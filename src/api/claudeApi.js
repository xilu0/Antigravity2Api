const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { transformClaudeRequestIn, transformClaudeResponseOut, mapClaudeModelToGemini } = require("../transform/claude");
const { getMcpSwitchModel } = require("../mcp/mcpSwitchFlag");
const { isMcpXmlEnabled, getMcpToolNames } = require("../mcp/mcpXmlBridge");
const {
  prepareMcpContext,
  bufferForMcpSwitchAndMaybeRetry,
  updateSessionAfterResponse,
} = require("../mcp/claudeApiMcp");

function hasWebSearchTool(claudeReq) {
  return Array.isArray(claudeReq?.tools) && claudeReq.tools.some((tool) => tool?.name === "web_search");
}

function inferFinalModelForQuota(claudeReq) {
  if (hasWebSearchTool(claudeReq)) return "gemini-2.5-flash";
  return mapClaudeModelToGemini(claudeReq?.model);
}

function shouldForceStreamForNonStreamingModel(modelName) {
  const name = String(modelName || "").toLowerCase();
  return name.includes("claude") || name.includes("gemini-3-pro");
}

function headersToObject(headers) {
  const out = {};
  if (!headers || typeof headers.forEach !== "function") return out;
  headers.forEach((value, key) => {
    out[key] = value;
  });
  delete out["content-encoding"];
  delete out["content-length"];
  return out;
}

class ClaudeApi {
  constructor(options = {}) {
    this.upstream = options.upstreamClient;
    this.logger = options.logger;
    this.debugRequestResponse = !!options.debug;
    this.debugRawResponse = !!options.debugRawResponse;
    this.sessionMcpState = new Map(); // sessionId -> { lastFamily, mcpStartIndex, foldedSegments: [] }

    if (!this.logger || typeof this.logger.log !== "function") {
      throw new Error("ClaudeApi requires options.logger with .log(level, message, meta)");
    }
  }

  logDebug(title, data) {
    if (!this.debugRequestResponse) return;
    this.logger.log("debug", title, data);
  }

  logStream(event, options = {}) {
    return this.logger.logStream(event, options);
  }

  async logStreamContent(stream, label) {
    if (!stream) return stream;
    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let bufferStr = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkStr = decoder.decode(value, { stream: true });
        bufferStr += chunkStr;
      }
      if (bufferStr) {
        this.logger.log("debug", String(label), bufferStr);
      }
    } catch (err) {
      this.logger.log("warn", `Raw stream log failed for ${label}: ${err.message || err}`);
    }
    return stream;
  }

  generateRawResponseFilename() {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-").replace("Z", "");
    const requestId = crypto.randomBytes(3).toString("hex");
    return { filename: `raw_response_${timestamp}_${requestId}.json`, requestId, timestamp: now.toISOString() };
  }

  async saveRawResponse(rawData, { model, streaming, httpStatus, requestId, timestamp }) {
    try {
      const logDir = path.resolve(process.cwd(), "log");
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      const { filename, requestId: genRequestId, timestamp: genTimestamp } = this.generateRawResponseFilename();
      const filePath = path.join(logDir, filename);

      const content = JSON.stringify({
        timestamp: timestamp || genTimestamp,
        requestId: requestId || genRequestId,
        model,
        streaming,
        httpStatus,
        rawResponse: rawData,
      }, null, 2);

      await fs.promises.writeFile(filePath, content, "utf8");
      this.log("debug", `Raw response saved to ${filename}`);
    } catch (err) {
      this.log("warn", `Failed to save raw response: ${err.message || err}`);
    }
  }

  async captureRawResponseStream(stream, { model, streaming, httpStatus }) {
    if (!stream) return stream;
    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let bufferStr = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunkStr = decoder.decode(value, { stream: true });
        bufferStr += chunkStr;
      }
      if (bufferStr) {
        await this.saveRawResponse(bufferStr, { model, streaming, httpStatus });
      }
    } catch (err) {
      this.log("warn", `Raw response capture failed: ${err.message || err}`);
    }
    return stream;
  }

  async handleListModels() {
    try {
      const remoteModelsMap = await this.upstream.fetchAvailableModels();
      const now = Math.floor(Date.now() / 1000);
      const models = [];

      const entries = Array.isArray(remoteModelsMap)
        ? remoteModelsMap
        : Object.keys(remoteModelsMap || {}).map((id) => {
            const info = remoteModelsMap[id];
            return typeof info === "object" ? { id, ...info } : { id };
          });

      for (const entry of entries) {
        const rawId =
          (typeof entry === "object" && (entry.id || entry.name || entry.model)) ||
          (typeof entry === "string" ? entry : null);
        if (!rawId || typeof rawId !== "string") continue;

        const id = rawId.startsWith("models/") ? rawId.slice("models/".length) : rawId;
        const lower = id.toLowerCase();
        const ownedBy = lower.includes("claude") ? "anthropic" : lower.includes("gemini") ? "google" : "unknown";
        models.push({ id, object: "model", created: now, owned_by: ownedBy });
      }

      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: { object: "list", data: models },
      };
    } catch (e) {
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: { message: e.message || String(e) } },
      };
    }
  }

  async handleCountTokens(requestData) {
    try {
      if (!requestData) {
        return {
          status: 400,
          headers: { "Content-Type": "application/json" },
          body: { error: { message: "Empty request body" } },
        };
      }

      this.logger.log("info", "Claude CountTokens Request", requestData);

      // projectId is not required for countTokens, but transform reuses Claude->v1internal mapping to build contents/model.
      const { body: finalBody } = transformClaudeRequestIn(requestData, "");

      // 完全使用本地估算 - 跳过上游 API 调用
      // 原因：v1internal countTokens API 不支持 systemInstruction，总是返回 totalTokens: 1
      // 而且上游调用很慢（30-40秒），导致 Claude Code /context 显示延迟
      let totalTokens = 0;
      const countTokensBody = {
        request: {
          model: finalBody.model,
          contents: finalBody.request.contents || [],
        },
      };
      this.logger.log("info", "CountTokens Request Body", countTokensBody);

      // 本地估算 contents Token
      if (finalBody.request && finalBody.request.contents) {
        try {
          const contentsStr = JSON.stringify(finalBody.request.contents);
          const contentsTokenCount = Math.floor(contentsStr.length / 4);
          this.log("info", `本地估算 Contents Token: ${contentsTokenCount}`);
          totalTokens += contentsTokenCount;
        } catch (e) {
          this.log("error", `Contents token estimation failed: ${e.message || e}`);
        }
      }

      // 本地估算 systemInstruction Token
      if (finalBody.request && finalBody.request.systemInstruction) {
        try {
          const sysInstructionStr = JSON.stringify(finalBody.request.systemInstruction);
          // 使用字符数 / 4 估算 token 数（通用估算比例）
          const sysTokenCount = Math.floor(sysInstructionStr.length / 4);
          this.log("info", `本地估算 SystemInstruction Token: ${sysTokenCount}`);
          totalTokens += sysTokenCount;
        } catch (e) {
          this.log("error", `SystemInstruction token estimation failed: ${e.message || e}`);
        }
      }
      const data = await countTokensResp.json();
      this.logger.log("info", "CountTokens Response", data);

      // 本地估算 Tools Token
      if (finalBody.request && finalBody.request.tools) {
        try {
          const toolsStr = JSON.stringify(finalBody.request.tools);
          const toolsTokenCount = Math.floor(toolsStr.length / 4);
          this.logger.log("info", `本地估算 Tools Token: ${toolsTokenCount}`);
          totalTokens += toolsTokenCount;
        } catch (e) {
          this.logger.log("error", `Tools token estimation failed: ${e.message || e}`);
        }
      }

      const result = { input_tokens: totalTokens };
      this.logger.log("info", "CountTokens Result", result);

      return { status: 200, headers: { "Content-Type": "application/json" }, body: result };
    } catch (error) {
      this.logger.log("error", "Error processing CountTokens", error.message || error);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: { type: "internal_error", message: error.message } },
      };
    }
  }

  async handleMessages(requestData) {
    try {
      if (!requestData) {
        return {
          status: 400,
          headers: { "Content-Type": "application/json" },
          body: { error: { message: "Empty request body" } },
        };
      }

      this.logDebug("Claude Payload Request", requestData);

      const clientWantsStream = !!requestData.stream;

      const mcpModel = getMcpSwitchModel();
      let baseModel = requestData.model;
      let modelForQuota = inferFinalModelForQuota(requestData);
      let upstreamRequestForTransform = requestData;
      let shouldBufferForSwitch = false;
      let transformOptions = undefined;
      let sessionState = null;

      if (mcpModel) {
        ({ baseModel, modelForQuota, upstreamRequestForTransform, shouldBufferForSwitch, transformOptions, sessionState } =
          prepareMcpContext({
            requestData,
            sessionMcpState: this.sessionMcpState,
            mcpModel,
            inferFinalModelForQuota,
          }));
      }

      const forceStreamForNonStreaming =
        !clientWantsStream && shouldForceStreamForNonStreamingModel(modelForQuota);
      const method = clientWantsStream || forceStreamForNonStreaming ? "streamGenerateContent" : "generateContent";
      const queryString = method === "streamGenerateContent" ? "?alt=sse" : "";

      const transformOutOptions = {};
      // 始终使用原始请求的模型名称,避免响应中返回映射后的模型名
      transformOutOptions.overrideModel = requestData.model;
      if (!clientWantsStream && method === "streamGenerateContent") transformOutOptions.forceNonStreaming = true;
      if (isMcpXmlEnabled()) {
        const names = getMcpToolNames(requestData?.tools);
        if (names.length > 0) transformOutOptions.mcpXmlToolNames = names;
      }
      // Get model context limit for dynamic cache token allocation
      const maxContextTokens = this.upstream?.quotaRefresher?.getModelContextLimit?.(modelForQuota);
      if (maxContextTokens && Number.isFinite(maxContextTokens)) {
        transformOutOptions.maxContextTokens = maxContextTokens;
      }

      // 创建 usageHolder 用于捕获 Gemini usageMetadata
      const usageHolder = { usage: null };
      transformOutOptions.usageHolder = usageHolder;

      let loggedTransformed = false;
      const response = await this.upstream.callV1Internal(method, {
        model: modelForQuota,
        queryString,
        buildBody: (projectId) => {
          const { body: googleBody } = transformClaudeRequestIn(upstreamRequestForTransform, projectId, transformOptions);
          if (!loggedTransformed) {
            this.logDebug("Gemini Payload Request (Transformed)", googleBody);
            loggedTransformed = true;
          }
          return googleBody;
        },
      });

      if (!response.ok) {
        const headers = headersToObject(response.headers);
        let body = response.body;

        // In debug mode, also log upstream non-2xx bodies (400/401/403/etc).
        // We must not consume the body we return to the client, so prefer tee().
        if (this.debugRequestResponse && response.body) {
          try {
            if (typeof response.body.tee === "function") {
              const [logBranch, processBranch] = response.body.tee();
              this.logStreamContent(logBranch, `Upstream Error Raw (HTTP ${response.status})`);
              body = processBranch;
            } else {
              const errorText = await response.clone().text().catch(() => "");
              if (errorText) this.logger.log("debug", `Upstream Error Body (HTTP ${response.status})`, errorText);
            }
          } catch (e) {
            this.logger.log("warn", `Failed to log upstream error body: ${e.message || e}`);
          }
        }

        return {
          status: response.status,
          headers,
          body,
        };
      }

      // Log Gemini response raw stream
      let responseForTransform = response;
      if ((this.debugRequestResponse || this.debugRawResponse) && response.body) {
        try {
          const [branch1, branch2] = response.body.tee();
          const rawLabel = method === "streamGenerateContent" ? "Gemini Response Raw (Stream)" : "Gemini Response Raw";
          const streaming = method === "streamGenerateContent";

          if (this.debugRequestResponse && this.debugRawResponse) {
            // Both enabled: tee again for separate handling
            const [logBranch, saveBranch] = branch1.tee();
            this.logStreamContent(logBranch, rawLabel);
            this.captureRawResponseStream(saveBranch, { model: modelForQuota, streaming, httpStatus: response.status });
          } else if (this.debugRequestResponse) {
            this.logStreamContent(branch1, rawLabel);
          } else if (this.debugRawResponse) {
            this.captureRawResponseStream(branch1, { model: modelForQuota, streaming, httpStatus: response.status });
          }

          responseForTransform = new Response(branch2, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } catch (e) {
          this.logger.log("warn", "Error teeing stream for logging", e.message || e);
        }
      }

      const convertedResponse = await transformClaudeResponseOut(
        responseForTransform,
        transformOutOptions,
      );

      let finalResponseBody = convertedResponse.body;

      if (mcpModel) {
        const bufferedResult = await bufferForMcpSwitchAndMaybeRetry({
          upstream: this.upstream,
          method,
          queryString,
          requestData,
          baseModel,
          mcpModel,
          convertedResponse,
          shouldBufferForSwitch,
          debugRequestResponse: this.debugRequestResponse,
          logger: this.logger,
          sessionState,
        });
        if (bufferedResult?.apiResponse) return bufferedResult.apiResponse;
        if (bufferedResult?.finalResponseBody) {
          finalResponseBody = bufferedResult.finalResponseBody;
        } else if (this.debugRequestResponse && convertedResponse.body) {
          try {
            const [logBranch, processBranch] = convertedResponse.body.tee();
            this.logStreamContent(logBranch, "Claude Response Payload (Transformed Stream)");
            finalResponseBody = processBranch;
          } catch (e) {
            this.logger.log("warn", "Error teeing converted stream for logging", e.message || e);
          }
        }

        updateSessionAfterResponse({ sessionState, requestData, baseModel, modelForQuota, mcpModel });
      } else if (this.debugRequestResponse && convertedResponse.body) {
        try {
          const [logBranch, processBranch] = convertedResponse.body.tee();
          this.logStreamContent(logBranch, "Claude Response Payload (Transformed Stream)");
          finalResponseBody = processBranch;
        } catch (e) {
          this.logger.log("warn", "Error teeing converted stream for logging", e.message || e);
        }
      }

      // 提取 response._meta 中的账号信息（由 upstream 添加）
      const responseMeta = response._meta || {};
      const accountName = responseMeta.account || null;
      const upstreamModel = responseMeta.model || modelForQuota;

      // 构建 onComplete 回调，供 server.js 在响应结束后调用
      const onComplete = () => {
        return {
          model: upstreamModel,
          account: accountName,
          usage: usageHolder.usage,
          getQuota: () => {
            if (!accountName || !upstreamModel) return null;
            return this.upstream?.quotaRefresher?.getAccountQuota?.(upstreamModel, accountName) || null;
          },
        };
      };

      return {
        status: convertedResponse.status,
        headers: {
          "Content-Type": convertedResponse.headers.get("Content-Type") || "application/json",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
        body: finalResponseBody,
        onComplete,
      };
    } catch (error) {
      this.logger.log("error", "Error processing Claude request", error.message || error);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: { type: "internal_error", message: error.message } },
      };
    }
  }
}

module.exports = ClaudeApi;
