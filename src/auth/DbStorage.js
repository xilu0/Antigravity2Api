const { Pool } = require("pg");

class DbStorage {
  constructor() {
    this.pool = null;
    this.initPromise = null;
  }

  async init() {
    if (this.pool) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        throw new Error("DATABASE_URL environment variable is required");
      }

      const pool = new Pool({ connectionString });

      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS app_storage (
            key_name TEXT PRIMARY KEY,
            data_content TEXT NOT NULL
          )
        `);
      } catch (err) {
        await pool.end().catch(() => {});
        throw err;
      }

      this.pool = pool;
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
    return k;
  }

  async get(key) {
    const k = this._validateKey(key);
    await this.init();
    const result = await this.pool.query(
      "SELECT data_content FROM app_storage WHERE key_name = $1",
      [k]
    );
    if (result.rows.length === 0) return null;
    return JSON.parse(result.rows[0].data_content);
  }

  async set(key, data) {
    const k = this._validateKey(key);
    if (data === undefined) {
      throw new Error(`Refusing to store undefined for key "${k}"`);
    }
    await this.init();
    const content = JSON.stringify(data, null, 2);
    await this.pool.query(
      `INSERT INTO app_storage (key_name, data_content)
       VALUES ($1, $2)
       ON CONFLICT (key_name) DO UPDATE SET data_content = EXCLUDED.data_content`,
      [k, content]
    );
  }

  async delete(key) {
    const k = this._validateKey(key);
    await this.init();
    const result = await this.pool.query(
      "DELETE FROM app_storage WHERE key_name = $1",
      [k]
    );
    return result.rowCount > 0;
  }

  async list() {
    await this.init();
    const result = await this.pool.query(
      "SELECT key_name, data_content FROM app_storage ORDER BY key_name"
    );
    return result.rows.map((row) => {
      let data = null;
      try {
        data = JSON.parse(row.data_content);
      } catch (_) {}
      return { key: row.key_name, data };
    });
  }

  async close() {
    if (this.initPromise) {
      await this.initPromise.catch(() => {});
    }
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

module.exports = new DbStorage();
