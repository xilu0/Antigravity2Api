function getAccountsPayload(authManager) {
  const accounts = authManager.getAccountsSummary();
  return {
    count: accounts.length,
    current: {
      claude: authManager.getCurrentAccountIndex("claude"),
      gemini: authManager.getCurrentAccountIndex("gemini"),
    },
    accounts,
  };
}

async function deleteAccount(authManager, fileName) {
  const ok = await authManager.deleteAccountByFile(fileName);
  return ok;
}

async function reloadAccounts(authManager) {
  const accounts = await authManager.reloadAccounts();
  return {
    count: accounts.length,
    current: {
      claude: authManager.getCurrentAccountIndex("claude"),
      gemini: authManager.getCurrentAccountIndex("gemini"),
    },
    accounts,
  };
}

function formatLocalDateTime(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "-";
  const yyyy = date.getFullYear();
  const MM = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const HH = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`;
}

function formatRemainingFractionAsPercent(remainingFraction) {
  if (typeof remainingFraction !== "number" || !Number.isFinite(remainingFraction)) return "-";
  const percent = remainingFraction * 100;
  const text = percent.toFixed(2).replace(/\.?0+$/, "");
  return `${text}%`;
}

async function getAccountQuota(authManager, fileName, upstreamClient) {
  const safeName = String(fileName || "").trim();
  const account = authManager.accounts.find((acc) => acc.keyName === safeName);

  if (!account) {
    throw new Error("Account not found");
  }

  const accountIndex = authManager.accounts.indexOf(account);
  const models = await upstreamClient.fetchAvailableModelsByAccountIndex(accountIndex);

  const result = [];
  if (models && typeof models === "object") {
    for (const modelId in models) {
      if (modelId.includes("gemini") || modelId.includes("claude")) {
        const m = models[modelId];
        const quota = m.quotaInfo || {};
        const limit = formatRemainingFractionAsPercent(quota.remainingFraction);
        let resetTimeMs = null;
        let reset = "-";
        if (quota.resetTime) {
          const d = new Date(quota.resetTime);
          if (Number.isFinite(d.getTime())) {
            resetTimeMs = d.getTime();
            reset = formatLocalDateTime(d);
          }
        }

        result.push({
          model: modelId,
          limit,
          reset,
          resetTimeMs,
        });
      }
    }
  }

  result.sort((a, b) => a.model.localeCompare(b.model));
  return result;
}

module.exports = {
  getAccountsPayload,
  deleteAccount,
  reloadAccounts,
  getAccountQuota,
};
