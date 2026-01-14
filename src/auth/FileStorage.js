const fs = require("fs/promises");
const path = require("path");

class FileStorage {
  constructor() {
    this.authDir = path.join(process.cwd(), "auth");
    this.initPromise = null;
  }

  async init() {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        await fs.access(this.authDir);
      } catch {
        await fs.mkdir(this.authDir, { recursive: true });
      }
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  _validateKey(key) {
    const k = String(key ?? "").trim();
    if (!k) throw new Error("storage key is required");
    if (k.includes("/") || k.includes("\\") || k.includes("..")) {
      throw new Error("invalid key name");
    }
    return k;
  }

  async get(key) {
    const k = this._validateKey(key);
    await this.init();
    const filePath = path.join(this.authDir, k);
    try {
      const content = await fs.readFile(filePath, "utf8");
      return JSON.parse(content);
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  async set(key, data) {
    const k = this._validateKey(key);
    if (data === undefined) {
      throw new Error(`Refusing to store undefined for key "${k}"`);
    }
    await this.init();
    const filePath = path.join(this.authDir, k);
    const content = JSON.stringify(data, null, 2);
    await fs.writeFile(filePath, content, "utf8");
  }

  async delete(key) {
    const k = this._validateKey(key);
    await this.init();
    const filePath = path.join(this.authDir, k);
    try {
      await fs.unlink(filePath);
      return true;
    } catch (err) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  }

  async list() {
    await this.init();
    const files = await fs.readdir(this.authDir);
    const results = [];
    for (const file of files) {
      if (!file.endsWith(".json") || file.startsWith("package") || file === "tsconfig.json") {
        continue;
      }
      const filePath = path.join(this.authDir, file);
      try {
        const content = await fs.readFile(filePath, "utf8");
        const data = JSON.parse(content);
        results.push({ key: file, data });
      } catch (_) {}
    }
    return results.sort((a, b) => a.key.localeCompare(b.key));
  }

  async close() {}
}

module.exports = new FileStorage();
