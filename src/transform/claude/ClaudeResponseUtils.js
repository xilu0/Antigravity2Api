const crypto = require("crypto");

function makeToolUseId() {
  // Claude Code expects tool_use ids to look like official "toolu_*" ids.
  return `toolu_vrtx_${crypto.randomBytes(16).toString("base64url")}`;
}

// 转换 usageMetadata 为 Claude 格式
function toClaudeUsage(usageMetadata = {}) {
  const prompt = usageMetadata.promptTokenCount || 0;
  const candidates = usageMetadata.candidatesTokenCount || 0;
  const thoughts = usageMetadata.thoughtsTokenCount || 0;
  const cachedContent = usageMetadata.cachedContentTokenCount || 0;

  // 构建基础 usage 对象
  const usage = {};

  // 计算 output_tokens
  if (usageMetadata.totalTokenCount && usageMetadata.totalTokenCount >= prompt) {
    usage.output_tokens = usageMetadata.totalTokenCount - prompt;
  } else {
    usage.output_tokens = candidates + thoughts;
  }

  // 处理缓存相关 tokens
  // Gemini 的 cachedContentTokenCount 表示从缓存读取的 tokens
  // 映射到 Claude 的 cache_read_input_tokens
  if (cachedContent > 0) {
    usage.cache_read_input_tokens = cachedContent;
    // input_tokens 是除去缓存后的实际输入 tokens
    usage.input_tokens = Math.max(0, prompt - cachedContent);
  } else {
    usage.input_tokens = prompt;
  }

  // 注意：Gemini API 目前不直接提供 cache_creation_input_tokens
  // 如果将来 Gemini 提供了相关字段，可以在这里添加映射

  return usage;
}

module.exports = {
  makeToolUseId,
  toClaudeUsage,
};

