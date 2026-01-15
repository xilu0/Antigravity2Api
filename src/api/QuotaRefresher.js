const path = require("path");

const httpClient = require("../auth/httpClient");

function parseEnvNonNegativeInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

const QUOTA_REFRESH_S = parseEnvNonNegativeInt("AG2API_QUOTA_REFRESH_S", 300);
const DEFAULT_REFRESH_INTERVAL_MS = QUOTA_REFRESH_S * 1000;

class QuotaRefresher {
  constructor(authManager, options = {}) {
    this.auth = authManager;
    this.logger = options.logger || null;

    this.refreshIntervalMs = Number.isFinite(options.refreshIntervalMs)
      ? options.refreshIntervalMs
      : DEFAULT_REFRESH_INTERVAL_MS;
    this.initialWaitMs = Number.isFinite(options.initialWaitMs) ? options.initialWaitMs : 3000;

    this.modelQuotaByAccount = new Map();
    this.lastErrorByModel = new Map();
    this.nextAccountIndexByModel = new Map();

    this._refreshTimer = null;
    this._refreshPromise = null;
    this._initialRefreshPromise = null;
    this._initialRefreshDone = false;
  }

  log(levelOrTitle, messageOrData, meta) {
    if (this.logger) {
      if (typeof this.logger.log === "function") {
        return this.logger.log(String(levelOrTitle).toLowerCase(), messageOrData, meta);
      }
      if (typeof this.logger === "function") {
        return this.logger(levelOrTitle, messageOrData, meta);
      }
    }

    const title = String(levelOrTitle);
    if (meta !== undefined && meta !== null) {
      console.log(`[${title}]`, messageOrData, meta);
      return;
    }
    if (messageOrData !== undefined && messageOrData !== null) {
      console.log(
        `[${title}]`,
        typeof messageOrData === "string" ? messageOrData : JSON.stringify(messageOrData, null, 2)
      );
      return;
    }
    console.log(`[${title}]`);
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (timer && typeof timer.unref === "function") timer.unref();
    });
  }

  getAccountKeyFromAccount(account) {
    return account?.filePath ? path.basename(account.filePath) : "unknown-account";
  }

  start() {
    if (this._refreshTimer || this._initialRefreshPromise) return;

    this._initialRefreshPromise = (async () => {
      try {
        const ready = await this.waitForAccountsReady(this.initialWaitMs);
        if (!ready) return;
        if (this.auth && typeof this.auth.waitInitialTokenRefresh === "function") {
          await this.auth.waitInitialTokenRefresh();
        }
        await this.refreshAllAccountQuotas();
      } catch (e) {
        this.log("error", "额度刷新失败", e?.message || e);
      }
    })().finally(() => {
      this._initialRefreshDone = true;
    });

    if (!Number.isFinite(this.refreshIntervalMs) || this.refreshIntervalMs <= 0) return;

    const tick = async () => {
      try {
        await this.refreshAllAccountQuotas();
      } catch (e) {
        this.log("error", "额度刷新失败", e?.message || e);
      }
    };

    this._refreshTimer = setInterval(() => tick(), this.refreshIntervalMs);
    if (this._refreshTimer && typeof this._refreshTimer.unref === "function") this._refreshTimer.unref();
  }

  stop() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  async waitForAccountsReady(timeoutMs) {
    const timeout = Number.isFinite(timeoutMs) ? timeoutMs : 0;
    if (timeout <= 0) {
      const count = this.auth && typeof this.auth.getAccountCount === "function" ? this.auth.getAccountCount() : 0;
      return count > 0;
    }

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const count = this.auth && typeof this.auth.getAccountCount === "function" ? this.auth.getAccountCount() : 0;
      if (count > 0) return true;
      await this.sleep(50);
    }

    const count = this.auth && typeof this.auth.getAccountCount === "function" ? this.auth.getAccountCount() : 0;
    return count > 0;
  }

  async waitInitialRefresh(timeoutMs) {
    if (!this._initialRefreshPromise) return false;
    if (this._initialRefreshDone) return true;

    const timeout = Number.isFinite(timeoutMs) ? timeoutMs : 0;
    if (timeout <= 0) {
      await this._initialRefreshPromise;
      return true;
    }

    try {
      await Promise.race([this._initialRefreshPromise, this.sleep(timeout)]);
    } catch (_) {}

    return this._initialRefreshDone;
  }

  updateQuotaCacheFromModels(accountKey, models, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (!models || typeof models !== "object") return;

    for (const modelId of Object.keys(models)) {
      const quotaInfo = models[modelId]?.quotaInfo || {};
      const remainingFraction = quotaInfo.remainingFraction;
      const remainingPercent =
        remainingFraction !== undefined && remainingFraction !== null ? Math.round(remainingFraction * 100) : null;
      const resetTime = quotaInfo.resetTime || null;
      const resetTimeMs = resetTime ? Date.parse(resetTime) : null;

      const perModel = this.modelQuotaByAccount.get(modelId) || new Map();
      const prev = perModel.get(accountKey) || {};
      perModel.set(accountKey, {
        ...prev,
        remainingFraction,
        remainingPercent,
        resetTime,
        resetTimeMs: Number.isFinite(resetTimeMs) ? resetTimeMs : null,
        updatedAtMs: now,
      });
      this.modelQuotaByAccount.set(modelId, perModel);
    }
  }

  async fetchModelsByAccountIndex(accountIndex) {
    const idx = Number.isInteger(accountIndex) ? accountIndex : Number.parseInt(String(accountIndex), 10);
    if (!Number.isInteger(idx) || idx < 0) {
      throw new Error(`Invalid account index: ${accountIndex}`);
    }

    const accounts = Array.isArray(this.auth?.accounts) ? this.auth.accounts : [];
    if (idx >= accounts.length) {
      throw new Error(`Invalid account index: ${accountIndex}`);
    }

    let account = accounts[idx];
    let accessToken = account?.creds?.access_token || null;
    let projectId = account?.creds?.projectId || null;

    if (typeof this.auth?.getCredentialsByIndex === "function") {
      const creds = await this.auth.getCredentialsByIndex(idx, "quota-refresh");
      account = creds.account;
      accessToken = creds.accessToken;
      projectId = creds.projectId || projectId;
    } else if (typeof this.auth?.getAccessTokenByIndex === "function") {
      const creds = await this.auth.getAccessTokenByIndex(idx, "quota-refresh");
      account = creds.account;
      accessToken = creds.accessToken;
      projectId = account?.creds?.projectId || projectId;
    }

    if (!accessToken) {
      throw new Error("Missing access_token");
    }

    const models = await httpClient.fetchAvailableModels(accessToken, null, projectId);
    const accountKey = this.getAccountKeyFromAccount(account) || `account_${idx}`;
    this.updateQuotaCacheFromModels(accountKey, models, Date.now());
    return models || {};
  }

  async refreshAllAccountQuotas() {
    if (this._refreshPromise) return this._refreshPromise;
    if (!this.auth || typeof this.auth.getAccountCount !== "function") return { ok: 0, fail: 0, total: 0 };

    const accountCount = this.auth.getAccountCount();
    if (!accountCount) return { ok: 0, fail: 0, total: 0 };

    this._refreshPromise = (async () => {
      const now = Date.now();
      const perAccount = [];

      for (let accountIndex = 0; accountIndex < accountCount; accountIndex++) {
        perAccount.push(
          (async () => {
            let account = null;
            let accessToken = null;
            let projectId = null;

            try {
              if (typeof this.auth.getCredentialsByIndex === "function") {
                const creds = await this.auth.getCredentialsByIndex(accountIndex, "quota-refresh");
                account = creds.account;
                accessToken = creds.accessToken;
                projectId = creds.projectId || null;
              } else if (typeof this.auth.getAccessTokenByIndex === "function") {
                const creds = await this.auth.getAccessTokenByIndex(accountIndex, "quota-refresh");
                account = creds.account;
                accessToken = creds.accessToken;
                projectId = account?.creds?.projectId || null;
              } else if (Array.isArray(this.auth.accounts)) {
                account = this.auth.accounts[accountIndex];
                accessToken = account?.creds?.access_token || null;
                projectId = account?.creds?.projectId || null;
              }
            } catch (e) {
              const accountKey = this.getAccountKeyFromAccount(account) || `account_${accountIndex}`;
              return { accountKey, ok: false, error: e };
            }

            const accountKey = this.getAccountKeyFromAccount(account);
            if (!accessToken) {
              return { accountKey, ok: false, error: new Error("Missing access_token") };
            }

            try {
              const models = await httpClient.fetchAvailableModels(accessToken, null, projectId);
              return { accountKey, ok: true, models };
            } catch (e) {
              return { accountKey, ok: false, error: e };
            }
          })()
        );
      }

      const results = await Promise.all(perAccount);

      let ok = 0;
      let fail = 0;

      for (const item of results) {
        if (!item || !item.ok) {
          fail++;
          const accountKey = item?.accountKey || "unknown-account";
          const message = String(item?.error?.message || item?.error || "unknown error")
            .split("\n")[0]
            .slice(0, 200);
          this.log("quota", `额度刷新失败 @${accountKey}${message ? ` (${message})` : ""}`);
          continue;
        }

        ok++;
        this.updateQuotaCacheFromModels(item.accountKey, item.models, now);
      }

      this.log("quota", `额度刷新完成 ok=${ok} fail=${fail}`);
      return { ok, fail, total: results.length };
    })().finally(() => {
      this._refreshPromise = null;
    });

    return this._refreshPromise;
  }

  setCooldownUntil(modelId, accountKey, cooldownUntilMs) {
    const key = String(modelId || "").trim();
    if (!key) return;
    const perModel = this.modelQuotaByAccount.get(key) || new Map();
    const prev = perModel.get(accountKey) || {};
    perModel.set(accountKey, {
      ...prev,
      cooldownUntilMs: Number.isFinite(cooldownUntilMs) ? cooldownUntilMs : null,
    });
    this.modelQuotaByAccount.set(key, perModel);
  }

  async cacheLastErrorResponse(modelId, response) {
    const key = String(modelId || "").trim();
    if (!key || !response) return;

    let bodyText = "";
    try {
      bodyText = await response.clone().text();
    } catch (_) {}

    const headers = {};
    try {
      response.headers?.forEach?.((value, name) => {
        headers[name] = value;
      });
    } catch (_) {}

    this.lastErrorByModel.set(key, {
      status: response.status,
      headers,
      bodyText,
      cachedAtMs: Date.now(),
    });
  }

  getCachedErrorResponse(modelId) {
    const key = String(modelId || "").trim();
    if (!key) return null;
    const cached = this.lastErrorByModel.get(key);
    if (!cached) return null;

    try {
      return new Response(cached.bodyText || "", {
        status: cached.status || 429,
        headers: cached.headers || {},
      });
    } catch (_) {
      return null;
    }
  }

  getSynthetic429(modelId, message) {
    const body = {
      error: {
        message: message || `Quota exhausted for model ${String(modelId || "").trim() || "(unknown)"}`,
        status: "RESOURCE_EXHAUSTED",
        code: 429,
      },
    };
    return new Response(JSON.stringify(body), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }

  pickAccountIndex(modelId, options = {}) {
    const modelKey = String(modelId || "").trim();
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const cooldownWaitThresholdMs = Number.isFinite(options.cooldownWaitThresholdMs) ? options.cooldownWaitThresholdMs : 5000;
    const excludeAccountIndices =
      options.excludeAccountIndices instanceof Set ? options.excludeAccountIndices : new Set();

    const accounts = Array.isArray(this.auth?.accounts) ? this.auth.accounts : [];
    if (!modelKey || accounts.length === 0) {
      return { kind: "fast_fail", response: null, reason: "no_accounts" };
    }

    const perModel = this.modelQuotaByAccount.get(modelKey);

    let globalKnownCount = 0;
    let globalNonZeroKnownCount = 0;

    for (let accountIndex = 0; accountIndex < accounts.length; accountIndex++) {
      const accountKey = this.getAccountKeyFromAccount(accounts[accountIndex]);
      const q = perModel ? perModel.get(accountKey) : null;
      const remainingPercent = Number.isFinite(q?.remainingPercent) ? q.remainingPercent : null;
      if (remainingPercent !== null) {
        globalKnownCount++;
        if (remainingPercent > 0) globalNonZeroKnownCount++;
      }
    }

    const allZeroKnown =
      accounts.length > 0 && globalKnownCount === accounts.length && globalNonZeroKnownCount === 0;
    if (allZeroKnown) {
      const cached = this.getCachedErrorResponse(modelKey);
      return {
        kind: "fast_fail",
        reason: "all_zero_known",
        response: cached || this.getSynthetic429(modelKey, `All accounts exhausted (0% quota) for model ${modelKey}`),
      };
    }

    const candidates = [];

    for (let accountIndex = 0; accountIndex < accounts.length; accountIndex++) {
      if (excludeAccountIndices.has(accountIndex)) continue;

      const accountKey = this.getAccountKeyFromAccount(accounts[accountIndex]);
      const q = perModel ? perModel.get(accountKey) : null;
      const remainingPercent = Number.isFinite(q?.remainingPercent) ? q.remainingPercent : null;
      if (remainingPercent === 0) continue;

      const cooldownUntilMs = Number.isFinite(q?.cooldownUntilMs) ? q.cooldownUntilMs : 0;
      const cooldownActive = cooldownUntilMs > now;

      candidates.push({
        accountIndex,
        accountKey,
        remainingPercent,
        cooldownUntilMs,
        cooldownActive,
      });
    }

    if (candidates.length === 0) {
      const cached = this.getCachedErrorResponse(modelKey);
      return {
        kind: "fast_fail",
        reason: "no_candidates",
        response: cached || this.getSynthetic429(modelKey, `No eligible accounts for model ${modelKey}`),
      };
    }

    const active = candidates.filter((c) => !c.cooldownActive);
    if (active.length === 0) {
      let minRemaining = Number.POSITIVE_INFINITY;
      for (const c of candidates) {
        const remaining = c.cooldownUntilMs - now;
        if (Number.isFinite(remaining) && remaining >= 0) {
          minRemaining = Math.min(minRemaining, remaining);
        }
      }

      if (Number.isFinite(minRemaining) && minRemaining <= cooldownWaitThresholdMs) {
        return { kind: "wait", waitMs: Math.max(0, Math.ceil(minRemaining)), reason: "cooldown_short" };
      }

      const cached = this.getCachedErrorResponse(modelKey);
      return {
        kind: "fast_fail",
        reason: "cooldown_long",
        response: cached || this.getSynthetic429(modelKey, `All accounts are in cooldown for model ${modelKey}`),
      };
    }

    const knownActive = active.filter((c) => c.remainingPercent !== null && c.remainingPercent > 0);

    let finalists;
    if (knownActive.length > 0) {
      let best = 0;
      for (const c of knownActive) best = Math.max(best, c.remainingPercent);
      finalists = knownActive.filter((c) => c.remainingPercent === best);
    } else {
      finalists = active.filter((c) => c.remainingPercent === null);
    }

    finalists.sort((a, b) => a.accountIndex - b.accountIndex);

    const accountCount = accounts.length;
    const nextStart = this.nextAccountIndexByModel.has(modelKey)
      ? this.nextAccountIndexByModel.get(modelKey)
      : 0;
    const startIndex = Number.isInteger(nextStart) && accountCount > 0 ? ((nextStart % accountCount) + accountCount) % accountCount : 0;

    const picked =
      finalists.find((c) => c.accountIndex >= startIndex) ||
      finalists[0] ||
      active[0];

    if (!picked) {
      const cached = this.getCachedErrorResponse(modelKey);
      return {
        kind: "fast_fail",
        reason: "no_pick",
        response: cached || this.getSynthetic429(modelKey, `Failed to pick an account for model ${modelKey}`),
      };
    }

    this.nextAccountIndexByModel.set(modelKey, picked.accountIndex + 1);
    return { kind: "pick", accountIndex: picked.accountIndex, reason: "picked" };
  }
}

module.exports = QuotaRefresher;
