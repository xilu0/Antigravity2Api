const RateLimiter = require("./RateLimiter");
const storage = require("./Storage");
const TokenRefresher = require("./TokenRefresher");
const httpClient = require("./httpClient");

function normalizeQuotaGroup(group) {
  const g = String(group || "").trim().toLowerCase();
  if (g === "claude") return "claude";
  if (g === "gemini") return "gemini";
  return "gemini";
}

function isValidProjectId(projectId) {
  const value = typeof projectId === "string" ? projectId.trim() : "";
  return value.length > 0;
}

function hasProjectIdRepairMarker(creds) {
  const value = creds?.projectIdResolvedAt;
  if (typeof value === "number" && Number.isFinite(value)) return true;
  if (typeof value === "string" && value.trim()) return true;
  return false;
}

function sanitizeCredentialFileName(fileName) {
  const name = String(fileName || "").trim();
  if (!name) throw new Error("file name is required");
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error("invalid file name");
  }
  if (!name.endsWith(".json")) {
    throw new Error("invalid credentials file (must be .json)");
  }
  return name;
}

class AuthManager {
  constructor(options = {}) {
    this.accounts = [];
    this.currentAccountIndexByGroup = { claude: 0, gemini: 0 };
    this.logger = options.logger;
    this.apiLimiter = options.rateLimiter || new RateLimiter(1 * 1000);

    if (!this.logger || typeof this.logger.log !== "function") {
      throw new Error("AuthManager requires options.logger with .log(level, message, meta)");
    }

    this.tokenRefresher = new TokenRefresher({
      logger: this.logger,
      refreshFn: this.refreshToken.bind(this),
    });

    this.initialTokenRefreshPromise = null;
    this.initialProjectIdRefreshPromise = null;
  }

  setLogger(logger) {
    this.logger = logger;
    if (this.tokenRefresher) {
      this.tokenRefresher.logger = logger;
    }
  }

  async waitForApiSlot() {
    if (this.apiLimiter) {
      await this.apiLimiter.wait();
    }
  }

  getAccountCount() {
    return this.accounts.length;
  }

  getAccountsSummary() {
    return this.accounts.map((account, index) => ({
      index,
      file: account.keyName,
      email: account.creds?.email || null,
      projectId: account.creds?.projectId || null,
      expiry_date: Number.isFinite(account.creds?.expiry_date) ? account.creds.expiry_date : null,
      token_type: account.creds?.token_type || null,
      scope: account.creds?.scope || null,
    }));
  }

  getCurrentAccountIndex(group) {
    const g = normalizeQuotaGroup(group);
    if (!this.currentAccountIndexByGroup || typeof this.currentAccountIndexByGroup !== "object") {
      this.currentAccountIndexByGroup = { claude: 0, gemini: 0 };
    }
    const idx = this.currentAccountIndexByGroup[g];
    return Number.isInteger(idx) ? idx : 0;
  }

  setCurrentAccountIndex(group, index) {
    const g = normalizeQuotaGroup(group);
    if (!this.currentAccountIndexByGroup || typeof this.currentAccountIndexByGroup !== "object") {
      this.currentAccountIndexByGroup = { claude: 0, gemini: 0 };
    }
    this.currentAccountIndexByGroup[g] = index;
  }

  async deleteAccountByFile(fileName) {
    const safeName = sanitizeCredentialFileName(fileName);
    const idx = this.accounts.findIndex((a) => a.keyName === safeName);
    if (idx === -1) {
      return false;
    }

    const account = this.accounts[idx];

    if (this.tokenRefresher) {
      this.tokenRefresher.cancelRefresh(account);
    } else if (account.refreshTimer) {
      clearTimeout(account.refreshTimer);
      account.refreshTimer = null;
    }

    await storage.delete(account.keyName);
    this.accounts.splice(idx, 1);

    for (const group of ["claude", "gemini"]) {
      const current = this.getCurrentAccountIndex(group);
      if (this.accounts.length === 0) {
        this.setCurrentAccountIndex(group, 0);
        continue;
      }
      if (idx < current) {
        this.setCurrentAccountIndex(group, Math.max(0, current - 1));
      } else if (idx === current) {
        this.setCurrentAccountIndex(group, Math.min(current, this.accounts.length - 1));
      }
    }

    return true;
  }

  async loadAccounts() {
    this.accounts = [];
    this.currentAccountIndexByGroup = { claude: 0, gemini: 0 };
    try {
      await storage.init();

      const entries = await storage.list();
      const candidates = entries.filter(
        (e) => e.key.endsWith(".json") && !e.key.startsWith("package") && e.key !== "tsconfig.json"
      );

      let loadedCount = 0;
      for (const entry of candidates) {
        try {
          const creds = entry.data;
          if (creds.access_token && creds.refresh_token && (creds.token_type || creds.scope)) {
            this.accounts.push({
              keyName: entry.key,
              creds,
              refreshPromise: null,
              refreshTimer: null,
              projectPromise: null,
            });
            loadedCount++;
          }
        } catch (e) {}
      }

      if (loadedCount === 0) {
        this.logger.log("warn", "⚠️ 未找到任何账户");
        return;
      }

      this.logger.log("success", `✅ 已加载 ${this.accounts.length} 个账户`);

      for (const account of this.accounts) {
        this.tokenRefresher.scheduleRefresh(account);
      }

      this.initialTokenRefreshPromise = this.tokenRefresher
        ? this.tokenRefresher.refreshDueAccountsNow().catch(() => {})
        : Promise.resolve();

      this.initialProjectIdRefreshPromise = (async () => {
        try {
          await this.waitInitialTokenRefresh();
        } catch (_) {}
        await this.refreshAllProjectIds();
      })().catch(() => {});
    } catch (err) {
      this.logger.log("error", `Error loading accounts: ${err.message || err}`);
    }
  }

  async waitInitialTokenRefresh() {
    if (this.initialTokenRefreshPromise) {
      await this.initialTokenRefreshPromise;
    }
  }

  async waitInitialProjectIdRefresh() {
    if (this.initialProjectIdRefreshPromise) {
      await this.initialProjectIdRefreshPromise;
    }
  }

  async refreshAllProjectIds() {
    const count = this.getAccountCount();
    if (!count) return { ok: 0, fail: 0, total: 0 };

    const perAccount = [];
    for (let i = 0; i < count; i++) {
      perAccount.push(
        (async () => {
          const account = this.accounts[i];
          const accountName = account?.keyName || `account_${i}`;
          try {
            if (account?.creds && isValidProjectId(account.creds.projectId) && hasProjectIdRepairMarker(account.creds)) {
              return { ok: true, accountName, skipped: true };
            }

            const token = await this.getAccessTokenByIndex(i, "project-repair");
            const accessToken = token?.accessToken;
            if (!accessToken) {
              throw new Error("Missing access_token");
            }

            const projectId = await httpClient.fetchProjectId(accessToken, null, { maxAttempts: 3 });
            if (!isValidProjectId(projectId)) {
              throw new Error(`Invalid projectId: ${String(projectId || "")}`.trim());
            }

            if (!account?.creds) {
              throw new Error("Account not loaded");
            }
            const needsWrite =
              account.creds.projectId !== projectId || !hasProjectIdRepairMarker(account.creds);
            account.creds.projectId = projectId;
            account.creds.projectIdResolvedAt = new Date().toISOString();
            if (needsWrite) {
              await storage.set(account.keyName, account.creds);
            }

            return { ok: true, accountName };
          } catch (e) {
            return { ok: false, accountName, error: e };
          }
        })()
      );
    }

    const results = await Promise.all(perAccount);

    let ok = 0;
    let fail = 0;
    for (const r of results) {
      if (r?.ok) {
        ok++;
        continue;
      }
      fail++;
      const msg = String(r?.error?.message || r?.error || "unknown error").split("\n")[0].slice(0, 200);
      this.logger.log("warn", `⚠️ projectId 修复失败 @${r?.accountName || "unknown-account"}${msg ? ` (${msg})` : ""}`);
    }

    this.logger.log("info", `projectId 修复完成 ok=${ok} fail=${fail}`);
    return { ok, fail, total: count };
  }

  async reloadAccounts() {
    if (Array.isArray(this.accounts)) {
      for (const account of this.accounts) {
        if (this.tokenRefresher) {
          this.tokenRefresher.cancelRefresh(account);
        } else if (account?.refreshTimer) {
          clearTimeout(account.refreshTimer);
          account.refreshTimer = null;
        }
      }
    }

    await this.loadAccounts();
    return this.getAccountsSummary();
  }

  async fetchProjectId(accessToken) {
    return httpClient.fetchProjectId(accessToken, this.apiLimiter, { maxAttempts: 3 });
  }

  async ensureProjectId(account) {
    const existing = account?.creds?.projectId;
    if (isValidProjectId(existing) && hasProjectIdRepairMarker(account?.creds)) return existing.trim();

    if (account.projectPromise) {
      return account.projectPromise;
    }

    account.projectPromise = (async () => {
      const projectId = await this.fetchProjectId(account.creds.access_token);
      if (!isValidProjectId(projectId)) {
        throw new Error(`Failed to obtain valid projectId: ${String(projectId || "")}`.trim());
      }

      account.creds.projectId = projectId;
      account.creds.projectIdResolvedAt = new Date().toISOString();
      await storage.set(account.keyName, account.creds);
      this.logger.log("info", `✅ 获取 projectId 成功: ${projectId}`);
      return projectId;
    })();

    try {
      return await account.projectPromise;
    } finally {
      account.projectPromise = null;
    }
  }

  async getCredentials(group) {
    if (this.accounts.length === 0) {
      throw new Error("No accounts available. Please authenticate first.");
    }

    const quotaGroup = normalizeQuotaGroup(group);
    const accountIndex = this.getCurrentAccountIndex(quotaGroup);
    const account = this.accounts[accountIndex];

    if (account.refreshPromise) {
      await account.refreshPromise;
    }

    if (account.creds.expiry_date < +new Date()) {
      const accountName = account.keyName;
      this.logger.log("info", `Refreshing token for [${quotaGroup}] account ${accountIndex + 1} (${accountName})...`);
      await this.refreshToken(account);
    }

    await this.ensureProjectId(account);

    return {
      accessToken: account.creds.access_token,
      projectId: account.creds.projectId,
      account,
    };
  }

  async getCredentialsByIndex(index, group) {
    if (this.accounts.length === 0) {
      throw new Error("No accounts available. Please authenticate first.");
    }

    const quotaGroup = normalizeQuotaGroup(group);
    const logGroup = group ? String(group).trim() : quotaGroup;
    const accountIndex = Number.isInteger(index) ? index : Number.parseInt(String(index), 10);
    if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex >= this.accounts.length) {
      throw new Error(`Invalid account index: ${index}`);
    }

    const account = this.accounts[accountIndex];

    if (account.refreshPromise) {
      await account.refreshPromise;
    }

    if (account.creds.expiry_date < +new Date()) {
      const accountName = account.keyName;
      this.logger.log("info", `Refreshing token for [${logGroup}] account ${accountIndex + 1} (${accountName})...`);
      await this.refreshToken(account);
    }

    await this.ensureProjectId(account);

    return {
      accessToken: account.creds.access_token,
      projectId: account.creds.projectId,
      account,
      accountIndex,
    };
  }

  async getAccessTokenByIndex(index, group) {
    if (this.accounts.length === 0) {
      throw new Error("No accounts available. Please authenticate first.");
    }

    const quotaGroup = normalizeQuotaGroup(group);
    const logGroup = group ? String(group).trim() : quotaGroup;
    const accountIndex = Number.isInteger(index) ? index : Number.parseInt(String(index), 10);
    if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex >= this.accounts.length) {
      throw new Error(`Invalid account index: ${index}`);
    }

    const account = this.accounts[accountIndex];

    if (account.refreshPromise) {
      await account.refreshPromise;
    }

    if (account.creds.expiry_date < +new Date()) {
      const accountName = account.keyName;
      this.logger.log("info", `Refreshing token for [${logGroup}] account ${accountIndex + 1} (${accountName})...`);
      await this.refreshToken(account);
    }

    return {
      accessToken: account.creds.access_token,
      account,
      accountIndex,
    };
  }

  async getCurrentAccessToken(group) {
    const { accessToken } = await this.getCredentials(group);
    return accessToken;
  }

  async fetchAvailableModels() {
    const { accessToken, projectId } = await this.getCredentials();
    await this.waitForApiSlot();
    return httpClient.fetchAvailableModels(accessToken, this.apiLimiter, projectId);
  }

  async fetchUserInfo(accessToken) {
    await this.waitForApiSlot();
    return httpClient.fetchUserInfo(accessToken, this.apiLimiter);
  }

  async addAccount(formattedData) {
    const previousClaudeIndex = this.getCurrentAccountIndex("claude");
    const previousGeminiIndex = this.getCurrentAccountIndex("gemini");
    const hadAccountsBefore = this.accounts.length > 0;

    await storage.init();

    const projectId = await this.fetchProjectId(formattedData.access_token);
    if (!isValidProjectId(projectId)) {
      throw new Error(`Failed to obtain valid projectId, account is not eligible: ${String(projectId || "")}`.trim());
    }
    formattedData.projectId = projectId;
    formattedData.projectIdResolvedAt = new Date().toISOString();
    this.logger.log("info", `✅ 项目ID获取成功: ${projectId}`);

    const email = formattedData.email;

    let targetKeyName = null;
    let existingAccountIndex = -1;

    if (email) {
      for (let i = 0; i < this.accounts.length; i++) {
        const acc = this.accounts[i];

        let accEmail = acc.creds.email;
        if (!accEmail) {
          if (acc.creds.expiry_date > +new Date()) {
            const accInfo = await this.fetchUserInfo(acc.creds.access_token);
            if (accInfo && accInfo.email) {
              accEmail = accInfo.email;
              acc.creds.email = accEmail;
            }
          }
        }

        if (accEmail && accEmail === email) {
          targetKeyName = acc.keyName;
          existingAccountIndex = i;
          this.logger.log("info", `Found existing account for ${email}, updating...`);
          break;
        }
      }
    }

    let oldKeyNameToDelete = null;
    if (existingAccountIndex !== -1) {
      targetKeyName = this.accounts[existingAccountIndex].keyName;

      if (email) {
        const safeEmail = email.replace(/[^a-zA-Z0-9@.]/g, "_");
        const newKeyName = `${safeEmail}.json`;

        if (targetKeyName !== newKeyName) {
          oldKeyNameToDelete = targetKeyName;
          targetKeyName = newKeyName;
          this.accounts[existingAccountIndex].keyName = newKeyName;
          this.logger.log("info", `Renamed credentials to ${newKeyName}`);
        }
      }
    } else {
      if (email) {
        const safeEmail = email.replace(/[^a-zA-Z0-9@.]/g, "_");
        targetKeyName = `${safeEmail}.json`;
      } else {
        targetKeyName = `oauth-${Date.now()}.json`;
      }
    }

    await storage.set(targetKeyName, formattedData);

    if (oldKeyNameToDelete) {
      try {
        await storage.delete(oldKeyNameToDelete);
      } catch (e) {
        this.logger.log("warn", `Failed to delete old key "${oldKeyNameToDelete}": ${e.message || e}`);
      }
    }

    let targetAccount;
    if (existingAccountIndex !== -1) {
      this.accounts[existingAccountIndex].creds = formattedData;
      targetAccount = this.accounts[existingAccountIndex];
    } else {
      targetAccount = {
        keyName: targetKeyName,
        creds: formattedData,
        refreshPromise: null,
        refreshTimer: null,
        projectPromise: null,
      };
      this.accounts.push(targetAccount);
    }

    const clampIndex = (idx) => {
      if (this.accounts.length === 0) return 0;
      const n = Number.isInteger(idx) ? idx : 0;
      return Math.max(0, Math.min(n, this.accounts.length - 1));
    };

    if (!hadAccountsBefore) {
      this.setCurrentAccountIndex("claude", 0);
      this.setCurrentAccountIndex("gemini", 0);
    } else {
      this.setCurrentAccountIndex("claude", clampIndex(previousClaudeIndex));
      this.setCurrentAccountIndex("gemini", clampIndex(previousGeminiIndex));
    }

    this.tokenRefresher.scheduleRefresh(targetAccount);

    this.logger.log("info", "✅ OAuth authentication successful! Credentials saved.");
    this.logger.log("info", "ℹ️  To add more accounts, run: npm run add (or: node src/server.js --add)");
    this.logger.log("info", "🚀 You can now use the API.");
  }

  async refreshToken(account) {
    if (account.refreshPromise) {
      return account.refreshPromise;
    }

    account.refreshPromise = (async () => {
      try {
        const refresh_token = account.creds.refresh_token;
        const data = await httpClient.refreshToken(refresh_token, null);

        if (account.creds.email) {
          data.email = account.creds.email;
        }

        const existingProjectId = account.creds.projectId;
        if (isValidProjectId(existingProjectId) && hasProjectIdRepairMarker(account.creds)) {
          data.projectId = existingProjectId.trim();
          data.projectIdResolvedAt = account.creds.projectIdResolvedAt;
        } else {
          const projectId = await this.fetchProjectId(data.access_token);
          if (!isValidProjectId(projectId)) {
            throw new Error(`Failed to obtain valid projectId during refresh: ${String(projectId || "")}`.trim());
          }
          data.projectId = projectId;
          data.projectIdResolvedAt = new Date().toISOString();
          this.logger.log("info", `✅ 刷新时获取 projectId 成功: ${projectId}`);
        }

        account.creds = data;
        await storage.set(account.keyName, data);
        this.logger.log("info", `✅ Token refreshed for ${account.keyName}`);

        this.tokenRefresher.scheduleRefresh(account);

        return data.access_token;
      } finally {
        account.refreshPromise = null;
      }
    })();

    return account.refreshPromise;
  }
}

module.exports = AuthManager;
