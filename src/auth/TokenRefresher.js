const path = require("path");

class TokenRefresher {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.refreshFn = typeof options.refreshFn === "function" ? options.refreshFn : null;

    this._knownAccounts = new Set();
    this._batchPromise = null;
  }

  log(title, data) {
    if (this.logger) {
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

  logAccount(action, options = {}) {
    if (this.logger && typeof this.logger.logAccount === "function") {
      return this.logger.logAccount(action, options);
    }
    this.log("account", { action, ...options });
  }

  async refresh(account) {
    if (!this.refreshFn) {
      throw new Error("TokenRefresher.refreshFn not configured");
    }
    return this.refreshFn(account);
  }

  getTargetRefreshTimeMs(account) {
    const expiry = account?.creds?.expiry_date;
    if (!Number.isFinite(expiry)) return null;
    // Refresh 10 minutes early
    return expiry - 10 * 60 * 1000;
  }

  async refreshDueAccountsNow() {
    return this._refreshDueAccounts();
  }

  async _refreshDueAccounts() {
    if (this._batchPromise) return this._batchPromise;

    this._batchPromise = (async () => {
      const now = Date.now();
      const due = [];
      for (const account of this._knownAccounts) {
        const targetTime = this.getTargetRefreshTimeMs(account);
        if (targetTime == null) continue;
        if (targetTime <= now) due.push(account);
      }

      if (due.length === 0) return { ok: 0, fail: 0, total: 0 };

      const results = await Promise.allSettled(
        due.map(async (account) => {
          const accountName =
            account?.keyName || (account?.filePath ? path.basename(account.filePath) : "unknown-account");
          try {
            await this.refresh(account);
            return { ok: true, accountName };
          } catch (e) {
            return { ok: false, accountName, error: e };
          }
        }),
      );

      let ok = 0;
      let fail = 0;

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const value = r.status === "fulfilled" ? r.value : { ok: false, accountName: "unknown", error: r.reason };

        if (value.ok) {
          ok++;
          continue;
        }

        fail++;
        const msg = String(value.error?.message || value.error || "unknown error").split("\n")[0].slice(0, 200);
        this.log("account", `Token refresh failed @${value.accountName}${msg ? ` (${msg})` : ""}`);

        const account = due[i];
        if (account && account.refreshTimer) {
          clearTimeout(account.refreshTimer);
          account.refreshTimer = null;
        }
        if (account) {
          account.refreshTimer = setTimeout(() => {
            account.refreshTimer = null;
            this.scheduleRefresh(account);
          }, 60 * 1000);
          if (account.refreshTimer && typeof account.refreshTimer.unref === "function") {
            account.refreshTimer.unref();
          }
        }
      }

      this.log("account", `Token refresh done ok=${ok} fail=${fail}`);
      return { ok, fail, total: due.length };
    })().finally(() => {
      this._batchPromise = null;
    });

    return this._batchPromise;
  }

  scheduleRefresh(account) {
    if (!account) return;
    this._knownAccounts.add(account);
    if (account.refreshTimer) {
      clearTimeout(account.refreshTimer);
      account.refreshTimer = null;
    }

    const now = Date.now();
    const targetTime = this.getTargetRefreshTimeMs(account);
    if (targetTime == null) return;
    let delay = targetTime - now;
    if (delay < 0) delay = 0;

    account.refreshTimer = setTimeout(() => {
      account.refreshTimer = null;
      this._refreshDueAccounts().catch(() => {});
    }, delay);
    if (account.refreshTimer && typeof account.refreshTimer.unref === "function") {
      account.refreshTimer.unref();
    }
  }

  cancelRefresh(account) {
    if (!account) return;
    this._knownAccounts.delete(account);
    if (account.refreshTimer) {
      clearTimeout(account.refreshTimer);
      account.refreshTimer = null;
    }
  }
}

module.exports = TokenRefresher;
