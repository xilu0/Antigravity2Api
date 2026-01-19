# 帐号调度算法

本文档描述 Antigravity2Api 服务的帐号调度、429 处理及异常帐号管理机制。

---

## 1. 帐号选择策略 (Quota-Aware Rotation)

### 轮询分组
- 分为 `claude` 和 `gemini` 两个配额组（按模型名称判断）
- 每组维护独立的 `currentAccountIndex`

### 选择优先级 (`QuotaRefresher.pickAccountIndex()`)
1. **排除** quota ≤ 0% 或已尝试过的帐号
2. **优先选择** `remainingPercent` 最高的帐号
3. 同等配额时，使用 **per-model 轮询** 分配

### 相关代码
- `src/auth/AuthManager.js` - 帐号管理与基础轮询
- `src/api/QuotaRefresher.js:392-519` - `pickAccountIndex()` 实现

---

## 2. 429 限速处理

| 场景 | 处理方式 |
|------|---------|
| **多帐号模式** | 立即设置 cooldown 时间戳，**轮换到下一帐号**重试 |
| **单帐号 + 短冷却** (≤ 5s) | 等待 `retryDelay + 200ms`，**同帐号重试** |
| **单帐号 + 长冷却** (> 5s) | **直接返回 429** 给客户端 |
| **所有帐号都在冷却中** | 最短冷却 ≤ 5s 则等待；否则 fast-fail 返回 429 |
| **所有帐号 quota 耗尽** | 合成 429 响应直接返回 |

### 处理流程 (`src/api/upstream.js`)
1. 检测 429 响应
2. 解析 `RetryInfo.retryDelay` 或 `quotaResetDelay`（如 `"1.203608125s"` 或 `"1h16m0.667923083s"`）
3. 设置帐号冷却时间戳 `cooldownUntilMs`
4. 根据帐号数量决定：轮换或等待重试

---

## 3. 异常帐号处理

**关键设计：没有永久黑名单机制**

| 错误类型 | 处理 |
|---------|------|
| **网络错误** | 延迟 `FIXED_RETRY_DELAY_MS`(1200ms) 后重试，多帐号时轮换 |
| **凭证错误** | 立即抛出异常，视为配置问题 |
| **Token 刷新失败** | 抛错但不移除帐号 |
| **Quota 刷新失败** | 记录日志，帐号仍留在池中，下次刷新重试 |
| **429 冷却** | 设置 `cooldownUntilMs` 时间戳，**时间到期后自动恢复** |

---

## 4. 配额管理系统

### 数据结构
```javascript
// Map<modelId, Map<accountKey, quotaInfo>>
this.modelQuotaByAccount = new Map();
```

每个帐号的配额信息包含：
- `remainingFraction` (0.0 - 1.0)
- `remainingPercent` (0 - 100)
- `resetTime` / `resetTimeMs`
- `cooldownUntilMs` (429 冷却时间)
- `updatedAtMs` (最后刷新时间)
- `inputTokenLimit` (上下文窗口)

### 刷新机制
- **定时刷新**：默认每 300 秒 (`AG2API_QUOTA_REFRESH_S`) 并行获取所有帐号配额
- **首次请求**：等待最多 3 秒确保配额数据可用
- **未知配额**：视为有效候选（支持新增帐号）

---

## 5. 设计决策总结

| 方面 | 行为 |
|------|------|
| **轮询策略** | 在配额最高的帐号中进行 per-model 轮询 |
| **429 处理** | 立即轮换（多帐号）或短等待重试（单帐号） |
| **冷却时长** | 从 API 响应解析，通常为秒到分钟级别 |
| **永久封禁** | **无** - 所有错误都是临时的（基于时间冷却） |
| **网络错误** | 延迟后重试，多帐号时轮换 |
| **配额感知** | 通过定时刷新实时获取，优先选择配额最高的帐号 |
| **帐号健康** | 无显式"坏帐号"状态；仅有 quota% 和冷却时间戳 |
| **排除机制** | 通过 `triedAccountIndices` Set 临时排除（每请求周期） |
