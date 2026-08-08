const express = require('express');
const path = require('path');
const fs = require('fs');
const iconv = require('iconv-lite');
const cheerio = require('cheerio');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'app.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

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
`);

const SESSIONS = new Map();
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30;

function normalizeLogin(login) {
  return String(login || '').trim().toLowerCase();
}

function createSession(userId, login) {
  const token = crypto.randomBytes(32).toString('hex');
  SESSIONS.set(token, { userId, login, exp: Date.now() + SESSION_TTL });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = SESSIONS.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) {
    SESSIONS.delete(token);
    return null;
  }
  return s;
}

function destroySession(token) {
  if (token) SESSIONS.delete(token);
}

function findUserByLogin(login) {
  const row = db.prepare('SELECT * FROM users WHERE login = ?').get(normalizeLogin(login));
  return row || null;
}

function registerUser(login, password) {
  const norm = normalizeLogin(login);
  if (norm.length < 3) throw new Error('Логин слишком короткий (минимум 3 символа)');
  if (String(password || '').length < 4) throw new Error('Пароль слишком короткий (минимум 4 символа)');
  if (findUserByLogin(norm)) throw new Error('Такой логин уже занят');
  const hash = bcrypt.hashSync(password, 10);
  const now = Date.now();
  const info = db.prepare('INSERT INTO users (login, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(norm, hash, now, now);
  return { id: info.lastInsertRowid, login: norm };
}

function verifyUser(login, password) {
  const user = findUserByLogin(login);
  if (!user) return null;
  if (!bcrypt.compareSync(String(password || ''), user.password_hash)) return null;
  return { id: user.id, login: user.login };
}

function deleteUser(userId) {
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  db.prepare('DELETE FROM sync_data WHERE user_id = ?').run(userId);
  for (const [token, s] of SESSIONS) {
    if (s.userId === userId) SESSIONS.delete(token);
  }
}

function getBlocks(userId) {
  const rows = db.prepare('SELECT kind, payload, updated_at FROM sync_data WHERE user_id = ?').all(userId);
  const out = {};
  for (const r of rows) {
    out[r.kind] = { payload: r.payload, updatedAt: r.updated_at };
  }
  return out;
}

function applyBlocks(userId, blocks) {
  const now = Date.now();
  const stmt = db.prepare('INSERT INTO sync_data (user_id, kind, payload, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, kind) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at WHERE excluded.updated_at > sync_data.updated_at');
  const insertMany = db.transaction((items) => {
    for (const b of items) {
      const updatedAt = Number(b.updatedAt) || now;
      stmt.run(userId, b.kind, b.payload, updatedAt);
    }
  });
  insertMany(blocks);
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

const auth = {
  db,
  normalizeLogin,
  createSession,
  getSession,
  destroySession,
  registerUser,
  verifyUser,
  deleteUser,
  getBlocks,
  applyBlocks,
  getCache,
  setCache,
  clearCache
};

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Минимальный парсер cookies (без внешних зависимостей)
app.use((req, res, next) => {
  const raw = req.headers.cookie || '';
  const cookies = {};
  raw.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) cookies[k] = decodeURIComponent(v);
  });
  req.cookies = cookies;
  res.cookie = (name, value, opts = {}) => {
    let str = `${name}=${encodeURIComponent(value)}`;
    if (opts.maxAge) str += `; Max-Age=${Math.floor(opts.maxAge / 1000)}`;
    str += '; Path=' + (opts.path || '/');
    if (opts.httpOnly) str += '; HttpOnly';
    if (opts.sameSite) str += `; SameSite=${opts.sameSite}`;
    res.setHeader('Set-Cookie', str);
  };
  res.clearCookie = (name, opts = {}) => {
    res.setHeader('Set-Cookie', `${name}=; Path=${opts.path || '/'}; Max-Age=0; HttpOnly`);
  };
  next();
});

// ----- Аккаунты и синхронизация -----
const COOKIE_NAME = 'bseu_session';
function getToken(req) {
  return req.cookies ? (req.cookies[COOKIE_NAME] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')) : null;
}
function sessionUser(req) {
  const token = getToken(req);
  const s = auth.getSession(token);
  return s;
}
function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30,
    path: '/'
  });
}

const AUTH_RATE_LIMIT = 5;
const AUTH_RATE_WINDOW = 60 * 1000;
const authAttempts = new Map();
function authRateLimited(ip) {
  const now = Date.now();
  const rec = authAttempts.get(ip);
  if (!rec || rec.resetAt < now) {
    authAttempts.set(ip, { count: 1, resetAt: now + AUTH_RATE_WINDOW });
    return false;
  }
  rec.count += 1;
  if (rec.count > AUTH_RATE_LIMIT) return true;
  return false;
}
function guardAuth(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (authRateLimited(ip)) {
    res.status(429).json({ error: 'Слишком много попыток. Попробуйте позже.' });
    return;
  }
  next();
}

app.post('/api/auth/register', guardAuth, (req, res) => {
  try {
    const { login, password } = req.body || {};
    const user = auth.registerUser(login, password);
    const token = auth.createSession(user.id, user.login);
    setSessionCookie(res, token);
    res.json({ ok: true, user: { login: user.login } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/login', guardAuth, (req, res) => {
  try {
    const { login, password } = req.body || {};
    const user = auth.verifyUser(login, password);
    if (!user) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const token = auth.createSession(user.id, user.login);
    setSessionCookie(res, token);
    res.json({ ok: true, user: { login: user.login } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = getToken(req);
  auth.destroySession(token);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const s = sessionUser(req);
  if (!s) return res.json({ ok: true, user: null });
  res.json({ ok: true, user: { login: s.login } });
});

app.delete('/api/auth/account', (req, res) => {
  const s = sessionUser(req);
  if (!s) return res.status(401).json({ error: 'Не авторизован' });
  auth.deleteUser(s.userId);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/sync', (req, res) => {
  const s = sessionUser(req);
  if (!s) return res.status(401).json({ error: 'Не авторизован' });
  res.json({ ok: true, blocks: auth.getBlocks(s.userId) });
});

app.post('/api/sync', (req, res) => {
  const s = sessionUser(req);
  if (!s) return res.status(401).json({ error: 'Не авторизован' });
  const blocks = Array.isArray(req.body && req.body.blocks) ? req.body.blocks : [];
  const valid = blocks.filter(b => b && typeof b.kind === 'string' && typeof b.payload === 'string');
  const merged = auth.applyBlocks(s.userId, valid);
  res.json({ ok: true, blocks: merged });
});

// ===== File-based cache layer (для расписания BSEU) =====
const CACHE_DIR = path.join(__dirname, '.cache');
const CACHE_VERSION = 'v5'; // Увеличить при изменении логики парсинга
function ensureCacheDir() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch (e) { /* ignore */ }
}
ensureCacheDir();

function cacheFilePath(key) {
  const safe = Buffer.from(key).toString('base64').replace(/[/+=]/g, '_');
  return path.join(CACHE_DIR, `${CACHE_VERSION}_${safe}.json`);
}
function fileGetCache(key) {
  try {
    const file = cacheFilePath(key);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return { value: parsed.value, updatedAt: parsed.updatedAt };
  } catch (e) {
    return null;
  }
}
function fileSetCache(key, value) {
  try {
    ensureCacheDir();
    const file = cacheFilePath(key);
    fs.writeFileSync(file, JSON.stringify({ value, updatedAt: Date.now() }), 'utf-8');
  } catch (e) { /* ignore */ }
}

// ===== Improved fetch with timeout =====
const FETCH_TIMEOUT = 15000; // 15 секунд таймаут для всех запросов

async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeout}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// Повтор запроса при транзитных сбоях BSEU (502/503/429, таймаут, сетевая
// ошибка). Без этого сборка полного расписания теряет целые факультеты/группы
// из-за случайных 502 Bad Gateway, и кэш аудиторий собирается неполным.
async function fetchWithRetry(url, options = {}, { retries = 4, baseDelay = 500, timeout = FETCH_TIMEOUT } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options, timeout);
      // 4xx (кроме 429) не являются транзитными — не повторяем, отдаём как есть.
      if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) {
        return response;
      }
      lastErr = new Error(`HTTP status ${response.status}`);
    } catch (error) {
      lastErr = error; // таймаут (AbortError) или сетевая ошибка — транзитные
    }
    if (attempt < retries) {
      const delay = baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}
function toWin1251Url(str) {
  const buf = iconv.encode(str, 'win1251');
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (byte === 0x20) out += '%20';
    else if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39)) out += String.fromCharCode(byte);
    else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

function decodeResponseBuffer(buffer, response) {
  const contentType = response.headers.get('content-type') || '';
  const charsetMatch = contentType.match(/charset=([^\s;]+)/i);
  let charset = charsetMatch ? charsetMatch[1].replace(/['"]/g, '').toLowerCase() : null;
  if (!charset) {
    const utf8Text = buffer.toString('utf-8');
    try {
      JSON.parse(utf8Text);
      charset = 'utf-8';
    } catch (e) {
      if (utf8Text.includes('') || /[\x80-\xFF]/.test(utf8Text)) charset = 'windows-1251';
      else charset = 'utf-8';
    }
  }
  return iconv.decode(buffer, charset);
}

async function fetchBseuList(action, params = {}) {
  const cacheKey = `list:${action}:${JSON.stringify(params)}`;
  const cached = fileGetCache(cacheKey);
  const now = Date.now();
  const listTTL = 24 * 60 * 60 * 1000;
  if (cached && (now - cached.updatedAt < listTTL)) return cached.value;

  const bodyParts = [`__act=${action}`];
  for (const key in params) {
    if (key === 'tname') bodyParts.push(`${key}=${toWin1251Url(params[key])}`);
    else bodyParts.push(`${key}=${params[key]}`);
  }
  const bodyString = bodyParts.join("&");

  try {
    const response = await fetchWithRetry("https://bseu.by/schedule/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=windows-1251",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      body: iconv.encode(bodyString, 'win1251')
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const decoded = decodeResponseBuffer(Buffer.from(buffer), response);
    const data = JSON.parse(decoded);
    fileSetCache(cacheKey, data);
    return data;
  } catch (error) {
    console.error(`[BSEU List] Failed for ${action}:`, error);
    if (cached) return cached.value;
    throw error;
  }
}

// BSEU отдаёт дату начала семестра (напр. "Mon Feb 8 00:00:00 UTC+0300 2026"),
// и эта дата может приходиться на субботу/воскресенье (а из-за часового пояса
// в строке ещё и "уезжает" на день назад). По факту учебная неделя 1 начинается
// со СЛЕДУЮЩЕГО понедельника после этой даты — иначе всё расписание (и фильтр
// по датам в режиме аудитории) съезжает ровно на неделю. Приводим дату начала
// семестра к понедельнику недели, её содержащей, и если он оказался раньше
// самой даты начала (воскресенье/суббота) — сдвигаем на неделю вперёд.
function normalizeSemesterStart(dateStr) {
  const m = String(dateStr).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr;
  const sy = Number(m[1]), sm = Number(m[2]) - 1, sd = Number(m[3]);
  const dow = new Date(Date.UTC(sy, sm, sd)).getUTCDay(); // 0 = воскресенье
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  let monday = new Date(Date.UTC(sy, sm, sd - daysSinceMonday));
  if (monday.getTime() < Date.UTC(sy, sm, sd)) {
    monday.setUTCDate(monday.getUTCDate() + 7);
  }
  const y = monday.getUTCFullYear();
  const mo = String(monday.getUTCMonth() + 1).padStart(2, '0');
  const d = String(monday.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

function normalizeSemesterStartDate(input) {
  const value = String(input || '').trim();
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return input;
  const [, y, mo] = m;
  if (Number(mo) === 8) return `${y}-09-01`;
  if (Number(mo) === 9) return `${y}-09-01`;
  return value;
}

function getAcademicSemesterStart(htmlDateStr) {
  const now = new Date();
  const currentMonth = now.getMonth(); // 0 = Jan, 7 = Aug, 8 = Sep...
  let parsedDate = null;
  if (htmlDateStr) {
    const d = new Date(htmlDateStr);
    if (!isNaN(d.getTime())) parsedDate = d;
  }

  const isAutumnPeriod = (currentMonth >= 7 || currentMonth === 0);

  if (parsedDate) {
    const parsedMonth = parsedDate.getMonth();
    const parsedIsAutumn = (parsedMonth >= 7 || parsedMonth === 0);
    if (parsedIsAutumn === isAutumnPeriod) {
      const candidate = normalizeSemesterStart(parsedDate.toISOString().slice(0, 10));
      // Пары не должны быть в августе — корректируем на 1 сентября
      if (candidate.includes('-08-')) {
        let year = parsedDate.getFullYear();
        if (currentMonth === 0) year -= 1;
        const sept1 = new Date(Date.UTC(year, 8, 1));
        return normalizeSemesterStartDate(normalizeSemesterStart(sept1.toISOString().slice(0, 10)));
      }
      return normalizeSemesterStartDate(candidate);
    }
  }

  let year = now.getFullYear();
  if (isAutumnPeriod) {
    if (currentMonth === 0) year -= 1;
    const sept1 = new Date(Date.UTC(year, 8, 1));
    return normalizeSemesterStartDate(normalizeSemesterStart(sept1.toISOString().slice(0, 10)));
  } else {
    const feb8 = new Date(Date.UTC(year, 1, 8));
    return normalizeSemesterStartDate(normalizeSemesterStart(feb8.toISOString().slice(0, 10)));
  }
}

function parseScheduleHtml(html) {
  const $ = cheerio.load(html);
  const table = $('table').first();
  let semesterStartDate = null;
  let currentSemesterWeek = 1;
  const semesterMatch = html.match(/<!--(?:first|second)\s+semester=(.*?)-->/i);
  if (semesterMatch) {
    semesterStartDate = getAcademicSemesterStart(semesterMatch[1].trim());
  } else {
    const weekMatch = html.match(/Текущая\s+-\s+<strong>(\d+)<\/strong>\s+учебная\s+неделя/i);
    if (weekMatch) {
      const currentWeekNum = Number(weekMatch[1]);
      currentSemesterWeek = currentWeekNum;
      const today = new Date();
      const shifted = new Date(today.getTime() + 3 * 60 * 60 * 1000);
      const day = shifted.getUTCDay();
      const diff = shifted.getUTCDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + diff));
      const sd = new Date(monday.getTime() - (currentWeekNum - 1) * 7 * 24 * 60 * 60 * 1000);
      let candidate = normalizeSemesterStart(sd.toISOString().slice(0, 10));
      // Пары не должны быть в августе — корректируем на 1 сентября
      if (candidate.includes('-08-')) {
        const year = shifted.getUTCFullYear();
        const sept1 = new Date(Date.UTC(year, 8, 1));
        candidate = normalizeSemesterStartDate(normalizeSemesterStart(sept1.toISOString().slice(0, 10)));
      }
      semesterStartDate = normalizeSemesterStartDate(candidate);
    } else {
      semesterStartDate = getAcademicSemesterStart(null);
      currentSemesterWeek = 1;
    }
  }
  if (!table.length) return { semesterStartDate, currentSemesterWeek, lessons: [] };

  const rows = table.find('tr');
  let currentDay = '';
  const lessons = [];
  const headers = [];
  table.find('thead th, thead td').each((idx, th) => headers.push($(th).text().trim().toLowerCase()));
  if (headers.length === 0) {
    table.find('tr:first-child th, tr:first-child td').each((idx, th) => headers.push($(th).text().trim().toLowerCase()));
  }
  const isTeacherSchedule = headers.includes('группа');
  const rowArr = rows.toArray();

  for (let i = 0; i < rowArr.length; i++) {
    const row = $(rowArr[i]);
    const wdayCell = row.find('td.wday, td.day, td.dayofweek, td.day-name, td[class*="day"]');
    if (wdayCell.length) { currentDay = wdayCell.text().trim(); continue; }
    const cells = row.find('td');
    if (cells.length >= 3) {
      if (isTeacherSchedule) {
        if (cells.length >= 5) {
          const time = $(cells[0]).text().trim();
          const groupText = $(cells[1]).html().replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
          const subgroup = $(cells[2]).text().trim();
          const contentCell = $(cells[3]);
          const room = $(cells[4]).text().trim();
          const distypeSpan = contentCell.find('.distype');
          const type = distypeSpan.length ? distypeSpan.text().replace(/[()]/g, '').trim() : '';
          const emEl = contentCell.find('em');
          let subject = emEl.length ? emEl.text().trim() : '';
          if (!subject) {
            const strongEl = contentCell.find('strong, b');
            subject = strongEl.length ? strongEl.first().text().trim() : '';
          }
          let weeks = '';
          const clone = contentCell.clone();
          clone.find('.distype').remove();
          clone.find('em').remove();
          clone.find('strong, b').remove();
          const rawText = clone.text().trim();
          const match = rawText.match(/^\(([^)]+)\)/);
          if (match) weeks = match[1];
          else weeks = rawText;
          const groups = groupText.split(/[\n\r,;]+|\s{2,}/).map(g => g.trim()).filter(Boolean);
          const displayGroup = groups.join(', ') + (subgroup ? ` (${subgroup})` : '');
          if (subject && time) {
            lessons.push({ day: currentDay || "Вне сетки", time, weeks, subject, type, teacher: displayGroup, room, isTeacher: true, groups: groups });
          }
        }
      } else {
        const time = $(cells[0]).text().trim();
        const weeks = $(cells[1]).text().trim();
        let subject = '', type = '', teacher = '', room = '';
        const contentCell = row.find("td[colspan='2'], td[colspan='3']");
        const rightCell = row.find('td.right, td.rght');
        if (contentCell.length) {
          const distypeSpan = contentCell.find('.distype');
          type = distypeSpan.length ? distypeSpan.text().replace(/[()]/g, '').trim() : '';
          const teacherSpan = contentCell.find('.teacher, .teacher.dd');
          teacher = teacherSpan.length ? teacherSpan.text().trim() : '';
          if (!teacher) teacher = extractTeacherFromCell(contentCell, $);
          const clone = contentCell.clone();
          clone.find('.distype').remove();
          clone.find('.teacher, .teacher.dd').remove();
          subject = clone.text().replace(/,\s*$/, '').trim();
        }
        // Если пара разбита на подгруппы (строки с td.sg), создаём отдельную
        // карточку для каждой подгруппы со своим преподавателем и аудиторией,
        // вместо того чтобы склеивать все аудитории в одну строку.
        const subgroupLessons = [];
        if (subject) {
          for (let j = i + 1; j < rowArr.length; j++) {
            const subRow = $(rowArr[j]);
            if (subRow.find('td.wday').length) break;
            const subCells = subRow.find('td');
            if (subCells.length >= 3 && !subRow.find('td.sg').length) break;
            const sgCell = subRow.find('td.sg');
            if (!sgCell.length) continue;
            const subgroup = sgCell.text().trim();
            let subTeacher = '';
            const subTeacherSpan = subRow.find('.teacher, .teacher.dd, span[class*="teacher"]');
            if (subTeacherSpan.length) subTeacher = subTeacherSpan.first().text().trim();
            if (!subTeacher) subTeacher = extractTeacherFromCell(subRow, $);
            const lastCell = subCells.last();
            const subRoom = lastCell.length ? lastCell.text().replace(/<!--[\s\S]*?-->/g, '').trim() : '';
            // Недели подгруппы могут отличаться от общих — берём из комментария BSEU
            let subWeeks = weeks;
            const cellHtml = lastCell.length ? lastCell.html() : '';
            const wm = cellHtml && cellHtml.match(/week\[i\]:\s*\(([^)]+)\)/i);
            if (wm) subWeeks = '(' + wm[1].trim() + ')';
            subgroupLessons.push({
              day: currentDay || "Вне сетке", time, weeks: subWeeks, subject, type,
              teacher: (subTeacher || teacher).trim(), room: subRoom, isTeacher: false, subgroup
            });
          }
        }

        if (subgroupLessons.length) {
          subgroupLessons.forEach(l => lessons.push(l));
        } else if (subject && time) {
          room = rightCell.length ? rightCell.text().trim() : '';
          lessons.push({ day: currentDay || "Вне сетке", time, weeks, subject, type, teacher, room, isTeacher: false });
        }
      }
    }
  }

  const subjectGroups = {};
  lessons.forEach(l => {
    const subj = (l.subject || '').trim();
    if (!subjectGroups[subj]) subjectGroups[subj] = [];
    subjectGroups[subj].push(l);
  });
  const dayOrder = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
  Object.values(subjectGroups).forEach(group => {
    group.sort((a, b) => {
      const aDayIdx = dayOrder.indexOf((a.day || '').toLowerCase().trim());
      const bDayIdx = dayOrder.indexOf((b.day || '').toLowerCase().trim());
      if (aDayIdx !== bDayIdx) return aDayIdx - bDayIdx;
      return (a.time || '').localeCompare(b.time || '');
    });
    group.forEach((l, idx) => { l._subjectOrderIndex = idx + 1; });
  });

  return { semesterStartDate, currentSemesterWeek, lessons };
}

async function getScheduleWithCache(cacheKey, bodyString) {
  const cached = fileGetCache(cacheKey);
  const now = Date.now();
  const cacheTTL = 2 * 60 * 60 * 1000;
  if (cached && (now - cached.updatedAt < cacheTTL)) return { ...cached.value, isFallback: false };
  try {
    const response = await fetchWithRetry("https://bseu.by/schedule/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=windows-1251",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      body: iconv.encode(bodyString, 'win1251')
    });
    if (!response.ok) throw new Error(`HTTP status ${response.status}`);
    const buffer = await response.arrayBuffer();
    const htmlText = decodeResponseBuffer(Buffer.from(buffer), response);
    const parsedData = parseScheduleHtml(htmlText);
    fileSetCache(cacheKey, parsedData);
    return { ...parsedData, isFallback: false };
  } catch (error) {
    console.error(`[BSEU Schedule] Failed for ${cacheKey}:`, error);
    if (cached) return { ...cached.value, isFallback: true, savedAt: cached.updatedAt };
    throw error;
  }
}

// ===== Serve static files =====
app.use(express.static(__dirname));

// ===== Список аудиторий (реальные номера "корпус/аудитория" из полного расписания BSEU) =====
// ===== Расписание аудитории: полная копия расписания БГЭУ =====
const BSEU_FACULTIES = ["12","14","13","7","2","8","534","11","263","18","129","450","530","531","497","535","432"];
const FULL_SCHEDULE_INTERVAL = 10 * 60 * 1000; // Каждые 10 минут: сверяем расписание с BSEU
let fullScheduleCache = null;
let fullScheduleUpdatedAt = 0;
let fullScheduleBuilding = false;
let fullSchedulePromise = null;
let fullScheduleError = null; // Сохраняем ошибку сборки для отображения статуса
let fullScheduleStartedAt = 0;

// Кэш расписания по аудиториям: { "2/301": [{ subject, type, teacher, groupText, startTime, endTime, dates, audience, audienceTokens }, ...] }
let audienceScheduleCache = {};
let audienceScheduleUpdatedAt = 0;

// --- Загрузка кэша из файла (если есть) ---
const CACHE_FILE = path.join(__dirname, 'fullScheduleCache.json');
try {
  if (fs.existsSync(CACHE_FILE)) {
    const cachedData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    fullScheduleCache = cachedData.fullScheduleCache || null;
    fullScheduleUpdatedAt = cachedData.updatedAt || 0;
    audienceScheduleCache = cachedData.audienceScheduleCache || {};
    audienceScheduleUpdatedAt = cachedData.audienceScheduleUpdatedAt || 0;
    console.log('[Cache] Загружен кэш из файла:', CACHE_FILE);
  }
} catch (e) {
  console.warn('[Cache] Не удалось загрузить кэш из файла:', e.message);
}

async function getFacultyGroups(faculty) {
  const forms = await fetchBseuList("__id.22.main.inpFldsA.GetForms", { faculty });
  if (!Array.isArray(forms)) return [];
  let groups = [];
  for (const f of forms) {
    const courses = await fetchBseuList("__id.23.main.inpFldsA.GetCourse", { faculty, form: f.value });
    if (!Array.isArray(courses)) continue;
    for (const c of courses) {
      const gs = await fetchBseuList("__id.23.main.inpFldsA.GetGroups", { faculty, form: f.value, course: c.value });
      if (!Array.isArray(gs)) continue;
      for (const g of gs) groups.push({ faculty, form: f.value, course: c.value, group: g.value, groupText: g.text });
    }
  }
  return groups;
}

function lessonDate(semesterStartDate, dayName, weekNum) {
  if (!semesterStartDate || !weekNum) return null;
  const daysOfWeekMap = { 'понедельник':0,'вторник':1,'среда':2,'четверг':3,'пятница':4,'суббота':5,'воскресенье':6 };
  const dayIndex = daysOfWeekMap[String(dayName || '').toLowerCase().trim()];
  if (dayIndex === undefined) return null;
  // Работаем строго с календарными датами (UTC), без учёта часового пояса
  // сервера — иначе на Render (UTC) даты сдвигаются на день относительно
  // календаря пользователя.
  const m = String(semesterStartDate).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const sy = Number(m[1]), sm = Number(m[2]) - 1, sd = Number(m[3]);
  let dow = new Date(Date.UTC(sy, sm, sd)).getUTCDay(); // 0 = воскресенье
  const diffToMon = (dow === 0 ? -6 : 1 - dow);
  const monday = new Date(Date.UTC(sy, sm, sd + diffToMon));
  monday.setUTCDate(monday.getUTCDate() + (weekNum - 1) * 7 + dayIndex);
  const y = monday.getUTCFullYear();
  const mo = String(monday.getUTCMonth() + 1).padStart(2, '0');
  const d = String(monday.getUTCDate()).padStart(2, '0');
  const resultDate = `${y}-${mo}-${d}`;
  // Пары не должны быть в августе
  if (resultDate.includes('-08-')) return null;
  return resultDate;
}
function parseWeeks(weeksStr) {
  if (!weeksStr) return [];
  const clean = String(weeksStr).replace(/[()]/g, '').trim();
  if (!clean) return [];
  const result = [];
  clean.split(',').forEach(part => {
    if (part.includes('-')) {
      const [s, e] = part.split('-').map(Number);
      for (let i = s; i <= e; i++) result.push(i);
    } else {
      const n = Number(part);
      if (!Number.isNaN(n)) result.push(n);
    }
  });
  return result;
}
function audienceTokens(room) {
  if (!room) return [];
  const tokens = [];
  String(room).split(',').forEach(part => {
    const p = part.trim();
    const slashIdx = p.lastIndexOf('/');
    const num = (slashIdx >= 0 ? p.slice(slashIdx + 1) : p).trim();
    const m = num.match(/^\d+/);
    if (m) tokens.push(m[0]);
  });
  return tokens;
}

// Возвращает только те аудитории пары, которые реально совпали с запросом.
// Нужно, чтобы в режиме аудитории для "2/300" не показывались все комнаты
// исходной строки BSEU ("2/300, 2/405"), а только запрошенная "2/300".
function matchedRoomsOf(audience, hasSlash, targetRooms, queryTokens) {
  const rooms = String(audience || '').split(',').map(r => r.trim()).filter(Boolean);
  if (!rooms.length) return [];
  if (hasSlash) {
    return rooms.filter(r => targetRooms.includes(r));
  }
  return rooms.filter(r => {
    const toks = audienceTokens(r);
    return queryTokens.some(qt => toks.includes(qt));
  });
}

// Извлечение преподавателя из ячейки пары. BSEU хранит имя в разных
// вариантах (span.teacher, span.teacher.dd, a.teacher, любой элемент с
// классом "teacher" внутри), а иногда — просто текстом "Фамилия И.О.".
function extractTeacherFromCell(contentCell, $) {
  if (!contentCell || !contentCell.length) return '';
  let t = '';
  const sel = contentCell.find('.teacher, a.teacher, span[class*="teacher"], b.teacher');
  if (sel.length) t = sel.first().text().trim();
  if (!t) {
    contentCell.find('*').each(function () {
      const cls = ($(this).attr('class') || '').toLowerCase();
      if (cls.includes('teacher')) { t = $(this).text().trim(); return false; }
    });
  }
  if (!t) {
    // Запасной вариант: "Фамилия И.И." или "Фамилия И И" внутри ячейки
    const txt = contentCell.text() || '';
    const m = txt.match(/([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ]\.){1,2})/);
    if (m) t = m[1].trim();
  }
  return t;
}

// Преобразование времени "ЧЧ:ММ" в минуты для надёжной сортировки
function timeToMinutes(t) {
  if (!t) return 99999;
  const m = String(t).match(/(\d{1,2})[:.](\d{2})/);
  if (!m) return 99999;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Компактная подпись расписания для сверки с предыдущей копией.
// Учитывает только значимые поля каждой пары (без дублей по аудиториям).
function scheduleSignature(entries) {
  if (!Array.isArray(entries) || !entries.length) return '';
  const parts = entries.map(e => [
    (e.subject||'').trim().toLowerCase(),
    (e.type||'').trim().toLowerCase(),
    (e.teacher||'').trim().toLowerCase(),
    (e.groupText||'').trim().toLowerCase(),
    (e.audience||'').trim(),
    (e.startTime||''),
    (e.endTime||''),
    (e.dates||[]).slice().sort().join(','),
    (e.subgroup||'').trim().toLowerCase()
  ].join('|')).sort();
  return parts.join(';');
}

async function buildFullSchedule() {
  if (fullScheduleBuilding) return fullSchedulePromise;
  fullScheduleBuilding = true;
  fullScheduleError = null;
  fullScheduleStartedAt = Date.now();
  fullSchedulePromise = (async () => {
    console.log('[FullSchedule] Начинаем сборку полной копии расписания...');
    const t0 = Date.now();
    let allGroups = [];
    try {
      // Используем Promise.allSettled чтобы не упасть на одном факультете
      const groupResults = await Promise.allSettled(BSEU_FACULTIES.map(fac =>
        getFacultyGroups(fac).catch(e => { console.warn(`[FullSchedule] Факультет ${fac}: ${e.message}`); return []; })
      ));
      groupResults.forEach(result => {
        if (result.status === 'fulfilled' && Array.isArray(result.value)) {
          allGroups = allGroups.concat(result.value);
        }
      });
    } catch (e) {
      console.warn('[FullSchedule] Ошибка при сборе групп:', e.message);
    }

    const CONCURRENCY = 15; // Уменьшаем concurrency с 30 до 15
    const all = [];
    const fetched = [];
    // Собираем только если есть группы
    if (allGroups.length > 0) {
      for (let i = 0; i < allGroups.length; i += CONCURRENCY) {
        const batch = allGroups.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(batch.map(async (g) => {
          try {
            const body = `__act=__id.25.main.inpFldsA.GetSchedule__sp.7.results__fp.4.main&faculty=${g.faculty}&form=${g.form}&course=${g.course}&group=${g.group}&period=3`;
            const gkey = `group:${g.faculty}:${g.form}:${g.course}:${g.group}`;
            const sched = await getScheduleWithCache(gkey, body);
            return { sched, g };
          } catch (e) { return null; }
        }));
        for (const r of results) {
          if (r.status !== 'fulfilled' || !r.value) continue;
          fetched.push(r.value);
        }
        // Небольшая задержка между батчами, чтобы не загружать сервер BSEU
        if (i + CONCURRENCY < allGroups.length) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }

    // Каноническая дата начала семестра — самая частая (мода) среди всех групп.
    // Защищает от рассинхрона: если у части групп BSEU вернул старт семестра,
    // сдвинутый на неделю (см. ветку «Текущая - N учебная неделя» в
    // parseScheduleHtml на сервере в UTC), все пары кэша получат единую,
    // корректную дату старта и не «уедут» на неделю относительно других групп.
    const semCount = {};
    for (const { sched } of fetched) {
      const s = sched.semesterStartDate;
      if (s) semCount[s] = (semCount[s] || 0) + 1;
    }
    let canonicalSemStart = null, maxCount = -1;
    for (const s of Object.keys(semCount)) {
      if (semCount[s] > maxCount) { maxCount = semCount[s]; canonicalSemStart = s; }
    }

    for (const { sched, g } of fetched) {
      const lessons = sched.lessons || [];
      const semStart = canonicalSemStart || sched.semesterStartDate;
      for (const l of lessons) {
        const weeks = parseWeeks(l.weeks);
        const dates = [];
        for (const w of weeks) {
          const d = lessonDate(semStart, l.day, w);
          if (d) dates.push(d);
        }
        if (!dates.length) continue;
        if (!l.room) continue;
        const roomStr = String(l.room).trim();
        const roomParts = roomStr.split(',').map(p => p.trim());
        const allValid = roomParts.every(part => /\d/.test(part));
        if (!allValid) continue;
        const [start, end] = String(l.time || '').split(/[-–]/).map(s => s.trim());

        // Если несколько аудиторий и нет подгруппы - создаём отдельные записи для каждой аудитории
        if (roomParts.length > 1 && !l.subgroup) {
          for (const singleRoom of roomParts) {
            const entry = {
              audience: singleRoom,
              audienceTokens: audienceTokens(singleRoom),
              dates,
              subject: l.subject,
              type: l.type,
              teacher: l.teacher || '',
              groupText: g.groupText,
              startTime: start || '',
              endTime: end || '',
              subgroup: l.subgroup || ''
            };
            all.push(entry);
            if (!audienceScheduleCache[singleRoom]) {
              audienceScheduleCache[singleRoom] = [];
            }
            audienceScheduleCache[singleRoom].push(entry);
          }
        } else {
          const entry = {
            audience: l.room,
            audienceTokens: audienceTokens(l.room),
            dates,
            subject: l.subject,
            type: l.type,
            teacher: l.teacher || '',
            groupText: g.groupText,
            startTime: start || '',
            endTime: end || '',
            subgroup: l.subgroup || ''
          };
          all.push(entry);
          if (l.room) {
            if (!audienceScheduleCache[l.room]) {
              audienceScheduleCache[l.room] = [];
            }
            audienceScheduleCache[l.room].push(entry);
        }
      }
    }
  }

  // === Сверка с предыдущей копией расписания ===
  const newSignature = scheduleSignature(all);
  const oldSignature = scheduleSignature(fullScheduleCache);
  const changed = !fullScheduleCache || newSignature !== oldSignature;

  if (changed) {
    fullScheduleCache = all;
    fullScheduleUpdatedAt = Date.now();
    fullScheduleError = null;
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify({
        fullScheduleCache,
        audienceScheduleCache,
        updatedAt: fullScheduleUpdatedAt,
        audienceScheduleUpdatedAt
      }, null, 2));
      console.log('[Cache] Расписание изменилось — кэш обновлён и сохранён в файл:', CACHE_FILE);
    } catch (e) {
      console.warn('[Cache] Не удалось сохранить кэш в файл:', e.message);
    }
  }

  console.log(`[FullSchedule] Готово: ${all.length} пар, ${allGroups.length} групп, за ${((Date.now() - t0) / 1000).toFixed(1)} с; изменения: ${changed ? 'да' : 'нет'}`);
  fullScheduleBuilding = false;
  return all;
})();
  
  fullSchedulePromise.catch(e => {
    console.error('[FullSchedule] Ошибка сборки:', e.message);
    fullScheduleError = e.message;
    fullScheduleBuilding = false;
  });
  
  return fullSchedulePromise;
}

async function ensureFullSchedule() {
  // Если кэш уже загружен — возвращаем его сразу
  if (fullScheduleCache) return fullScheduleCache;
  
  // Если сборка уже идёт — не ждём, возвращаем null
  // Клиент получит ответ, что данные ещё собираются
  if (fullScheduleBuilding) {
    return null;
  }
  
  // Если сборка ещё не запускалась — запускаем в фоне и возвращаем null
  buildFullSchedule().catch(e => console.error('[FullSchedule] Фоновая сборка:', e.message));
  return null;
}

async function getAudienceScheduleBseu(audience, date) {
  const targetAud = audience.trim();
  const schedule = await ensureFullSchedule();
  
  // Если расписание ещё не готово, возвращаем специальный ответ
  if (!schedule && !fullScheduleCache) {
    return { 
      data: [], 
      isFallback: false, 
      isBuilding: true,
      buildingStartedAt: fullScheduleStartedAt,
      error: 'Идёт загрузка полного расписания аудиторий. Попробуйте через несколько минут.',
      message: `Сборка данных началась ${fullScheduleStartedAt ? 'несколько секунд назад' : 'только что'}. Пожалуйста, подождите.`
    };
  }
  
  const src = schedule || fullScheduleCache || [];
  // Если запрос содержит слэш (корпус/аудитория, напр. "2/301") — ищем
  // точное совпадение по полной аудитории (в т.ч. среди объединённых строк
  // вида "2/301, 2/406"). Токен-поиск по голому номеру НЕ применяем, чтобы
  // не подхватывать другие корпуса ("4/301").
  // Если запрос — голый номер ("301") — совпадение по токенам по всем корпусам.
  const hasSlash = String(targetAud).includes('/');
  const targetRooms = String(targetAud).split(',').map(r => r.trim());
  const queryTokens = audienceTokens(targetAud);
  const matched = src.filter(p => {
    if (!p.dates.includes(date)) return false;
    const rooms = String(p.audience || '').split(',').map(r => r.trim());
    if (hasSlash) {
      return rooms.some(r => targetRooms.includes(r));
    }
    return queryTokens.length > 0 && p.audienceTokens.some(t => queryTokens.includes(t));
  });

  // Объединяем карточки одной и той же пары (один предмет, тип, время и
  // преподаватель), идущей у нескольких групп одновременно (например, лекция),
  // в одну карточку со списком всех групп.
  const matchedWithMR = matched.map(p => {
    const mr = matchedRoomsOf(p.audience, hasSlash, targetRooms, queryTokens);
    return { ...p, matchedRooms: mr };
  });

  const keyOf = (p) =>
    `${(p.subject || '').trim().toLowerCase()}|` +
    `${(p.type || '').trim().toLowerCase()}|` +
    `${(p.startTime || '').trim()}|` +
    `${(p.endTime || '').trim()}|` +
    `${(p.teacher || '').trim().toLowerCase()}|` +
    `${(p.subgroup || '').trim().toLowerCase()}|` +
    `${p.matchedRooms.sort().join(',')}`;

  const byKey = new Map();
  for (const p of matchedWithMR) {
    const k = keyOf(p);
    const mr = p.matchedRooms;
    let card = byKey.get(k);
    if (!card) {
      card = {
        shortNameRU: p.subject,
        lessonTypeShortNameRU: p.type,
        teachers: p.teacher ? [p.teacher] : [],
        groups: [],
        audience: mr.join(', '),
        startTime: p.startTime,
        endTime: p.endTime,
        subgroup: p.subgroup || ''
      };
      byKey.set(k, card);
    }
    if (p.groupText && !card.groups.includes(p.groupText)) {
      card.groups.push(p.groupText);
    }
  }
  const collected = Array.from(byKey.values());
  collected.sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  let dayNameRU = '';
  try { dayNameRU = new Date(date + 'T00:00:00').toLocaleDateString('ru-RU', { weekday: 'long' }); } catch (e) {}
  const payload = [{ scheduleOnDays: [{ id: 0, date: date + 'T00:00:00', dayNameRU, week: 0, lessons: collected }] }];
  return { data: payload, isFallback: false, fromCache: false, builtAt: fullScheduleUpdatedAt };
}

function normalizeGroupName(str) {
  if (!str) return '';
  return String(str).replace(/\s*\([^)]*\)/g, '').trim().toUpperCase();
}

async function getGroupScheduleAutoDetect(faculty, form, course, group, groupText) {
  const body = `__act=__id.25.main.inpFldsA.GetSchedule__sp.7.results__fp.4.main&faculty=${faculty}&form=${form}&course=${course}&group=${group}&period=3`;
  const cacheKey = `group:${faculty}:${form}:${course}:${group}`;
  const schedule = await getScheduleWithCache(cacheKey, body);

  if (schedule && Array.isArray(schedule.lessons) && schedule.lessons.length > 0) {
    return schedule;
  }

  try {
    let targetText = groupText ? normalizeGroupName(groupText) : null;

    if (!targetText) {
      try {
        const groupsOnCurrentCourse = await fetchBseuList("__id.23.main.inpFldsA.GetGroups", { faculty, form, course });
        if (Array.isArray(groupsOnCurrentCourse)) {
          const gObj = groupsOnCurrentCourse.find(g => String(g.value) === String(group));
          if (gObj) targetText = normalizeGroupName(gObj.text);
        }
      } catch (e) {}
    }

    const courses = await fetchBseuList("__id.23.main.inpFldsA.GetCourse", { faculty, form });
    if (Array.isArray(courses)) {
      const numCourse = Number(course) || 1;
      const sortedCourses = courses.slice().sort((a, b) => {
        const na = Number(a.value) || 0;
        const nb = Number(b.value) || 0;
        const diffA = na > numCourse ? (na - numCourse) : (100 + Math.abs(na - numCourse));
        const diffB = nb > numCourse ? (nb - numCourse) : (100 + Math.abs(nb - numCourse));
        return diffA - diffB;
      });

      for (const c of sortedCourses) {
        if (String(c.value) === String(course)) continue;
        const gs = await fetchBseuList("__id.23.main.inpFldsA.GetGroups", { faculty, form, course: c.value });
        if (!Array.isArray(gs)) continue;

        let matchedGroup = null;
        if (targetText) {
          matchedGroup = gs.find(g => normalizeGroupName(g.text) === targetText || String(g.value) === String(group));
        } else {
          matchedGroup = gs.find(g => String(g.value) === String(group));
        }

        if (matchedGroup) {
          const newBody = `__act=__id.25.main.inpFldsA.GetSchedule__sp.7.results__fp.4.main&faculty=${faculty}&form=${form}&course=${c.value}&group=${matchedGroup.value}&period=3`;
          const newCacheKey = `group:${faculty}:${form}:${c.value}:${matchedGroup.value}`;
          const newSchedule = await getScheduleWithCache(newCacheKey, newBody);
          if (newSchedule && Array.isArray(newSchedule.lessons) && newSchedule.lessons.length > 0) {
            console.log(`[Course Auto-Detect] Группа ${matchedGroup.text} перешла с курса ${course} на курс ${c.value}`);
            return {
              ...newSchedule,
              detectedCourse: c.value,
              detectedGroup: matchedGroup.value,
              courseChanged: true,
              originalCourse: course
            };
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Course Auto-Detect] Ошибка при автоопределении курса группы:', err.message);
  }

  return schedule;
}

// ===== Unified schedule endpoint (group / teacher / room) =====
async function handleScheduleRequest(req, res) {
  try {
    const { faculty, form, course, group, groupText, tid, taid, sid, tname, audience, date } = req.query;
    if (audience && date) {
      const schedule = await getAudienceScheduleBseu(audience.trim(), date.trim());
      return res.json(schedule);
    }
    if (tid && taid && sid && tname) {
      const body = `__act=tid.${tid.length}.${tid}taid.${taid.length}.${taid}sid.${sid.length}.${sid}__id.22.main.TSchedA.GetTSched__sp.8.tresults__fp.4.main&tname=${toWin1251Url(tname)}&period=3`;
      const cacheKey = `teacher:${tid}:${taid}:${sid}:${tname}`;
      const schedule = await getScheduleWithCache(cacheKey, body);
      return res.json(schedule);
    }
    if (faculty && form && course && group) {
      const schedule = await getGroupScheduleAutoDetect(faculty, form, course, group, groupText);
      return res.json(schedule);
    }
    return res.status(400).json({ error: 'missing_params', received: req.query });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
app.get('/api/schedule', handleScheduleRequest);
app.get('/api/schedule/group', handleScheduleRequest);
app.get('/api/schedule/teacher', handleScheduleRequest);
app.get('/api/schedule/room', handleScheduleRequest);

// ===== ENDPOINT: список аудиторий =====
app.get('/api/audiences', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const schedule = await ensureFullSchedule();
    
    // Если кэш ещё не готов, запускаем сборку в фоне и возвращаем временный ответ
    if (!schedule && !fullScheduleCache) {
      // Запускаем сборку в фоне, если ещё не запущена
      if (!fullScheduleBuilding) {
        buildFullSchedule().catch(e => console.error('[FullSchedule] Фоновая сборка:', e.message));
      }
      // Если есть запрос на сборку — сообщаем клиенту
      return res.status(503).json({ 
        error: 'building', 
        message: 'Идёт первичная загрузка расписания аудиторий. Попробуйте через минуту.',
        building: true 
      });
    }
    
    const src = schedule || fullScheduleCache || [];
    const map = new Map();
    for (const p of src) {
      const full = p.audience;
      if (!full) continue;
      const roomParts = String(full).trim().split(',').map(r => r.trim());
      const allValid = roomParts.every(part => /\d/.test(part.trim()));
      if (!allValid) continue;
      for (const room of roomParts) {
        if (q) {
          if (!room.toLowerCase().includes(q)) continue;
        }
        map.set(room, (map.get(room) || 0) + 1);
      }
    }
    const list = Array.from(map.entries())
      .map(([audience, count]) => ({ audience, count }))
      .sort((a, b) => {
        const na = Number(a.audience.replace(/\D/g, '')) || 0;
        const nb = Number(b.audience.replace(/\D/g, '')) || 0;
        return na - nb || a.audience.localeCompare(b.audience);
      });
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Каскадные списки для режима "По группе"
app.get('/api/forms', async (req, res) => {
  try {
    const { faculty } = req.query;
    const data = await fetchBseuList("__id.22.main.inpFldsA.GetForms", { faculty });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get('/api/courses', async (req, res) => {
  try {
    const { faculty, form } = req.query;
    const data = await fetchBseuList("__id.23.main.inpFldsA.GetCourse", { faculty, form });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get('/api/groups', async (req, res) => {
  try {
    const { faculty, form, course } = req.query;
    const data = await fetchBseuList("__id.23.main.inpFldsA.GetGroups", { faculty, form, course });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get('/api/teachers', async (req, res) => {
  try {
    const { q } = req.query;
    const data = await fetchBseuList("__id.24.main.TSchedA.getTeachers", { tname: q });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/schedule-range', (req, res) => {
  const range = getScheduleDateRange();
  res.json({
    ok: true,
    min: range.min,
    max: range.max,
    hasCache: !!fullScheduleCache,
    building: fullScheduleBuilding
  });
});

  function getScheduleDateRange() {
    let min = null;
    let max = null;
    const src = fullScheduleCache || [];
    for (const p of src) {
      for (const d of (p.dates || [])) {
        if (min === null || d < min) min = d;
        if (max === null || d > max) max = d;
      }
    }
    return { min, max };
  }

// ===== Health check endpoint для Render =====
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    fullSchedule: {
      hasCache: !!fullScheduleCache,
      entries: fullScheduleCache ? fullScheduleCache.length : 0,
      building: fullScheduleBuilding,
      updatedAt: fullScheduleUpdatedAt,
      startedAt: fullScheduleStartedAt,
      error: fullScheduleError,
      buildingTime: fullScheduleStartedAt ? Math.floor((Date.now() - fullScheduleStartedAt) / 1000) + 's' : null
    },
    nodeVersion: process.version,
    timestamp: Date.now()
  });
});

app.use(express.static(__dirname));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running at http://0.0.0.0:${PORT}`);
  
  // Загружаем кэш из файла при старте
  if (fullScheduleCache) {
    console.log(`[Cache] Загружен кэш с ${fullScheduleCache.length} записями.`);
  } else {
    // На Render (и локально) сразу запускаем сборку полного расписания,
    // чтобы режим "по аудитории" работал без ожидания первого запроса.
    console.warn('[Cache] Кэш не загружен. Запускаем начальную сборку полного расписания...');
    buildFullSchedule().catch(e => console.error('[FullSchedule] Ошибка начальной сборки:', e.message));
  }
  
  // Периодическая сборка для обновления кэша
  setInterval(() => {
    buildFullSchedule().catch(e => console.error('[FullSchedule] Ошибка периодической сборки:', e.message));
  }, FULL_SCHEDULE_INTERVAL);
});

server.on('error', (err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});