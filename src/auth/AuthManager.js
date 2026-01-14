const RateLimiter = require("./RateLimiter");
const storage = require("./Storage");
const TokenRefresher = require("./TokenRefresher");
const httpClient = require("./httpClient");

function generateProjectId() {
  // 生成类似 "fabled-setup-3dmkj" 的格式：word-word-5位随机
  const adjectives = [
    "fabled",
    "spry",
    "apt",
    "astral",
    "infra",
    "brisk",
    "calm",
    "daring",
    "eager",
    "gentle",
    "lively",
    "noble",
    "quick",
    "rural",
    "solar",
    "tidy",
    "vivid",
    "witty",
    "young",
    "zesty",
  ];
  const nouns = [
    "setup",
    "post",
    "site",
    "scout",
    "battery",
    "arbor",
    "beacon",
    "canyon",
    "delta",
    "ember",
    "grove",
    "harbor",
    "meadow",
    "nexus",
    "prairie",
    "ridge",
    "savanna",
    "tundra",
    "valley",
    "willow",
  ];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  // 生成 5 位 base36 随机串
  let suffix = "";
  while (suffix.length < 5) {
    suffix += require("crypto").randomBytes(4).readUInt32BE().toString(36);
  }
  suffix = suffix.slice(0, 5);
  return `${adj}-${noun}-${suffix}`;
}

function normalizeQuotaGroup(group) {
  const g = String(group || "").trim().toLowerCase();
  if (g === "claude") return "claude";
  if (g === "gemini") return "gemini";
  return "gemini";
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
    // Claude/Gemini quotas are independent; keep rotation state per group.
    this.currentAccountIndexByGroup = { claude: 0, gemini: 0 };
    this.logger = options.logger || null;
    // Ensure v1internal requests are spaced >= 1 * 1000ms.
    this.apiLimiter = options.rateLimiter || new RateLimiter(1 * 1000);
    this.lastLoadCodeAssistBody = null;

    this.tokenRefresher = new TokenRefresher({
      logger: this.logger,
      refreshFn: this.refreshToken.bind(this),
    });
  }

  setLogger(logger) {
    this.logger = logger;
    if (this.tokenRefresher) {
      this.tokenRefresher.logger = logger;
    }
  }

  log(title, data) {
    if (this.logger) {
      // 支持新的日志 API
      if (typeof this.logger === "function") {
        return this.logger(title, data);
      }
      if (typeof this.logger.log === "function") {
        return this.logger.log(title, data);
      }
    }
    if (data !== undefined && data !== null) {
      console.log(`[${title}]`, typeof data === "string" ? data : JSON.stringify(data, null, 2));
    } else {
      console.log(`[${title}]`);
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
        this.log("warn", "⚠️ 未找到任何账户");
        return;
      }

      this.log("success", `✅ 已加载 ${this.accounts.length} 个账户`);

      for (const account of this.accounts) {
        this.tokenRefresher.scheduleRefresh(account);
      }
    } catch (err) {
      this.log("error", `Error loading accounts: ${err.message || err}`);
    }
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
    await this.waitForApiSlot();
    const { projectId, rawBody } = await httpClient.fetchProjectId(accessToken, this.apiLimiter);
    this.lastLoadCodeAssistBody = rawBody;
    return projectId;
  }

  async ensureProjectId(account) {
    if (account.creds.projectId) {
      return account.creds.projectId;
    }

    if (account.projectPromise) {
      return account.projectPromise;
    }

    account.projectPromise = (async () => {
      let projectId = account.creds.projectId;

      if (!projectId) {
        projectId = await this.fetchProjectId(account.creds.access_token);
      }

      if (!projectId) {
        const lastRaw = this.lastLoadCodeAssistBody;
        const hasPaidTier = lastRaw && lastRaw.includes('"paidTier"');
        if (hasPaidTier) {
          projectId = generateProjectId();
          this.log("warn", `loadCodeAssist 无 projectId，但检测到 paidTier，使用随机 projectId: ${projectId}`);
        }
      }

      if (!projectId) {
        throw new Error("Account is not eligible (projectId missing)");
      }

      account.creds.projectId = projectId;
      await storage.set(account.keyName, account.creds);
      this.log("info", `✅ 获取 projectId 成功: ${projectId}`);
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
      this.log("info", `Refreshing token for [${quotaGroup}] account ${accountIndex + 1} (${accountName})...`);
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
      this.log("info", `Refreshing token for [${logGroup}] account ${accountIndex + 1} (${accountName})...`);
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
      this.log("info", `Refreshing token for [${logGroup}] account ${accountIndex + 1} (${accountName})...`);
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
    const accessToken = await this.getCurrentAccessToken();
    await this.waitForApiSlot();
    return httpClient.fetchAvailableModels(accessToken, this.apiLimiter);
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

    // Fetch projectId：先尝试 API 获取；如果没有，且检测到 paidTier 则随机生成
    let projectId = await this.fetchProjectId(formattedData.access_token);
    if (!projectId) {
      const hasPaidTier = this.lastLoadCodeAssistBody && this.lastLoadCodeAssistBody.includes('"paidTier"');
      if (hasPaidTier) {
        projectId = generateProjectId();
        this.log("warn", `loadCodeAssist 无 projectId，但检测到 paidTier，使用随机 projectId: ${projectId}`);
      }
    }
    if (!projectId) {
      throw new Error("Failed to obtain projectId, account is not eligible");
    }
    formattedData.projectId = projectId;
    this.log("info", `✅ 项目ID获取成功: ${projectId}`);

    const email = formattedData.email;

    // Check for duplicates
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
          this.log("info", `Found existing account for ${email}, updating...`);
          break;
        }
      }
    }

    // Determine key name
    let oldKeyNameToDelete = null;
    if (existingAccountIndex !== -1) {
      targetKeyName = this.accounts[existingAccountIndex].keyName;

      // Migrate to email-based key name if possible
      if (email) {
        const safeEmail = email.replace(/[^a-zA-Z0-9@.]/g, "_");
        const newKeyName = `${safeEmail}.json`;

        if (targetKeyName !== newKeyName) {
          oldKeyNameToDelete = targetKeyName;
          targetKeyName = newKeyName;
          this.accounts[existingAccountIndex].keyName = newKeyName;
          this.log("info", `Renamed credentials to ${newKeyName}`);
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
        this.log("warn", `Failed to delete old key "${oldKeyNameToDelete}": ${e.message || e}`);
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

    // Adding/updating an account should not implicitly change current selection.
    // (If this is the first account, default to index 0.)
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

    this.log("info", "✅ OAuth authentication successful! Credentials saved.");
    this.log("info", "ℹ️  To add more accounts, run: npm run add (or: node src/server.js --add)");
    this.log("info", "🚀 You can now use the API.");
  }

  async refreshToken(account) {
    if (account.refreshPromise) {
      return account.refreshPromise;
    }

    account.refreshPromise = (async () => {
      try {
        const refresh_token = account.creds.refresh_token;
        await this.waitForApiSlot();
        const data = await httpClient.refreshToken(refresh_token, this.apiLimiter);

        // 保持 email 字段 (如果有)
        if (account.creds.email) {
          data.email = account.creds.email;
        }

        // 补全 projectId（刷新可能首次需要）
        if (account.creds.projectId) {
          data.projectId = account.creds.projectId;
        } else {
          const projectId = await this.fetchProjectId(data.access_token);
          if (!projectId) {
            const hasPaidTier =
              this.lastLoadCodeAssistBody && this.lastLoadCodeAssistBody.includes('"paidTier"');
            if (hasPaidTier) {
              data.projectId = generateProjectId();
              this.log(
                "warn",
                `⚠️ 刷新时 loadCodeAssist 无 projectId，但检测到 paidTier，使用随机 projectId: ${data.projectId}`
              );
            } else {
              throw new Error("Failed to obtain projectId during refresh");
            }
          } else {
            data.projectId = projectId;
            this.log("info", `✅ 刷新时获取 projectId 成功: ${projectId}`);
          }
        }

        account.creds = data;
        await storage.set(account.keyName, data);
        this.log("info", `✅ Token refreshed for ${account.keyName}`);

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
