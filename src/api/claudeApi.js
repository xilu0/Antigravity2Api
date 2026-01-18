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

const KNOWN_LOG_LEVELS = new Set([
  "debug",
  "info",
  "success",
  "warn",
  "error",
  "fatal",
  "request",
  "response",
  "upstream",
  "retry",
  "account",
  "quota",
  "stream",
]);

function isKnownLogLevel(value) {
  return typeof value === "string" && KNOWN_LOG_LEVELS.has(value.toLowerCase());
}

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
    this.logger = options.logger || null;
    this.debugRequestResponse = !!options.debug;
    this.debugRawResponse = !!options.debugRawResponse;
    this.sessionMcpState = new Map(); // sessionId -> { lastFamily, mcpStartIndex, foldedSegments: [] }
  }

  log(levelOrTitle, messageOrData, meta) {
    if (this.logger) {
      if (typeof this.logger.log === "function") {
        if (isKnownLogLevel(levelOrTitle)) {
          return this.logger.log(String(levelOrTitle).toLowerCase(), messageOrData, meta);
        }
        // Old style: log("Some Title", data) => info("Some Title", data)
        return this.logger.log("info", String(levelOrTitle), messageOrData);
      }
      if (typeof this.logger === "function") {
        return this.logger(levelOrTitle, messageOrData, meta);
      }
    }

    // Fallback to console (no structured logger available)
    const title = String(levelOrTitle);
    if (meta !== undefined && meta !== null) {
      console.log(`[${title}]`, messageOrData, meta);
      return;
    }
    if (messageOrData !== undefined && messageOrData !== null) {
      console.log(`[${title}]`, typeof messageOrData === "string" ? messageOrData : JSON.stringify(messageOrData, null, 2));
      return;
    }
    console.log(`[${title}]`);
  }

  logDebug(title, data) {
    if (!this.debugRequestResponse) return;
    this.log("debug", title, data);
  }

  logStream(event, options = {}) {
    if (this.logger && typeof this.logger.logStream === "function") {
      return this.logger.logStream(event, options);
    }
    this.log("stream", { event, ...options });
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
        this.log(`${label}`, bufferStr);
      }
    } catch (err) {
      this.log("warn", `Raw stream log failed for ${label}: ${err.message || err}`);
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

      for (const id of Object.keys(remoteModelsMap)) {
        if (id && id.toLowerCase().includes("claude")) {
          models.push({ id, object: "model", created: now, owned_by: "anthropic" });
        }
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

      this.log("Claude CountTokens Request", requestData);

      // projectId is not required for countTokens, but transform reuses Claude->v1internal mapping to build contents/model.
      const { body: finalBody } = transformClaudeRequestIn(requestData, "");

      const countTokensBody = {
        request: {
          model: finalBody.model,
          contents: finalBody.request.contents || [],
        },
      };
      this.log("CountTokens Request Body", countTokensBody);

      const countTokensResp = await this.upstream.countTokens(countTokensBody, { model: finalBody.model });
      if (!countTokensResp.ok) {
        return {
          status: countTokensResp.status,
          headers: headersToObject(countTokensResp.headers),
          body: countTokensResp.body,
        };
      }

      const data = await countTokensResp.json();
      this.log("CountTokens Response", data);

      let totalTokens = data.totalTokens || 0;

      // 本地估算 Tools Token (API 不计算 Tools，参考现有实现)
      if (finalBody.request && finalBody.request.tools) {
        try {
          const toolsStr = JSON.stringify(finalBody.request.tools);
          const toolsTokenCount = Math.floor(toolsStr.length / 4);
          this.log("info", `本地估算 Tools Token: ${toolsTokenCount}`);
          totalTokens += toolsTokenCount;
        } catch (e) {
          this.log("error", `Tools token estimation failed: ${e.message || e}`);
        }
      }

      const result = { input_tokens: totalTokens };
      this.log("CountTokens Result", result);

      return { status: 200, headers: { "Content-Type": "application/json" }, body: result };
    } catch (error) {
      this.log("Error processing CountTokens", error.message || error);
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
              if (errorText) this.log(`Upstream Error Body (HTTP ${response.status})`, errorText);
            }
          } catch (e) {
            this.log("warn", `Failed to log upstream error body: ${e.message || e}`);
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
          this.log("Error teeing stream for logging", e.message || e);
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
          log: (title, data) => this.log(title, data),
          logDebug: (title, data) => this.logDebug(title, data),
          logStreamContent: (stream, label) => this.logStreamContent(stream, label),
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
            this.log("Error teeing converted stream for logging", e.message || e);
          }
        }

        updateSessionAfterResponse({ sessionState, requestData, baseModel, modelForQuota, mcpModel });
      } else if (this.debugRequestResponse && convertedResponse.body) {
        try {
          const [logBranch, processBranch] = convertedResponse.body.tee();
          this.logStreamContent(logBranch, "Claude Response Payload (Transformed Stream)");
          finalResponseBody = processBranch;
        } catch (e) {
          this.log("Error teeing converted stream for logging", e.message || e);
        }
      }

      return {
        status: convertedResponse.status,
        headers: {
          "Content-Type": convertedResponse.headers.get("Content-Type") || "application/json",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
        body: finalResponseBody,
      };
    } catch (error) {
      this.log("Error processing Claude request", error.message || error);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: { type: "internal_error", message: error.message } },
      };
    }
  }
}

module.exports = ClaudeApi;
