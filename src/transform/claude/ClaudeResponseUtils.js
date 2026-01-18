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
  const maxContextTokens = options?.maxContextTokens;

  // 构建基础 usage 对象
  const usage = {};

  // 计算 output_tokens
  if (usageMetadata.totalTokenCount && usageMetadata.totalTokenCount >= prompt) {
    usage.output_tokens = usageMetadata.totalTokenCount - prompt;
  } else {
    usage.output_tokens = candidates + thoughts;
  }

  // 三方动态分配: input_tokens, cache_creation_input_tokens, cache_read_input_tokens
  // 算法: 基于上下文使用率动态调整分配比例
  // 低使用率 (0%):  input:creation:read = 1:15:84
  // 高使用率 (100%): input:creation:read = 1:4:95
  const MIN_DISTRIBUTION_THRESHOLD = 100;
  if (
    prompt > MIN_DISTRIBUTION_THRESHOLD &&
    Number.isFinite(maxContextTokens) &&
    maxContextTokens > 0
  ) {
    // 计算上下文使用率 (0.0 - 1.0)
    const utilization = Math.min(1.0, prompt / maxContextTokens);

    // 动态比例:
    // inputRatio: 固定为 1%
    // creationRatio: 15% → 4% (随使用率增加而减少)
    // readRatio: 剩余部分 (84% → 95%)
    const inputRatio = 1;
    const creationRatio = Math.round(15 - 11 * utilization);
    const totalParts = 100;

    const inputPart = Math.floor((prompt * inputRatio) / totalParts);
    const creationPart = Math.floor((prompt * creationRatio) / totalParts);
    const readPart = prompt - inputPart - creationPart;

    usage.input_tokens = inputPart;
    usage.cache_creation_input_tokens = creationPart;
    usage.cache_read_input_tokens = readPart;
  } else {
    // 没有模型上下文信息或 tokens 太少时，不分配缓存
    usage.input_tokens = prompt;
  }

  return usage;
}

module.exports = {
  makeToolUseId,
  toClaudeUsage,
};

