const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const BASE_DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..');
const ACCOUNTS_DIR = path.join(BASE_DATA_DIR, 'accounts');
const USERS_DIR = path.join(ACCOUNTS_DIR, 'users');

function ensureAccountsDir() {
  try {
    if (!fs.existsSync(ACCOUNTS_DIR)) fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
    if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });
  } catch (e) {
    console.error('[Accounts] Failed to create directories:', e.message);
  }
}
ensureAccountsDir();

function getMasterKey() {
  ensureAccountsDir();
  const keyPath = path.join(ACCOUNTS_DIR, '.key');
  try {
    if (fs.existsSync(keyPath)) {
      const hex = fs.readFileSync(keyPath, 'utf8').trim();
      if (hex.length === 64) return Buffer.from(hex, 'hex');
    }
  } catch (e) {}
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 });
  } catch (e) {
    console.error('[Accounts] Failed to write key file:', e.message);
  }
  return key;
}

const MASTER_KEY = getMasterKey();

function encryptData(text, key = MASTER_KEY) {
  if (text === null || text === undefined) return '';
  const str = typeof text !== 'string' ? JSON.stringify(text) : text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(str, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return JSON.stringify({ iv: iv.toString('hex'), authTag, content: encrypted });
}

function decryptData(encryptedObjOrStr, key = MASTER_KEY) {
  if (!encryptedObjOrStr) return '';
  try {
    let obj = typeof encryptedObjOrStr === 'string' ? JSON.parse(encryptedObjOrStr) : encryptedObjOrStr;
    if (!obj || !obj.iv || !obj.authTag || !obj.content) return encryptedObjOrStr;
    const iv = Buffer.from(obj.iv, 'hex');
    const authTag = Buffer.from(obj.authTag, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(obj.content, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    return encryptedObjOrStr;
  }
}

function saveEncryptedUserFile(userId, login) {
  try {
    ensureAccountsDir();
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!userRow) return;
    const syncRows = db.prepare('SELECT kind, payload, updated_at FROM sync_data WHERE user_id = ?').all(userId);
    const blocks = {};
    for (const r of syncRows) {
      const dec = decryptData(r.payload);
      blocks[r.kind] = { payload: dec, updatedAt: r.updated_at };
    }
    const userData = {
      id: userRow.id,
      login: userRow.login,
      password_hash: userRow.password_hash,
      created_at: userRow.created_at,
      updated_at: userRow.updated_at,
      blocks
    };
    const encryptedContent = encryptData(userData);
    const filePath = path.join(USERS_DIR, `user_${userId}.json.enc`);
    fs.writeFileSync(filePath, encryptedContent, 'utf8');
  } catch (e) {
    console.error('[Accounts] Failed to write encrypted user file:', e.message);
  }
}

function deleteEncryptedUserFile(userId) {
  try {
    const filePath = path.join(USERS_DIR, `user_${userId}.json.enc`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (e) {
    console.error('[Accounts] Failed to delete encrypted user file:', e.message);
  }
}

ensureAccountsDir();
const DB_PATH = path.join(ACCOUNTS_DIR, 'accounts.db');
let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
} catch (err) {
  console.error('[Database Error] Failed to open accounts.db:', err.message);
  throw err;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_data (
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS api_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    login TEXT NOT NULL,
    exp INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(exp);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

// Migration from old app.db if present
(function migrateOldDatabase() {
  try {
    const oldPaths = [
      path.join(__dirname, '..', 'app.db'),
      path.join(__dirname, 'app.db')
    ];
    for (const oldPath of oldPaths) {
      if (fs.existsSync(oldPath) && path.resolve(oldPath) !== path.resolve(DB_PATH)) {
        try {
          const oldDb = new Database(oldPath);
          const oldUsers = oldDb.prepare('SELECT * FROM users').all();
          for (const u of oldUsers) {
            const existing = db.prepare('SELECT id FROM users WHERE login = ?').get(u.login);
            if (!existing) {
              const info = db.prepare('INSERT INTO users (id, login, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
                .run(u.id, u.login, u.password_hash, u.created_at, u.updated_at);
              const newId = info.lastInsertRowid;
              const oldBlocks = oldDb.prepare('SELECT * FROM sync_data WHERE user_id = ?').all(u.id);
              for (const b of oldBlocks) {
                const encPayload = encryptData(b.payload);
                db.prepare('INSERT OR REPLACE INTO sync_data (user_id, kind, payload, updated_at) VALUES (?, ?, ?, ?)')
                  .run(newId, b.kind, encPayload, b.updated_at);
              }
              saveEncryptedUserFile(newId, u.login);
            }
          }
          oldDb.close();
        } catch (e) {
          console.warn('[Accounts Migration] Error migrating from', oldPath, e.message);
        }
      }
    }
  } catch (e) {}
})();

const SESSION_TTL = 1000 * 60 * 60 * 24 * 120; // 120 дней

function normalizeLogin(login) {
  return String(login || '').trim().toLowerCase();
}

// Сессии в БД (переживают рестарт). Старые сессии из Map до рестарта
// станут невалидными один раз — пользователям нужно будет войти заново.
function createSession(userId, login) {
  const token = crypto.randomBytes(32).toString('hex');
  const exp = Date.now() + SESSION_TTL;
  try {
    db.prepare('INSERT INTO sessions (token, user_id, login, exp) VALUES (?, ?, ?, ?)')
      .run(token, userId, login, exp);
  } catch (e) {
    console.error('[Sessions] createSession error:', e.message);
  }
  return token;
}

function getSession(token) {
  if (!token || typeof token !== 'string' || token.length > 256) return null;
  try {
    const row = db.prepare('SELECT user_id AS userId, login, exp FROM sessions WHERE token = ?').get(token);
    if (!row) return null;
    const now = Date.now();
    if (row.exp < now) {
      try { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); } catch (e) {}
      return null;
    }
    // Sliding expiration: пока человек активен — сессия продлевается,
    // чтобы не выкидывало ровно через 30 дней от логина. Пишем в БД
    // только когда осталось меньше половины срока, чтобы не долбить диск.
    if (row.exp - now < SESSION_TTL / 2) {
      const newExp = now + SESSION_TTL;
      try { db.prepare('UPDATE sessions SET exp = ? WHERE token = ?').run(newExp, token); } catch (e) {}
      row.exp = newExp;
    }
    return row;
  } catch (e) {
    return null;
  }
}

function destroySession(token) {
  if (!token || typeof token !== 'string') return;
  try { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); } catch (e) {}
}

// Периодическая чистка протухших сессий, чтобы таблица не росла бесконечно.
try {
  const _cleanSessions = () => {
    try { db.prepare('DELETE FROM sessions WHERE exp < ?').run(Date.now()); } catch (e) {}
  };
  _cleanSessions();
  setInterval(_cleanSessions, 60 * 60 * 1000).unref();
} catch (e) {}

function findUserByLogin(login) {
  const row = db.prepare('SELECT * FROM users WHERE login = ?').get(normalizeLogin(login));
  return row || null;
}

function isLoginTaken(login) {
  return !!findUserByLogin(login);
}

async function registerUser(login, password) {
  const norm = normalizeLogin(login);
  if (norm.length < 3 || norm.length > 30) {
    throw new Error('Логин должен содержать от 3 до 30 символов');
  }
  if (!/^[a-zA-Z0-9_\-\.]+$/i.test(norm)) {
    throw new Error('Логин может содержать только буквы, цифры, дефисы и подчёркивания');
  }
  const passStr = String(password || '');
  if (passStr.length < 6) {
    throw new Error('Пароль слишком короткий (минимум 6 символов)');
  }
  if (passStr.length > 128) {
    throw new Error('Пароль слишком длинный (максимум 128 символов)');
  }
  if (findUserByLogin(norm)) {
    throw new Error('Такой логин уже занят');
  }
  const hash = await bcrypt.hash(passStr, 10);
  const now = Date.now();
  const info = db.prepare('INSERT INTO users (login, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(norm, hash, now, now);
  const userId = info.lastInsertRowid;
  saveEncryptedUserFile(userId, norm);
  return { id: userId, login: norm };
}

async function verifyUser(login, password) {
  const user = findUserByLogin(login);
  if (!user) return null;
  const match = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!match) return null;
  return { id: user.id, login: user.login };
}

function deleteUser(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  db.prepare('DELETE FROM sync_data WHERE user_id = ?').run(userId);
  deleteEncryptedUserFile(userId);
}

function getBlocks(userId) {
  const rows = db.prepare('SELECT kind, payload, updated_at FROM sync_data WHERE user_id = ?').all(userId);
  const out = {};
  for (const r of rows) {
    const dec = decryptData(r.payload);
    out[r.kind] = { payload: dec, updatedAt: r.updated_at };
  }
  return out;
}

function applyBlocks(userId, blocks) {
  const now = Date.now();
  const stmt = db.prepare('INSERT INTO sync_data (user_id, kind, payload, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at WHERE excluded.updated_at > sync_data.updated_at');
  const insertMany = db.transaction((items) => {
    for (const b of items) {
      const updatedAt = Number(b.updatedAt) || now;
      const encPayload = encryptData(b.payload);
      stmt.run(userId, b.kind, encPayload, updatedAt);
    }
  });
  insertMany(blocks);
  const userRow = db.prepare('SELECT login FROM users WHERE id = ?').get(userId);
  if (userRow) saveEncryptedUserFile(userId, userRow.login);
  return getBlocks(userId);
}

function getCache(key) {
  try {
    const row = db.prepare('SELECT value, updated_at FROM api_cache WHERE key = ?').get(key);
    if (!row) return null;
    return { value: JSON.parse(row.value), updatedAt: row.updated_at };
  } catch (e) {
    console.error('[DB Cache] getCache error:', e);
    return null;
  }
}

function setCache(key, value) {
  try {
    const now = Date.now();
    db.prepare('INSERT OR REPLACE INTO api_cache (key, value, updated_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(value), now);
  } catch (e) {
    console.error('[DB Cache] setCache error:', e);
  }
}

function clearCache() {
  try {
    db.prepare('DELETE FROM api_cache').run();
  } catch (e) {
    console.error('[DB Cache] clearCache error:', e);
  }
}

// ===== Ограничение попыток авторизации и пауза в 1 минуту =====
const AUTH_RATE_LIMIT = 5;
const AUTH_LOCKOUT_MS = 60 * 1000;
const authAttempts = new Map();

function getAuthRateLimitState(ip) {
  const now = Date.now();
  const rec = authAttempts.get(ip);
  if (!rec) return { count: 0, locked: false, retryAfter: 0 };
  if (rec.lockUntil && rec.lockUntil > now) {
    const retryAfter = Math.ceil((rec.lockUntil - now) / 1000);
    return { count: rec.count, locked: true, retryAfter };
  }
  if (rec.lockUntil && rec.lockUntil <= now) {
    authAttempts.delete(ip);
    return { count: 0, locked: false, retryAfter: 0 };
  }
  return { count: rec.count, locked: false, retryAfter: 0 };
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  let rec = authAttempts.get(ip);
  if (!rec || (rec.lockUntil && rec.lockUntil <= now)) {
    rec = { count: 1, lockUntil: 0 };
  } else {
    rec.count += 1;
  }
  if (rec.count >= AUTH_RATE_LIMIT) {
    rec.lockUntil = now + AUTH_LOCKOUT_MS;
  }
  authAttempts.set(ip, rec);
  return getAuthRateLimitState(ip);
}

function resetFailedAttempts(ip) {
  authAttempts.delete(ip);
}

function guardAuth(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const state = getAuthRateLimitState(ip);
  if (state.locked) {
    res.setHeader('Retry-After', state.retryAfter);
    res.status(429).json({ error: `Слишком много попыток. Пауза ${state.retryAfter} сек.` });
    return;
  }
  next();
}

module.exports = {
  db,
  ACCOUNTS_DIR,
  encryptData,
  decryptData,
  normalizeLogin,
  createSession,
  getSession,
  destroySession,
  registerUser,
  isLoginTaken,
  verifyUser,
  deleteUser,
  getBlocks,
  applyBlocks,
  getCache,
  setCache,
  clearCache,
  getAuthRateLimitState,
  recordFailedAttempt,
  resetFailedAttempts,
  guardAuth
};
