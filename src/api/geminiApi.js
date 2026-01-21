const { wrapRequest, unwrapResponse, createUnwrapStream } = require("../transform/gemini");

function isGemini3ModelName(modelName) {
  return String(modelName || "")
    .toLowerCase()
    .includes("gemini-3-pro");
}

function ensureAltSse(queryString) {
  const raw = String(queryString || "");
  const qs = raw.startsWith("?") ? raw.slice(1) : raw;
  const params = new URLSearchParams(qs);
  params.set("alt", "sse");
  const next = params.toString();
  return next ? `?${next}` : "?alt=sse";
}

function ensureMergedCandidate(target) {
  if (!target || typeof target !== "object") return null;
  if (!Array.isArray(target.candidates)) target.candidates = [];
  if (!target.candidates[0] || typeof target.candidates[0] !== "object") {
    target.candidates[0] = { content: { role: "model", parts: [] } };
  }
  if (!target.candidates[0].content || typeof target.candidates[0].content !== "object") {
    target.candidates[0].content = { role: "model", parts: [] };
  }
  if (!Array.isArray(target.candidates[0].content.parts)) target.candidates[0].content.parts = [];
  return target.candidates[0];
}

function mergeGeminiParts(targetParts, sourceParts) {
  if (!Array.isArray(targetParts) || !Array.isArray(sourceParts) || sourceParts.length === 0) return;

  const isMergeablePlainTextPart = (part) => {
    if (!part || typeof part !== "object") return false;
    if (typeof part.text !== "string") return false;
    if (part.thought === true) return false;
    const keys = Object.keys(part);
    return keys.every((k) => k === "text" || k === "thought");
  };

  for (const part of sourceParts) {
    if (!part || typeof part !== "object") continue;

    if (part.thought === true && typeof part.text === "string") {
      const last = targetParts[targetParts.length - 1];
      if (last && typeof last === "object" && last.thought === true && typeof last.text === "string") {
        last.text += part.text;
        if (typeof part.thoughtSignature === "string" && part.thoughtSignature) {
          last.thoughtSignature = part.thoughtSignature;
        }
        continue;
      }
    }

    if (isMergeablePlainTextPart(part)) {
      const last = targetParts[targetParts.length - 1];
      if (isMergeablePlainTextPart(last)) {
        last.text += part.text;
        continue;
      }
    }

    targetParts.push(part);
  }
}

function mergeGeminiStreamChunk(target, chunk) {
  if (!chunk || typeof chunk !== "object") return target;
  const out = target && typeof target === "object" ? target : {};

  for (const [key, value] of Object.entries(chunk)) {
    if (key !== "candidates") {
      out[key] = value;
      continue;
    }

    if (!Array.isArray(value) || value.length === 0) continue;
    const src = value[0];
    if (!src || typeof src !== "object") continue;

    const dst = ensureMergedCandidate(out);
    if (!dst) continue;

    for (const [ck, cv] of Object.entries(src)) {
      if (ck === "content") {
        if (!cv || typeof cv !== "object") continue;
        if (cv.role) dst.content.role = cv.role;
        if (Array.isArray(cv.parts) && cv.parts.length > 0) {
          mergeGeminiParts(dst.content.parts, cv.parts);
        }
        continue;
      }
      dst[ck] = cv;
    }
  }

  return out;
}

async function readGeminiSseToUnwrapped(body) {
  const merged = { candidates: [{ content: { role: "model", parts: [] } }] };
  if (!body || typeof body.getReader !== "function") return merged;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === "[DONE]") continue;

      try {
        const parsed = JSON.parse(dataStr);
        const unwrapped = unwrapResponse(parsed);
        mergeGeminiStreamChunk(merged, unwrapped);
      } catch (_) {
        // ignore parse failures
      }
    }
  }

  const tail = buffer.trimEnd();
  if (tail.startsWith("data:")) {
    const dataStr = tail.slice(5).trim();
    if (dataStr && dataStr !== "[DONE]") {
      try {
        const parsed = JSON.parse(dataStr);
        const unwrapped = unwrapResponse(parsed);
        mergeGeminiStreamChunk(merged, unwrapped);
      } catch (_) {}
    }
  }

  return merged;
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

class GeminiApi {
  constructor(options = {}) {
    this.auth = options.authManager;
    this.upstream = options.upstreamClient;
    this.logger = options.logger;
    this.debugRequestResponse = !!options.debug;

    if (!this.logger || typeof this.logger.log !== "function") {
      throw new Error("GeminiApi requires options.logger with .log(level, message, meta)");
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

  async handleListModels() {
    try {
      const remoteModelsMap = await this.auth.fetchAvailableModels();

      const entries = Array.isArray(remoteModelsMap)
        ? remoteModelsMap
        : Object.keys(remoteModelsMap || {}).map((id) => {
            const info = remoteModelsMap[id];
            return typeof info === "object" ? { id, ...info } : { id };
          });

      const models = [];
      for (const entry of entries) {
        const rawId =
          (typeof entry === "object" && (entry.id || entry.name || entry.model)) ||
          (typeof entry === "string" ? entry : null);
        if (!rawId || typeof rawId !== "string") continue;

        const normalizedName = rawId.startsWith("models/") ? rawId : `models/${rawId}`;
        const supportedGenerationMethods =
          entry.supportedGenerationMethods &&
          Array.isArray(entry.supportedGenerationMethods) &&
          entry.supportedGenerationMethods.length > 0
            ? entry.supportedGenerationMethods
            : ["generateContent", "streamGenerateContent"];

        const modelInfo = {
          name: normalizedName,
          displayName: entry.displayName || rawId,
          description: entry.description || entry.reason || entry.message || "",
          supportedGenerationMethods,
        };

        const inputLimit = entry.inputTokenLimit || entry.maxInputTokens || entry.contextWindow || entry.context_window;
        if (inputLimit) {
          modelInfo.inputTokenLimit = inputLimit;
        }

        const outputLimit = entry.outputTokenLimit || entry.maxOutputTokens;
        if (outputLimit) {
          modelInfo.outputTokenLimit = outputLimit;
        }

        models.push(modelInfo);
      }

      return { status: 200, headers: { "Content-Type": "application/json" }, body: { models } };
    } catch (e) {
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: { message: e.message || e } },
      };
    }
  }

  async handleGetModel(targetName) {
    try {
      const normalized = targetName.startsWith("models/") ? targetName : `models/${targetName}`;
      const models = (await this.handleListModels()).body.models || [];
      const hit = models.find((m) => m.name === normalized);
      if (!hit) {
        return {
          status: 404,
          headers: { "Content-Type": "application/json" },
          body: { error: { message: `Model not found: ${targetName}` } },
        };
      }
      return { status: 200, headers: { "Content-Type": "application/json" }, body: hit };
    } catch (e) {
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: { message: e.message || e } },
      };
    }
  }

  async handleGenerate(modelName, method, clientBody, queryString = "") {
    try {
      this.logDebug("Gemini Request Raw", clientBody || "(empty body)");

      const clientWantsStream = method === "streamGenerateContent";

      const clientBodyJson = JSON.stringify(clientBody || {});
      const quotaProbe = wrapRequest(JSON.parse(clientBodyJson), { projectId: "", modelName });
      const modelForQuota = quotaProbe.mappedModelName || modelName;

      const mustUseStream = isGemini3ModelName(modelForQuota);
      const upstreamMethod = mustUseStream ? "streamGenerateContent" : method;
      const upstreamQueryString =
        upstreamMethod === "streamGenerateContent" ? ensureAltSse(queryString || "") : queryString || "";
      const shouldAggregateStream = !clientWantsStream && upstreamMethod === "streamGenerateContent";

      let loggedWrapped = false;
      const upstreamResponse = await this.upstream.callV1Internal(upstreamMethod, {
        model: modelForQuota,
        queryString: upstreamQueryString,
        buildBody: (projectId) => {
          const { wrappedBody } = wrapRequest(JSON.parse(clientBodyJson), { projectId, modelName });
          if (!loggedWrapped) {
            this.logDebug("Gemini Request Wrapped", wrappedBody);
            loggedWrapped = true;
          }
          return wrappedBody;
        },
      });

      let responseForClient = upstreamResponse;
      if (this.debugRequestResponse && upstreamResponse.body) {
        try {
          const [logBranch, processBranch] = upstreamResponse.body.tee();
          this.logStreamContent(logBranch, "Gemini Response Raw");
          responseForClient = new Response(processBranch, {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: upstreamResponse.headers,
          });
        } catch (e) {
          this.logger.log("warn", "Error teeing Gemini native stream for logging", e.message || e);
        }
      }

      if (!responseForClient.ok) {
        return {
          status: responseForClient.status,
          headers: headersToObject(responseForClient.headers),
          body: responseForClient.body,
        };
      }

      const contentType = responseForClient.headers.get("content-type") || "";

      if (shouldAggregateStream && contentType.includes("stream") && responseForClient.body) {
        const aggregated = await readGeminiSseToUnwrapped(responseForClient.body);
        this.logDebug("Gemini Response Wrapped (Aggregated)", aggregated);

        const respHeaders = headersToObject(responseForClient.headers);
        respHeaders["Content-Type"] = "application/json";
        return { status: responseForClient.status, headers: respHeaders, body: aggregated };
      }

      // JSON response: unwrap payload and return JSON object
      if (contentType.includes("application/json")) {
        const jsonPayload = await responseForClient.clone().json();
        const unwrapped = unwrapResponse(jsonPayload);
        this.logDebug("Gemini Response Wrapped", unwrapped);

        const respHeaders = headersToObject(responseForClient.headers);
        if (!respHeaders["content-type"] && !respHeaders["Content-Type"]) {
          respHeaders["Content-Type"] = "application/json";
        }

        return { status: responseForClient.status, headers: respHeaders, body: unwrapped };
      }

      // Stream response: unwrap each SSE line payload
      if (contentType.includes("stream") && responseForClient.body) {
        const stream = createUnwrapStream(responseForClient.body, {
          onChunk: (chunk) => this.logDebug("Gemini Response Wrapped (Stream)", chunk),
        });

        const respHeaders = headersToObject(responseForClient.headers);
        if (!respHeaders["content-type"] && !respHeaders["Content-Type"]) {
          respHeaders["Content-Type"] = "text/event-stream";
        }

        return { status: responseForClient.status, headers: respHeaders, body: stream };
      }

      // Fallback: passthrough raw body as stream if present
      const respHeaders = headersToObject(responseForClient.headers);

      return { status: responseForClient.status, headers: respHeaders, body: responseForClient.body };
    } catch (error) {
      this.logger.log("error", "Error processing Gemini Request Raw", error.message || error);
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: { message: error.message || error } },
      };
    }
  }

  async handleCountTokens(modelName, clientBody) {
    try {
      const innerRequest =
        clientBody && typeof clientBody.request === "object" && clientBody.request ? clientBody.request : clientBody || {};

      const countTokensBody = {
        request: {
          model: modelName,
          contents: innerRequest.contents || [],
        },
      };

      const response = await this.upstream.countTokens(countTokensBody, { model: modelName });
      if (!response.ok) {
        return {
          status: response.status,
          headers: headersToObject(response.headers),
          body: response.body,
        };
      }

      const json = await response.json().catch(async () => ({ error: await response.text().catch(() => "") }));
      return { status: response.status, headers: { "Content-Type": "application/json" }, body: json };
    } catch (error) {
      return {
        status: 500,
        headers: { "Content-Type": "application/json" },
        body: { error: { message: error.message || error } },
      };
    }
  }
}

module.exports = GeminiApi;
