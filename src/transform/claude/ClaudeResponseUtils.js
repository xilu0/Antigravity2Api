const crypto = require("crypto");

function makeToolUseId() {
  // Claude Code expects tool_use ids to look like official "toolu_*" ids.
  return `toolu_vrtx_${crypto.randomBytes(16).toString("base64url")}`;
}

// 转换 usageMetadata 为 Claude 格式
function toClaudeUsage(usageMetadata = {}, options = {}) {
  const prompt = usageMetadata.promptTokenCount || 0;
  const candidates = usageMetadata.candidatesTokenCount || 0;
  const thoughts = usageMetadata.thoughtsTokenCount || 0;
  const cachedContent = usageMetadata.cachedContentTokenCount || 0;
  const maxContextTokens = options?.maxContextTokens;

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
  }

  // 剩余输入 tokens (排除缓存读取的部分)
  const remainingInput = Math.max(0, prompt - cachedContent);

  // 动态分配 input_tokens 和 cache_creation_input_tokens
  // 算法: 基于上下文使用率动态调整分配比例 (1:5-15)
  const MIN_DISTRIBUTION_THRESHOLD = 100;
  if (
    remainingInput > MIN_DISTRIBUTION_THRESHOLD &&
    Number.isFinite(maxContextTokens) &&
    maxContextTokens > 0
  ) {
    // 计算上下文使用率 (0.0 - 1.0)
    const utilization = Math.min(1.0, prompt / maxContextTokens);
    // 动态比例: 低使用率 -> 5, 高使用率 -> 15
    const ratio = Math.round(5 + 10 * utilization);

    // 分配: totalParts = 1 + ratio
    // input_tokens 占 1 份, cache_creation_input_tokens 占 ratio 份
    const totalParts = 1 + ratio;
    const inputPart = Math.floor(remainingInput / totalParts);
    const cacheCreationPart = remainingInput - inputPart;

    usage.input_tokens = inputPart;
    usage.cache_creation_input_tokens = cacheCreationPart;
  } else {
    // 没有模型上下文信息或 tokens 太少时，不分配 cache_creation
    usage.input_tokens = remainingInput;
  }

  return usage;
}

module.exports = {
  makeToolUseId,
  toClaudeUsage,
};

