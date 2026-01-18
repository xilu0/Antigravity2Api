function makeSrvToolUseId() {
  return `srvtoolu_${Math.random().toString(36).slice(2, 26)}`;
}

function stableEncryptedContent(payload) {
  try {
    const json = JSON.stringify(payload);
    return Buffer.from(json, "utf8").toString("base64");
  } catch {
    return "";
  }
}

function toWebSearchResults(groundingChunks = []) {
  return (groundingChunks || [])
    .map((chunk) => {
      const web = chunk?.web || {};
      const url = typeof web.uri === "string" ? web.uri : "";
      const title = typeof web.title === "string" ? web.title : (typeof web.domain === "string" ? web.domain : "");
      return {
        type: "web_search_result",
        title,
        url,
        encrypted_content: stableEncryptedContent({ url, title }),
        page_age: null,
      };
    })
    .filter((r) => r.url || r.title);
}

function isVertexGroundingRedirectUrl(url) {
  return typeof url === "string" && url.startsWith("https://vertexaisearch.cloud.google.com/grounding-api-redirect/");
}

function unwrapGoogleRedirectUrl(url) {
  if (typeof url !== "string" || (!url.startsWith("http://") && !url.startsWith("https://"))) return url;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (!(host === "google.com" || host.endsWith(".google.com"))) return url;
    if (!u.pathname.endsWith("/url")) return url;
    const target = u.searchParams.get("q") || u.searchParams.get("url") || "";
    if (!target) return url;
    try {
      return decodeURIComponent(target);
    } catch {
      return target;
    }
  } catch {
    return url;
  }
}

async function fetchFinalUrl(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = isVertexGroundingRedirectUrl(url)
      ? {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        }
      : undefined;

    const getNextLocation = async (currentUrl, method) => {
      try {
        const res = await fetch(currentUrl, {
          method,
          redirect: "manual",
          signal: controller.signal,
          headers,
        });
        const status = Number(res?.status) || 0;
        const location = String(res?.headers?.get?.("location") || "").trim();
        try {
          if (res?.body?.cancel) await res.body.cancel();
        } catch {}
        try {
          if (res?.body?.destroy) res.body.destroy();
        } catch {}
        if (status >= 300 && status < 400 && location) {
          const resolved = new URL(location, currentUrl).toString();
          return unwrapGoogleRedirectUrl(resolved);
        }
      } catch {
        // ignore
      }
      return "";
    };

    let current = url;
    for (let i = 0; i < 5; i++) {
      const next = (await getNextLocation(current, "HEAD")) || (await getNextLocation(current, "GET"));
      if (!next || next === current) break;
      current = next;
    }

    return current;
  } finally {
    clearTimeout(timeoutId);
  }
}

const resolvedRedirectUrlCache = new Map(); // vertex redirect url -> final url

async function resolveVertexGroundingRedirectUrl(url) {
  if (!isVertexGroundingRedirectUrl(url)) return url;
  const cached = resolvedRedirectUrlCache.get(url);
  if (typeof cached === "string") return cached;
  if (cached && typeof cached.then === "function") return cached;

  const promise = (async () => {
    const finalUrl = await fetchFinalUrl(url, 5000);
    return finalUrl;
  })();

  resolvedRedirectUrlCache.set(url, promise);
  try {
    const finalUrl = await promise;
    resolvedRedirectUrlCache.set(url, finalUrl);
    if (resolvedRedirectUrlCache.size > 2000) resolvedRedirectUrlCache.clear();
    return finalUrl;
  } catch {
    resolvedRedirectUrlCache.delete(url);
    return url;
  }
}

async function resolveWebSearchRedirectUrls(webSearch) {
  const results = Array.isArray(webSearch?.results) ? webSearch.results : [];
  if (results.length === 0) return;

  // Best-effort resolve (proxy-aware: global fetch is already patched in src/utils/proxy.js)
  await Promise.all(
    results.map(async (result) => {
      if (!result || typeof result.url !== "string" || !result.url) return;
      if (!isVertexGroundingRedirectUrl(result.url)) return;
      const finalUrl = await resolveVertexGroundingRedirectUrl(result.url);
      if (finalUrl && finalUrl !== result.url) {
        result.url = finalUrl;
        result.encrypted_content = stableEncryptedContent({ url: result.url, title: result.title });
      }
    })
  );
}

function buildCitationsFromSupport(results, support) {
  const cited_text = support?.segment?.text;
  if (typeof cited_text !== "string" || cited_text.length === 0) return [];

  const indices = Array.isArray(support?.groundingChunkIndices) ? support.groundingChunkIndices : [];
  const citations = [];
  for (const idx of indices) {
    if (typeof idx !== "number") continue;
    const result = results[idx];
    if (!result) continue;
    citations.push({
      type: "web_search_result_location",
      cited_text,
      url: result.url,
      title: result.title,
      encrypted_index: stableEncryptedContent({ url: result.url, title: result.title, cited_text }),
    });
  }
  return citations;
}

async function buildNonStreamingWebSearchMessage(rawJSON, options, toClaudeUsage) {
  const candidate = rawJSON?.candidates?.[0] || {};
  const parts = candidate?.content?.parts || [];
  const groundingMetadata = candidate?.groundingMetadata || {};

  const query =
    Array.isArray(groundingMetadata.webSearchQueries) && typeof groundingMetadata.webSearchQueries[0] === "string"
      ? groundingMetadata.webSearchQueries[0]
      : "";

  const groundingChunks = Array.isArray(candidate.groundingChunks) ? candidate.groundingChunks : groundingMetadata.groundingChunks;
  const results = toWebSearchResults(Array.isArray(groundingChunks) ? groundingChunks : []);

  const groundingSupports = Array.isArray(candidate.groundingSupports) ? candidate.groundingSupports : groundingMetadata.groundingSupports;
  const supports = Array.isArray(groundingSupports) ? groundingSupports : [];

  // 同 streaming：尽力把 vertex redirect 解析成真实落地 URL
  await resolveWebSearchRedirectUrls({ results });

  const thinkingText = parts
    .filter((p) => p?.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");

  const answerText = parts
    .filter((p) => !p?.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("");

  const toolUseId = makeSrvToolUseId();

  const content = [];
  if (thinkingText) content.push({ type: "thinking", thinking: thinkingText });

  content.push({
    type: "server_tool_use",
    id: toolUseId,
    name: "web_search",
    input: { query },
  });

  content.push({
    type: "web_search_tool_result",
    tool_use_id: toolUseId,
    content: results,
  });

  // citations-only blocks（每个 support 的 groundingChunkIndices 都生成 citation）
  for (const support of supports) {
    const citations = buildCitationsFromSupport(results, support);
    if (!citations.length) continue;
    content.push({ type: "text", text: "", citations });
  }

  if (answerText) content.push({ type: "text", text: answerText });

  const finish = candidate?.finishReason;
  const stopReason = finish === "MAX_TOKENS" ? "max_tokens" : "end_turn";
  const usage = typeof toClaudeUsage === "function" ? toClaudeUsage(rawJSON.usageMetadata || {}, { maxContextTokens: options?.maxContextTokens }) : undefined;

  return {
    id: rawJSON.responseId || "",
    type: "message",
    role: "assistant",
    model: options?.overrideModel || rawJSON.modelVersion || "",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usage ? { ...usage, server_tool_use: { web_search_requests: 1 } } : { server_tool_use: { web_search_requests: 1 } },
  };
}

function emitWebSearchBlocks(state, StreamingState) {
  if (!state || !StreamingState) return;

  // 确保 index:0 是 thinking（即使为空）
  if (state.blockIndex === 0 && state.blockType === StreamingState.BLOCK_NONE) {
    state.startBlock(StreamingState.BLOCK_THINKING, { type: "thinking", thinking: "" });
    state.emitDelta("thinking_delta", { thinking: "" });
    state.endBlock();
  } else if (state.blockType === StreamingState.BLOCK_THINKING) {
    // 结束 thinking 前补一个空 delta（更贴近官方流式形态）
    state.emitDelta("thinking_delta", { thinking: "" });
    state.endBlock();
  } else {
    state.endBlock();
  }

  const toolUseId = state.webSearch.toolUseId || makeSrvToolUseId();
  state.webSearch.toolUseId = toolUseId;

  // index:1 server_tool_use
  state.startBlock(StreamingState.BLOCK_TEXT, {
    type: "server_tool_use",
    id: toolUseId,
    name: "web_search",
    input: {},
  });
  const query = typeof state.webSearch.query === "string" ? state.webSearch.query : "";
  state.emitDelta("input_json_delta", { partial_json: JSON.stringify({ query }) });
  state.endBlock();

  // index:2 web_search_tool_result
  state.startBlock(StreamingState.BLOCK_TEXT, {
    type: "web_search_tool_result",
    tool_use_id: toolUseId,
    content: Array.isArray(state.webSearch.results) ? state.webSearch.results : [],
  });
  state.endBlock();

  // index:3.. citations-only blocks
  const results = Array.isArray(state.webSearch.results) ? state.webSearch.results : [];
  const supports = Array.isArray(state.webSearch.supports) ? state.webSearch.supports : [];
  for (const support of supports) {
    const citations = buildCitationsFromSupport(results, support);
    if (!citations.length) continue;
    state.startBlock(StreamingState.BLOCK_TEXT, { citations: [], type: "text", text: "" });
    for (const citation of citations) {
      state.emitDelta("citations_delta", { citation });
    }
    state.endBlock();
  }

  // final index：输出非思考 text（原始 chunk 一行一行）
  state.startBlock(StreamingState.BLOCK_TEXT, { type: "text", text: "" });
  for (const text of state.webSearch.bufferedTextParts) {
    if (!text) continue;
    state.emitDelta("text_delta", { text });
  }
  state.endBlock();
}

module.exports = {
  makeSrvToolUseId,
  toWebSearchResults,
  resolveWebSearchRedirectUrls,
  buildNonStreamingWebSearchMessage,
  emitWebSearchBlocks,
};

