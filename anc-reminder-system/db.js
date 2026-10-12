const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'anc.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Ordered migrations. PRAGMA user_version records how many have been applied,
// so each runs exactly once — including on a database created by an older build.
const MIGRATIONS = ['schema.sql', '002_reminder_flow.sql'];

const applied = db.pragma('user_version', { simple: true });
for (let i = applied; i < MIGRATIONS.length; i++) {
  const sql = fs.readFileSync(path.join(__dirname, 'migrations', MIGRATIONS[i]), 'utf8');
  db.transaction(() => {
    db.exec(sql);
    db.pragma(`user_version = ${i + 1}`);
  })();
}

module.exports = db;
