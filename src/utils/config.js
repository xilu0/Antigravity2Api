const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIG = {
  server: { host: "0.0.0.0", port: 3000 },
  api_keys: [],
  proxy: { enabled: false, url: "" },
  log: { retention_days: 3 },
  // Debug switch: only affects request/response payload logs.
  debug: false,
  // Debug raw response: save raw Gemini responses to JSON files in log/ directory.
  debug_raw_response: false,
};

let cachedConfig = null;

function loadDotEnv() {
  const envFile = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envFile)) return;

  let content = "";
  try {
    content = fs.readFileSync(envFile, "utf8");
  } catch (e) {
    return;
  }

  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const exportPrefix = "export ";
    const withoutExport = trimmed.startsWith(exportPrefix) ? trimmed.slice(exportPrefix.length) : trimmed;

    const eqIndex = withoutExport.indexOf("=");
    if (eqIndex <= 0) continue;

    const key = withoutExport.slice(0, eqIndex).trim();
    let value = withoutExport.slice(eqIndex + 1);
    if (!key) continue;

    // Only set if not already present (env > .env)
    if (process.env[key] !== undefined) continue;

    value = String(value || "").trim();

    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1);
      // Minimal escape handling for double-quoted values
      if (first === '"') {
        value = value
          .replaceAll("\\n", "\n")
          .replaceAll("\\r", "\r")
          .replaceAll("\\t", "\t")
          .replaceAll('\\"', '"')
          .replaceAll("\\\\", "\\");
      }
    }

    process.env[key] = value;
  }
}

function parseBool(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return null;
}

function parsePort(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return null;
  return n;
}

function parseNonNegativeInt(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function parseApiKeys(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;

  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((k) => String(k || "").trim()).filter(Boolean);
      }
    } catch (e) {}
  }

  return raw
    .split(",")
    .map((k) => String(k || "").trim())
    .filter(Boolean);
}

function normalizeDebug(rawDebug) {
  if (typeof rawDebug === "boolean") return rawDebug;
  if (rawDebug && typeof rawDebug === "object") {
    if (typeof rawDebug.enabled === "boolean") return rawDebug.enabled;
    if (typeof rawDebug.requestResponse === "boolean") return rawDebug.requestResponse;
    if (typeof rawDebug.request_response === "boolean") return rawDebug.request_response;
  }
  return DEFAULT_CONFIG.debug;
}

function normalizeConfig(raw) {
  const serverRaw = raw && typeof raw.server === "object" ? raw.server : {};
  const proxyRaw = raw && typeof raw.proxy === "object" ? raw.proxy : {};
  const logRaw = raw && typeof raw.log === "object" ? raw.log : {};

  return {
    ...DEFAULT_CONFIG,
    ...(raw && typeof raw === "object" ? raw : {}),
    server: { ...DEFAULT_CONFIG.server, ...serverRaw },
    proxy: { ...DEFAULT_CONFIG.proxy, ...proxyRaw },
    log: { ...DEFAULT_CONFIG.log, ...logRaw },
    api_keys: Array.isArray(raw?.api_keys) ? raw.api_keys : DEFAULT_CONFIG.api_keys,
    debug: normalizeDebug(raw?.debug),
  };
}

function applyEnvOverrides(config) {
  const out = {
    ...config,
    server: { ...config.server },
    proxy: { ...config.proxy },
    log: { ...config.log },
  };

  if (process.env.AG2API_HOST && String(process.env.AG2API_HOST).trim()) {
    out.server.host = String(process.env.AG2API_HOST).trim();
  }

  const port = parsePort(process.env.AG2API_PORT);
  if (port != null) {
    out.server.port = port;
  }

  if (process.env.AG2API_API_KEYS != null) {
    const keys = parseApiKeys(process.env.AG2API_API_KEYS);
    if (keys != null) {
      out.api_keys = keys;
    }
  }

  const proxyEnabled = parseBool(process.env.AG2API_PROXY_ENABLED);
  if (proxyEnabled != null) {
    out.proxy.enabled = proxyEnabled;
  }

  if (process.env.AG2API_PROXY_URL && String(process.env.AG2API_PROXY_URL).trim()) {
    out.proxy.url = String(process.env.AG2API_PROXY_URL).trim();
  }

  const debug = parseBool(process.env.AG2API_DEBUG);
  if (debug != null) {
    out.debug = debug;
  }

  const logRetentionDays = parseNonNegativeInt(process.env.AG2API_LOG_RETENTION_DAYS);
  if (logRetentionDays != null) {
    out.log.retention_days = logRetentionDays;
  }

  const debugRawResponse = parseBool(process.env.AG2API_DEBUG_RAW_RESPONSE);
  if (debugRawResponse != null) {
    out.debug_raw_response = debugRawResponse;
  }

  return out;
}

function loadConfig() {
  loadDotEnv();
  const normalized = normalizeConfig(null);
  return applyEnvOverrides(normalized);
}

function getConfig() {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

module.exports = {
  DEFAULT_CONFIG,
  getConfig,
  loadConfig,
};
