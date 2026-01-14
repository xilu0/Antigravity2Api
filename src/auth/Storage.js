// Storage abstraction layer
// Uses PostgreSQL if DATABASE_URL is set, otherwise uses file system

let storage;

if (process.env.DATABASE_URL) {
  storage = require("./DbStorage");
} else {
  storage = require("./FileStorage");
}

module.exports = storage;
