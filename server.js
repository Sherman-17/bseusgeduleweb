const express = require('express');
const path = require('path');
const fs = require('fs');
const iconv = require('iconv-lite');
const cheerio = require('cheerio');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const cron = require('node-cron');

const BASE_DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
const PARSER_LOG_FILE = path.join(BASE_DATA_DIR, 'parser.log');

function logParser(msg, level = 'INFO') {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const formatted = `[${timestamp}] [${level}] ${msg}`;
  console.log(formatted);
  try {
    if (!fs.existsSync(path.dirname(PARSER_LOG_FILE))) {
      fs.mkdirSync(path.dirname(PARSER_LOG_FILE), { recursive: true });
    }
    fs.appendFileSync(PARSER_LOG_FILE, formatted + '\n', 'utf-8');
  } catch (e) {
    console.error('[Logger] Failed to write to parser.log:', e.message);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const auth = require('./server/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Поддержка обратного прокси (Nginx, cPanel Passenger, Cloudflare, hoster.by)
app.set('trust proxy', 1);

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
    if (opts.maxAge) {
      // Max-Age + Expires дублируют друг друга: часть браузеров/прокси
      // игнорирует Max-Age без Expires — сессия должна пережить рестарт хостинга.
      str += `; Max-Age=${Math.floor(opts.maxAge / 1000)}`;
      try { str += `; Expires=${new Date(Date.now() + opts.maxAge).toUTCString()}`; } catch (e) {}
    }
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

// Ответы API не должны сохраняться браузером или обратным прокси.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
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
    maxAge: 1000 * 60 * 60 * 24 * 120, // 120 дней, как SESSION_TTL в server/auth.js
    path: '/'
  });
}

const guardAuth = auth.guardAuth;

app.get('/api/auth/check-login', async (req, res) => {
  try {
    const login = String(req.query.login || '').trim();
    if (!login) {
      return res.json({ ok: true, taken: false });
    }
    const taken = auth.isLoginTaken(login);
    res.json({ ok: true, taken });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/register', guardAuth, async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  try {
    const { login, password } = req.body || {};
    const user = await auth.registerUser(login, password);
    auth.resetFailedAttempts(ip);
    const token = auth.createSession(user.id, user.login);
    setSessionCookie(res, token);
    res.json({ ok: true, user: { login: user.login } });
  } catch (e) {
    const state = auth.recordFailedAttempt(ip);
    if (state.locked) {
      res.setHeader('Retry-After', state.retryAfter);
      return res.status(429).json({ error: `Слишком много попыток. Пауза ${state.retryAfter} сек.` });
    }
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/login', guardAuth, async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  try {
    const { login, password } = req.body || {};
    const user = await auth.verifyUser(login, password);
    if (!user) {
      const state = auth.recordFailedAttempt(ip);
      if (state.locked) {
        res.setHeader('Retry-After', state.retryAfter);
        return res.status(429).json({ error: `Слишком много попыток. Пауза ${state.retryAfter} сек.` });
      }
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    auth.resetFailedAttempts(ip);
    const token = auth.createSession(user.id, user.login);
    setSessionCookie(res, token);
    res.json({ ok: true, user: { login: user.login } });
  } catch (e) {
    const state = auth.recordFailedAttempt(ip);
    if (state.locked) {
      res.setHeader('Retry-After', state.retryAfter);
      return res.status(429).json({ error: `Слишком много попыток. Пауза ${state.retryAfter} сек.` });
    }
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
const CACHE_DIR = path.join(BASE_DATA_DIR, '.cache');
const CACHE_VERSION = 'v10'; // Увеличить при изменении логики парсинга
function ensureCacheDir() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch (e) { /* ignore */ }
}
ensureCacheDir();

// ===== Читаемая «подпись» кэш-файла =====
// Имя файла формируется из понятной метки (что хранится) + короткого хэша,
// чтобы по имени сразу было видно содержимое и сохранялась уникальность.
function sanitizeChunk(s, maxLen) {
  const clean = String(s)
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
  return clean || 'x';
}
function readableCacheName(key) {
  try {
    // list:<action>:<jsonParams> — выпадающие списки (факультеты, формы…)
    if (key.startsWith('list:')) {
      const rest = key.slice('list:'.length);
      const sep = rest.indexOf(':');
      const action = sep >= 0 ? rest.slice(0, sep) : rest;
      const paramsRaw = sep >= 0 ? rest.slice(sep + 1) : '';
      // из "__id.22.main.inpFldsA.GetForms" берём "GetForms"
      const actionName = (String(action).split('.').pop() || 'list').replace(/\W+/g, '_');
      let paramsPart = '';
      try {
        const p = JSON.parse(paramsRaw);
        paramsPart = Object.keys(p).map(k => `${k}-${p[k]}`).join('_');
      } catch (e) { paramsPart = ''; }
      return `list_${sanitizeChunk(actionName, 40)}${paramsPart ? '_' + sanitizeChunk(paramsPart, 60) : ''}`;
    }
    // group:<faculty>:<form>:<course>:<group>
    if (key.startsWith('group:')) {
      const p = key.slice('group:'.length).split(':').map(c => sanitizeChunk(c, 40));
      return 'group_' + p.join('_');
    }
    // teacher:<tid>:<taid>:<sid>:<tname>
    if (key.startsWith('teacher:')) {
      const p = key.slice('teacher:'.length).split(':');
      const tname = (p.length >= 4 ? p[3] : '').replace(/\W+/g, '_');
      return `teacher_${sanitizeChunk(tname, 50)}${p[0] ? '_' + sanitizeChunk(p[0], 30) : ''}`;
    }
  } catch (e) { /* ниже запасной вариант */ }
  return sanitizeChunk(String(key), 80);
}
function cacheShortHash(key) {
  return crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 10);
}
function cacheFilePath(key) {
  const label = readableCacheName(key);
  const hash = cacheShortHash(key);
  return path.join(CACHE_DIR, `${CACHE_VERSION}_${label}_${hash}.json`);
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

// ===== Быстрый поиск преподавателей из локального индекса =====
// Раньше каждый символ в поле ФИО уходил запросом в БГЭУ (медленно: ретраи и
// таймауты по 15 с), хотя ответы на фамилии уже лежат в файловом кэше (ночной
// обход по фамилиям). Индекс (tname -> {tid,taid,sid,tname}) собирается из всех
// ответов getTeachers, персистентен в teacher_index.json, совпадения отдаются
// мгновенно без сети; в БГЭУ идём только если в индексе ничего нет.
const TEACHER_INDEX_FILE = path.join(CACHE_DIR, 'teacher_index.json');
const TEACHER_INDEX_SAVE_DELAY = 10000;
let teacherSearchIndex = new Map();
let teacherIndexSaveTimer = null;
const teacherRefreshInflight = new Set();

function normTeacherQuery(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

try {
  if (fs.existsSync(TEACHER_INDEX_FILE)) {
    const idx = JSON.parse(fs.readFileSync(TEACHER_INDEX_FILE, 'utf-8'));
    if (Array.isArray(idx)) {
      for (const t of idx) {
        if (t && t.tname) teacherSearchIndex.set(normTeacherQuery(t.tname), t);
      }
    }
    logParser(`[Teachers] Loaded local search index: ${teacherSearchIndex.size} names.`, 'INFO');
  }
} catch (e) { /* индекс пересоберётся из свежих ответов */ }

function scheduleTeacherIndexSave() {
  if (teacherIndexSaveTimer) return;
  teacherIndexSaveTimer = setTimeout(() => {
    teacherIndexSaveTimer = null;
    try {
      const arr = [...teacherSearchIndex.values()].slice(0, 5000);
      // Страховка от затирания хорошего индекса маленьким: если на диске
      // уже лежит больше записей (например, 753 из полного кэша), а в памяти
      // сейчас меньше (рестарт с пустым кэшем + пара живых запросов) —
      // файл НЕ перезаписываем. Иначе один рестарт с пустым .cache навсегда
      // убивал поиск преподавателей (именно так индекс ужался до 1 записи).
      try {
        if (fs.existsSync(TEACHER_INDEX_FILE)) {
          const raw = fs.readFileSync(TEACHER_INDEX_FILE, 'utf-8');
          const prev = JSON.parse(raw);
          if (Array.isArray(prev) && prev.length > arr.length + 50) {
            logParser(`[Teachers] Skip index save: on-disk has ${prev.length}, in-memory only ${arr.length} (would wipe).`, 'WARN');
            // Подтягиваем недостающие записи из файла в память, чтобы поиск
            // работал сразу, а не после живых запросов к БГЭУ.
            for (const t of prev) {
              if (t && t.tname) {
                const k = normTeacherQuery(t.tname);
                if (k && !teacherSearchIndex.has(k)) teacherSearchIndex.set(k, t);
              }
            }
            return;
          }
        }
      } catch (_) { /* файл битый — перезаписываем смело */ }
      fs.writeFileSync(TEACHER_INDEX_FILE, JSON.stringify(arr), 'utf-8');
    } catch (e) { /* ignore */ }
  }, TEACHER_INDEX_SAVE_DELAY);
}

function isDummyTeacherIds(t) {
  return String(t && t.tid) === '-1' && String(t && t.taid) === '-1' && String(t && t.sid) === '-1';
}

function mergeTeachersToIndex(list) {
  try {
    if (!Array.isArray(list) || !list.length) return;
    let added = 0;
    for (const t of list) {
      if (!t || !t.tname) continue;
      const k = normTeacherQuery(t.tname);
      if (!k) continue;
      const existing = teacherSearchIndex.get(k);
      if (existing) {
        // Запись-заглушка из полного кэша (все ID -1) заменяется реальными
        // ID при первом живом ответе БГЭУ — иначе заглушка вечно блокировала
        // бы настоящие tid/taid/sid и живое расписание не запрашивалось.
        if (isDummyTeacherIds(existing) && !isDummyTeacherIds(t)) {
          teacherSearchIndex.set(k, { tid: t.tid, taid: t.taid, sid: t.sid, tname: t.tname });
          added++;
        }
        continue;
      }
      teacherSearchIndex.set(k, { tid: t.tid, taid: t.taid, sid: t.sid, tname: t.tname });
      added++;
      if (teacherSearchIndex.size > 6000) break;
    }
    if (added) scheduleTeacherIndexSave();
  } catch (e) { /* ignore */ }
}

// Совпадение запроса с ФИО: префикс фамилии + инициалы/начала имён
// («пет», «петров а», «Петров Александр» — все Петровы).
function teacherFastMatch(tname, q) {
  const a = normTeacherQuery(tname);
  const b = normTeacherQuery(q);
  if (!a || !b) return false;
  if (a.startsWith(b)) return true;
  const ap = a.split(' ').filter(Boolean);
  const bp = b.split(' ').filter(Boolean);
  if (!ap.length || !bp.length) return false;
  if (!ap[0].startsWith(bp[0])) return false;
  if (bp.length === 1) return true;
  for (let i = 1; i < bp.length; i++) {
    const bi = bp[i].replace(/\./g, '');
    if (!bi) continue;
    const ai = (ap[i] || '').replace(/\./g, '');
    if (!ai) return false;
    if (bi.length === 1) {
      if (ai[0] !== bi[0]) return false;
    } else if (!ai.startsWith(bi)) {
      return false;
    }
  }
  return true;
}

// Одноразовый прогрев индекса из файлового кэша: ночной обход уже сохранил
// ответы getTeachers по фамилиям (~сотни файлов) — подхватываем их, чтобы
// быстрый путь работал сразу, а не только после живых запросов.
let teacherIndexWarmed = false;
function warmTeacherIndexFromCache() {
  if (teacherIndexWarmed) return;
  teacherIndexWarmed = true;
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.includes('getTeachers') && f.endsWith('.json'));
    let added = 0;
    for (const f of files) {
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf-8'));
        const val = parsed && parsed.value;
        if (!Array.isArray(val)) continue;
        for (const t of val) {
          if (!t || !t.tname) continue;
          const k = normTeacherQuery(t.tname);
          if (k && !teacherSearchIndex.has(k)) {
            teacherSearchIndex.set(k, { tid: t.tid, taid: t.taid, sid: t.sid, tname: t.tname });
            added++;
            if (teacherSearchIndex.size > 6000) break;
          }
        }
      } catch (e) { /* битый файл — пропускаем */ }
      if (teacherSearchIndex.size > 6000) break;
    }
    if (added) {
      scheduleTeacherIndexSave();
      logParser(`[Teachers] Warmed search index from file cache: +${added} names.`, 'INFO');
    }
  } catch (e) { /* ignore */ }
}

// Подстраховка индекса из полного расписания (fullScheduleCache.json):
// там есть ВСЕ 750+ ФИО преподавателей осеннего семестра, но без
// tid/taid/sid (нужны только для живого запроса к БГЭУ). Добавляем их как
// заглушки (-1/-1/-1): поиск сразу работает, а расписание для таких
// преподавателей отдаётся из полного кэша по ФИО (см. handleScheduleRequest,
// ветка tname-only). При первом живом ответе БГЭУ заглушка заменяется
// реальными ID (см. mergeTeachersToIndex).
// Без этого после очистки .cache (смена CACHE_VERSION) индекс пуст,
// живой БГЭУ лежит — и поиск возвращает [] («Преподаватели не найдены»).
function warmTeacherIndexFromFullCache() {
  try {
    const src = (typeof fullScheduleCache !== 'undefined' && fullScheduleCache) ? fullScheduleCache : null;
    if (!src || !src.length) return 0;
    let added = 0;
    for (const p of src) {
      const name = p && p.teacher ? String(p.teacher).trim() : '';
      if (!name) continue;
      const k = normTeacherQuery(name);
      if (!k || teacherSearchIndex.has(k)) continue;
      teacherSearchIndex.set(k, { tid: '-1', taid: '-1', sid: '-1', tname: name });
      added++;
      if (teacherSearchIndex.size > 6000) break;
    }
    if (added) {
      scheduleTeacherIndexSave();
      logParser(`[Teachers] Warmed search index from fullScheduleCache: +${added} names.`, 'INFO');
    }
    return added;
  } catch (e) { /* ignore */ }
  return 0;
}

function searchTeachersFullCache(q, limit = 20) {
  try {
    const src = (typeof fullScheduleCache !== 'undefined' && fullScheduleCache) ? fullScheduleCache : null;
    if (!src || !src.length) return [];
    const nq = normTeacherQuery(q);
    if (!nq) return [];
    const seen = new Set();
    const out = [];
    for (const p of src) {
      const name = p && p.teacher ? String(p.teacher).trim() : '';
      if (!name) continue;
      const k = normTeacherQuery(name);
      if (!k || seen.has(k)) continue;
      if (!teacherFastMatch(name, nq)) continue;
      seen.add(k);
      const existing = teacherSearchIndex.get(k);
      out.push(existing || { tid: '-1', taid: '-1', sid: '-1', tname: name });
      if (out.length >= 200) break;
    }
    out.sort((x, y) => {
      const nx = normTeacherQuery(x.tname);
      const ny = normTeacherQuery(y.tname);
      const rank = (n) => (n === nq ? 0 : n.startsWith(nq) ? 1 : 2);
      const rx = rank(nx), ry = rank(ny);
      if (rx !== ry) return rx - ry;
      return nx.localeCompare(ny, 'ru');
    });
    return out.slice(0, limit);
  } catch (e) { return []; }
}

function searchTeachersFast(q, limit = 20) {
  warmTeacherIndexFromCache();
  // Если файловый кэш пуст (после смены CACHE_VERSION), добираем ФИО
  // из полного расписания — иначе поиск мёртв, пока БГЭУ недоступен.
  if (!teacherSearchIndex || teacherSearchIndex.size < 50) {
    warmTeacherIndexFromFullCache();
  }
  if (!teacherSearchIndex || !teacherSearchIndex.size) return [];
  const nq = normTeacherQuery(q);
  if (!nq) return [];
  const out = [];
  for (const t of teacherSearchIndex.values()) {
    if (teacherFastMatch(t.tname, nq)) out.push(t);
    if (out.length >= 200) break;
  }
  out.sort((x, y) => {
    const nx = normTeacherQuery(x.tname);
    const ny = normTeacherQuery(y.tname);
    const rank = (n) => (n === nq ? 0 : n.startsWith(nq) ? 1 : 2);
    const rx = rank(nx), ry = rank(ny);
    if (rx !== ry) return rx - ry;
    return nx.localeCompare(ny, 'ru');
  });
  return out.slice(0, limit);
}

// ===== Improved fetch with timeout =====
const FETCH_TIMEOUT = 15000; // 15 секунд: БГЭУ бывает медленным

// Circuit breaker: если БГЭУ отвечает 403 (блок IP хостинга), не долбим его,
// даём бану истечь. Иначе cron каждые 10 минут продлевал бы бан вечно.
let bseuBlockedUntil = 0;
const BSEU_BLOCK_COOLDOWN = 10 * 60 * 1000;
const BSEU_BLOCK_FILE = path.join(BASE_DATA_DIR, 'bseu_block.json');
try {
  if (fs.existsSync(BSEU_BLOCK_FILE)) {
    const b = JSON.parse(fs.readFileSync(BSEU_BLOCK_FILE, 'utf-8'));
    if (b && b.until > Date.now()) bseuBlockedUntil = b.until;
  }
} catch (e) {}
function isBseuBlocked() { return Date.now() < bseuBlockedUntil; }
function noteBseuBlocked() {
  if (isBseuBlocked()) return;
  bseuBlockedUntil = Date.now() + BSEU_BLOCK_COOLDOWN;
  try { fs.writeFileSync(BSEU_BLOCK_FILE, JSON.stringify({ until: bseuBlockedUntil }), 'utf-8'); } catch (e) {}
  logParser('[BSEU] Got 403 — hosting IP seems blocked, pausing background crawls for 10m.', 'WARN');
}

// Зеркало на случай перманентного бана IP хостинга у БГЭУ:
// RENDER_PROXY_BASE=https://xxx.onrender.com — рабочий инстанс, который
// отвечает БГЭУ. Используется ТОЛЬКО как fallback при 403, ответы кэшируются.
// На самом зеркале прокси должен быть ВЫКЛЮЧЕН, иначе запрос уйдёт на себя же
// (петля): для этого достаточно задать на зеркале env RENDER_PROXY_BASE=off
// (принимаются также none / no / false / 0 / -).
const RENDER_PROXY_BASE = (function () {
  const raw = process.env.RENDER_PROXY_BASE === undefined
    ? 'https://bseusgeduleweb.onrender.com'
    : String(process.env.RENDER_PROXY_BASE);
  const value = raw.trim().replace(/\/+$/, '');
  return /^(off|none|no|false|0|-)$/i.test(value) ? '' : value;
})();
async function fetchJsonViaProxy(pathname, params) {
  if (!RENDER_PROXY_BASE) throw new Error('No proxy configured');
  const url = `${RENDER_PROXY_BASE}${pathname}?${new URLSearchParams(params).toString()}`;
  // 90 секунд: бесплатный Render холодно стартует 30–60+ сек после сна.
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': 'bseu-schedule-proxy/1.0' } }, 90000);
  if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
  return res.json();
}
function proxyListTarget(action, params) {
  if (action.includes('GetForms')) return { path: '/api/forms', params: { faculty: params.faculty } };
  if (action.includes('GetCourse')) return { path: '/api/courses', params: { faculty: params.faculty, form: params.form } };
  if (action.includes('GetGroups')) return { path: '/api/groups', params: { faculty: params.faculty, form: params.form, course: params.course } };
  if (action.includes('getTeachers')) return { path: '/api/teachers', params: { q: params.tname } };
  return null;
}
async function fetchListViaProxy(action, params) {
  const t = proxyListTarget(action, params);
  if (!t) throw new Error('No proxy mapping');
  const data = await fetchJsonViaProxy(t.path, t.params);
  if (!Array.isArray(data)) throw new Error('Bad proxy payload');
  return data;
}

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

// Тестовый крючок для проверки поведения при падении БГЭУ.
// Включается ТОЛЬКО переменной окружения при запуске тестового сервера,
// из веба недоступен. Реальные запросы не уходят, ошибка бросается сразу
// (без ожидания ретраев). Примеры:
//   BSEU_SIMULATE_FAIL=502 node server.js   — все запросы к bseu.by падают с 502
//   BSEU_SIMULATE_FAIL=403 ...              — проверка пути через зеркало/прокси
//   BSEU_SIMULATE_FAIL=timeout ...          — обрыв по таймауту
//   BSEU_SIMULATE_FAIL=net ...              — сетевая ошибка (DNS/сброс соединения)
const BSEU_SIMULATE_FAIL = String(process.env.BSEU_SIMULATE_FAIL || '').toLowerCase();
if (BSEU_SIMULATE_FAIL) {
  console.warn(`[TestHook] BSEU_SIMULATE_FAIL=${BSEU_SIMULATE_FAIL}: запросы к bseu.by будут падать (симуляция).`);
}

// Повтор запроса при транзитных сбоях BSEU (502/503/429, таймаут, сетевая
// ошибка) — как в рабочей версии на Render. 4xx (кроме 429) не повторяем.
async function fetchWithRetry(url, options = {}, { retries = 4, baseDelay = 500, timeout = FETCH_TIMEOUT } = {}) {
  if (BSEU_SIMULATE_FAIL && String(url).includes('bseu.by')) {
    if (BSEU_SIMULATE_FAIL === 'timeout') throw new Error(`Request timed out after ${timeout}ms: ${url} (simulated)`);
    if (BSEU_SIMULATE_FAIL === 'net') throw new Error(`fetch failed (simulated): ${url}`);
    throw new Error(`HTTP status ${BSEU_SIMULATE_FAIL} (simulated)`);
  }
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

async function fetchBseuList(action, params = {}, fetchOpts = {}) {
  const cacheKey = `list:${action}:${JSON.stringify(params)}`;
  const cached = fileGetCache(cacheKey);
  const now = Date.now();
  const listTTL = 24 * 60 * 60 * 1000;
  if (cached && (now - cached.updatedAt < listTTL)) {
    if (action.includes('getTeachers')) mergeTeachersToIndex(cached.value);
    return cached.value;
  }

  // Рабочий принцип со старой версии (Render): POST с телом в win1251.
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
    }, {
      retries: fetchOpts.retries ?? 4,
      baseDelay: 500,
      timeout: fetchOpts.timeout ?? FETCH_TIMEOUT
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const decoded = decodeResponseBuffer(Buffer.from(buffer), response);
    const data = JSON.parse(decoded);
    fileSetCache(cacheKey, data);
    if (action.includes('getTeachers')) mergeTeachersToIndex(data);
    return data;
  } catch (error) {
    console.error(`[BSEU List] Failed for ${action}:`, error);
    logParser(`[BSEU List] Failed for ${action}: ${error.message}`, 'WARN');
    if (/403/.test(error.message)) {
      noteBseuBlocked();
      if (RENDER_PROXY_BASE) {
        try {
          const proxied = await fetchListViaProxy(action, params);
          fileSetCache(cacheKey, proxied);
          logParser(`[Proxy] ${action} served via Render mirror.`, 'INFO');
          return proxied;
        } catch (pe) {
          logParser(`[Proxy] List via mirror failed: ${pe.message}`, 'WARN');
        }
      }
    }
    if (cached) return cached.value;
    return [];
  }
}

// BSEU отдаёт дату начала семестра (напр. "Mon Feb 8 00:00:00 UTC+0300 2026").
// Для осеннего семестра учебный год начинается 1 сентября (YYYY-09-01).
// Для весеннего семестра дата приводится к понедельнику недели начала занятий.
function normalizeSemesterStart(dateStr) {
  const m = String(dateStr).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr;
  const sy = Number(m[1]), sm = Number(m[2]) - 1, sd = Number(m[3]);
  // Если осенний семестр (август, сентябрь или январь для учебного года) — фиксируем 1 сентября
  if (sm === 7 || sm === 8) {
    return `${sy}-09-01`;
  }
  // Для весеннего семестра приводим к понедельнику недели начала занятий
  const dow = new Date(Date.UTC(sy, sm, sd)).getUTCDay(); // 0 = воскресенье
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  const monday = new Date(Date.UTC(sy, sm, sd - daysSinceMonday));
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

// Вспомогательная функция нормализации даты к виду YYYY-MM-DD.
// Принимает дату с «неполными» частями ("2026-9-7"), с временем
// ("2026-09-07T00:00:00", "2026-09-07 00:00:00") и лишними пробелами.
// Если строку не удалось разобрать — возвращает её как есть (обрезка пробелов).
function normalizeDateStr(dateStr) {
  if (!dateStr) return '';
  const raw = String(dateStr).trim();
  // Отбрасываем возможную часть со временем (ISO-разделитель "T" или пробел).
  const datePart = raw.split(/[T ]/)[0];
  const parts = datePart.split('-');
  if (parts.length === 3) {
    const y = parts[0];
    const m = parts[1].padStart(2, '0');
    const d = parts[2].padStart(2, '0');
    if (/^\d{4}$/.test(y) && /^\d{2}$/.test(m) && /^\d{2}$/.test(d)) {
      return `${y}-${m}-${d}`;
    }
  }
  return raw;
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
      let year = parsedDate.getFullYear();
      if (isAutumnPeriod) {
        if (currentMonth === 0) year -= 1;
        return `${year}-09-01`;
      }
      return normalizeSemesterStart(parsedDate.toISOString().slice(0, 10));
    }
  }

  let year = now.getFullYear();
  if (isAutumnPeriod) {
    if (currentMonth === 0) year -= 1;
    return `${year}-09-01`;
  } else {
    const feb8 = new Date(Date.UTC(year, 1, 8));
    return normalizeSemesterStart(feb8.toISOString().slice(0, 10));
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
  if (!table.length) return { semesterStartDate, currentSemesterWeek, lessons: [], isSchedulePage: false };

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
    if (cells.length >= 2) {
      if (isTeacherSchedule) {
        if (cells.length >= 5) {
          const time = $(cells[0]).text().trim();
          const groupText = $(cells[1]).html().replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
          const subgroup = $(cells[2]).text().trim();
          const contentCell = $(cells[3]);
          const room = extractRoomNumbers($(cells[4]).text()).join(', ');
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
          else if (/^\s*[\d\s,–—\-.]+\s*$/.test(rawText)) weeks = rawText;
          if (!weeks) {
            const commentMatch = row.html().match(/week\[i\]:\s*([\d\s,–—\-]+)/i);
            if (commentMatch) weeks = '(' + commentMatch[1].trim() + ')';
          }
          const groups = groupText.split(/[\n\r,;]+|\s{2,}/).map(g => g.trim()).filter(Boolean);
          const displayGroup = groups.join(', ') + (subgroup ? ` (${subgroup})` : '');
          if (subject && time) {
            lessons.push({ day: currentDay || "Вне сетки", time, weeks, subject, type, teacher: displayGroup, room, isTeacher: true, groups: groups, subgroup });
          }
        }
      } else {
        if (row.find('td.sg').length) continue;
        const time = $(cells[0]).text().trim();
        let weeks = '';
        if (cells.length >= 3) {
          const c1 = $(cells[1]);
          const isContentCell = c1.find('.distype, .teacher, em, strong, b').length > 0 || c1.attr('colspan');
          const text = c1.text().trim();
          if (!isContentCell && /\d/.test(text) && /^\s*\(?[\d\s,–—\-.]+\)?\s*$/.test(text)) {
            weeks = text;
          }
        }
        if (!weeks) {
          const commentMatch = row.html().match(/week\[i\]:\s*([\d\s,–—\-]+)/i);
          // Пустой `week[i]:` (без цифр) неделями не считаем, иначе
          // получалось "()" и пара выпадала из подсчёта пропусков.
          if (commentMatch && /\d/.test(commentMatch[1])) weeks = '(' + commentMatch[1].trim() + ')';
        }
        let subject = '', type = '', teacher = '', room = '';
        const contentCell = row.find("td[colspan='2'], td[colspan='3'], td[colspan='4']");
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
        const subgroupLessons = [];
        if (subject) {
          for (let j = i + 1; j < rowArr.length; j++) {
            const subRow = $(rowArr[j]);
            if (subRow.find('td.wday').length) break;
            const subCells = subRow.find('td');
            if (subCells.length >= 2 && !subRow.find('td.sg').length) break;
            const sgCell = subRow.find('td.sg');
            if (!sgCell.length) continue;
            const subgroup = sgCell.text().trim();
            // У строки подгруппы может быть собственное время
            let subTime = time;
            const subTimeText = subCells.length ? $(subCells[0]).text().trim() : '';
            if (/^\s*\d{1,2}[:.]\d{2}\s*[-–]\s*\d{1,2}[:.]\d{2}\s*$/.test(subTimeText)) {
              subTime = subTimeText;
            }
            let subTeacher = '';
            const subTeacherSpan = subRow.find('.teacher, .teacher.dd, span[class*="teacher"]');
            if (subTeacherSpan.length) subTeacher = subTeacherSpan.first().text().trim();
            if (!subTeacher) subTeacher = extractTeacherFromCell(subRow, $);
            const lastCell = subCells.last();
            const subRoom = lastCell.length
              ? extractRoomNumbers(lastCell.text().replace(/<!--[\s\S]*?-->/g, '').trim()).join(', ')
              : '';
            // Недели подгруппы: свои берём, только если там есть цифры.
            // Иначе (пустой `week[i]:`) наследуются недели родительской
            // строки — на сайте БГЭУ они указаны один раз сверху, например
            // 13:05-14:25 (1-16), а у строк подгрупп их нет.
            let subWeeks = weeks;
            const cellHtml = lastCell.length ? lastCell.html() : '';
            const wm = cellHtml && cellHtml.match(/week\[i\]:\s*([\d\s,–—\-]+)/i);
            if (wm && /\d/.test(wm[1])) subWeeks = '(' + wm[1].trim() + ')';
            if (subCells.length >= 3) {
              const sc1Text = $(subCells[1]).text().trim();
              if (/\d/.test(sc1Text) && /^\s*\(?[\d\s,–—\-.]+\)?\s*$/.test(sc1Text)) {
                subWeeks = sc1Text;
              }
            }
            subgroupLessons.push({
              day: currentDay || "Вне сетки", time: subTime, weeks: subWeeks, subject, type,
              teacher: (subTeacher || teacher).trim(), room: subRoom, isTeacher: false, subgroup
            });
          }
        }

        if (subgroupLessons.length) {
          subgroupLessons.forEach(l => lessons.push(l));
        } else if (subject && time) {
          room = rightCell.length ? extractRoomNumbers(rightCell.text()).join(', ') : '';
          lessons.push({ day: currentDay || "Вне сетки", time, weeks, subject, type, teacher, room, isTeacher: false });
        }
      }
    }
  }

  const subjectTypeSubgroupGroups = {};
  lessons.forEach(l => {
    const subj = (l.subject || '').trim();
    const type = (l.type || '').trim() || 'без типа';
    const subgroup = (l.subgroup || '').trim() || 'общая';
    const bucketKey = `${subj}::${type}::${subgroup}`;
    if (!subjectTypeSubgroupGroups[bucketKey]) subjectTypeSubgroupGroups[bucketKey] = [];
    subjectTypeSubgroupGroups[bucketKey].push(l);
  });
  const dayOrder = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
  Object.values(subjectTypeSubgroupGroups).forEach(group => {
    group.sort((a, b) => {
      const aDayIdx = dayOrder.indexOf((a.day || '').toLowerCase().trim());
      const bDayIdx = dayOrder.indexOf((b.day || '').toLowerCase().trim());
      if (aDayIdx !== bDayIdx) return aDayIdx - bDayIdx;
      return (a.time || '').localeCompare(b.time || '');
    });
    group.forEach((l, idx) => { l._subjectOrderIndex = idx + 1; });
  });

  return { semesterStartDate, currentSemesterWeek, lessons, isSchedulePage: true };
}

const GROUP_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 часа, как в рабочей версии на Render: меньше долбим БГЭУ — меньше 500
/* ===== Offline fallback из полного кэша (работа при недоступности БГЭУ) ===== */
const RU_WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

function normalizeMatch(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/\s*([.|])\s*/g, '$1').trim();
}
function parseIsoDate2(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}
function mondayOf(iso) {
  const d = parseIsoDate2(iso);
  if (!d) return null;
  const dow = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
}
function toIso(d) { return d ? d.toISOString().slice(0, 10) : null; }
function weekNoOf(dateIso, semesterMondayIso) {
  const monday = mondayOf(dateIso);
  const sem = parseIsoDate2(semesterMondayIso);
  if (!monday || !sem) return 1;
  return Math.max(1, Math.floor((monday - sem) / 86400000 / 7) + 1);
}
// Совпадение ФИО преподавателя: фамилия + первые буквы имени/отчества.
function teacherMatchCache(cacheTeacher, query) {
  const a = normalizeMatch(cacheTeacher);
  const b = normalizeMatch(query);
  if (!a || !b) return false;
  if (a === b) return true;
  const aParts = a.split(' ').filter(Boolean);
  const bParts = b.split(' ').filter(Boolean);
  if (!aParts.length || !bParts.length || aParts[0] !== bParts[0]) return false;
  const shared = Math.min(aParts.length, bParts.length) - 1;
  for (let i = 1; i <= shared; i++) {
    const aInit = aParts[i].replace(/\./g, '');
    const bInit = bParts[i].replace(/\./g, '');
    if (aInit && bInit && aInit[0] !== bInit[0]) return false;
  }
  return true;
}
function normalizeGroupTextCache(s) {
  return normalizeMatch(s).split('|').map(p => p.trim()).filter(Boolean).join(' | ');
}

// Построение расписания группы/преподавателя из полного кэша (формат parseScheduleHtml) либо null.
function buildFullCacheSchedule(groupText, teacherName) {
  const src = fullScheduleCache || [];
  if (!src.length) return null;
  const ng = groupText ? normalizeGroupTextCache(groupText) : '';
  const nt = teacherName ? normalizeMatch(teacherName) : '';
  if (!ng && !nt) return null;

  let matches;
  if (ng) {
    matches = src.filter(p => normalizeGroupTextCache(p.groupText) === ng);
    if (!matches.length) {
      // Разные написания группы: «26 ДЭА-1 | специализация» vs «26 ДЭА-1».
      const [code, spec] = ng.split('|').map(t => t.trim());
      if (code) {
        matches = src.filter(p => {
          const [pCode, pSpec] = normalizeGroupTextCache(p.groupText).split('|').map(t => t.trim());
          if (pCode !== code) return false;
          if (!spec || !pSpec) return true;
          return pSpec === spec;
        });
      }
    }
  } else if (nt) {
    matches = src.filter(p => teacherMatchCache(p.teacher, nt));
  }
  if (!matches || !matches.length) return null;

  const datesAll = [];
  for (const p of matches) for (const d of (p.dates || [])) datesAll.push(d);
  datesAll.sort();
  // Начало семестра НЕЛЬЗЯ брать из первой найденной даты пар: у конкретного
  // преподавателя (или группы) занятия могут начинаться не с 1-й недели
  // (например, только с 5-й), и тогда weekNoOf() отсчитывает недели от этой
  // даты. Клиент же считает номер недели от semesterStartDate, который приходит
  // в ответе (а сентябрьскую дату нормализует к 1 сентября). Из-за рассинхрона
  // номера недель не совпадали: пары «уезжали» на чужие дни, а с середины
  // семестра (когда номера недель у клиента превышали максимальные в ответе)
  // расписание в режиме преподавателя вообще переставало отображаться.
  // Берём то же академическое начало семестра, что и живой парсинг БГЭУ.
  const semesterStart = normalizeSemesterStartDate(getAcademicSemesterStart(null));
  const semesterMonday = toIso(mondayOf(semesterStart))
    || (datesAll.length ? toIso(mondayOf(datesAll[0])) : null);

  const byKey = new Map();
  for (const p of matches) {
    const dateList = (Array.isArray(p.dates) ? p.dates : []).sort();
    if (!dateList.length) continue;
    for (const d of dateList) {
      const dt = parseIsoDate2(d);
      if (!dt) continue;
      const day = RU_WEEKDAYS[dt.getUTCDay()];
      const wk = semesterMonday ? weekNoOf(d, semesterMonday) : 1;
      const key = [day, (p.subject || '').trim(), (p.type || '').trim(), (p.teacher || '').trim(), (p.audience || '').trim(), (p.startTime || '').trim(), (p.subgroup || '').trim()].join('¦');
      let card = byKey.get(key);
      if (!card) {
        card = {
          day,
          subject: (p.subject || '').trim(),
          type: (p.type || '').trim(),
          teacher: (p.teacher || '').trim(),
          room: (p.audience || '').trim(),
          startTime: (p.startTime || '').trim(),
          endTime: (p.endTime || '').trim(),
          subgroup: (p.subgroup || '').trim(),
          weeksSet: new Set(),
          groups: new Set()
        };
        byKey.set(key, card);
      }
      card.weeksSet.add(wk);
      if (p.groupText) card.groups.add(normalizeGroupTextCache(p.groupText));
    }
  }
  if (!byKey.size) return null;

  const dayOrder = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
  const lessons = [];
  for (const card of byKey.values()) {
    const weeksArr = [...card.weeksSet].sort((a, b) => a - b);
    // Больше 30 недель — вырождается во «все недели».
    const weeksStr = weeksArr.length && weeksArr.length <= 30 ? '(' + weeksArr.join(',') + ')' : '';
    const teacherField = nt && card.groups.size ? [...card.groups].join(', ') : card.teacher;
    lessons.push({
      day: card.day,
      time: card.startTime + (card.endTime && card.endTime !== card.startTime ? '-' + card.endTime : ''),
      weeks: weeksStr,
      subject: card.subject,
      type: card.type,
      teacher: teacherField,
      room: card.room,
      subgroup: card.subgroup,
      groups: [...card.groups],
      isTeacher: !!nt
    });
  }
  lessons.sort((a, b) => {
    const di = dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day);
    return di !== 0 ? di : (a.time || '').localeCompare(b.time || '');
  });

  return {
    semesterStartDate: semesterStart || semesterMonday || (datesAll.length ? datesAll[0] : null),
    currentSemesterWeek: 1,
    lessons,
    isSchedulePage: true,
    isFallback: true,
    isFullCacheFallback: true,
    savedAt: fullScheduleUpdatedAt || Date.now(),
    error: null
  };
}

async function getScheduleWithCache(cacheKey, bodyString, fallback = {}, proxyQuery = null, opts = {}) {
  const cached = fileGetCache(cacheKey);
  const now = Date.now();
  // Отравленный кэш (пустые lessons, записанные из пустого ответа зеркала) —
  // это НЕ «пустое расписание», а признак сбоя. Игнорируем его и идём за
  // живыми данными/фолбэком, иначе пустота раздавалась бы как валидная 2 часа (TTL).
  const cachedLessons = cached && cached.value && cached.value.lessons;
  const cachedEmpty = !Array.isArray(cachedLessons) || cachedLessons.length === 0;
  const forceLive = !!(opts && opts.forceLive);
  // Полный обход аудиторий (buildFullSchedule) всегда идёт за ЖИВЫМИ данными,
  // игнорируя 2-часовой TTL группового кэша. Иначе обход собирал бы смесь
  // свежих и 2-часовых stale-ответов: изменения на БГЭУ (а в начале семестра
  // их вносят ежедневно) попадали бы в режим аудитории с задержкой и
  // кусками — одни группы свежие, другие старые. Именно так 01.10 пропала
  // пара 9:45 в 1/706 на хостинге: групповой кэш 23 ДФТ-1 был ещё в TTL,
  // посчитался «живым» (isFallback:false) и перезаписал полный кэш старьём
  // без 5-й недели. Интерактивные запросы (/api/schedule) TTL используют как раньше.
  if (!forceLive && cached && !cachedEmpty && (now - cached.updatedAt < GROUP_CACHE_TTL)) return { ...cached.value, isFallback: false, _isLive: false };
  try {
    // Рабочий принцип со старой версии (Render): POST с телом в win1251.
    // bodyString уже содержит __act + faculty/form/course/group (или tid/taid/sid/tname) + period.
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
    // Страница без таблицы расписания — это НЕ «пустое расписание», а признак
    // того, что БГЭУ вернул ошибку/заглушку (404, «обслуживание» и т.п.).
    // В этом случае не перезаписываем хороший кэш и переходим к fallback.
    if (!parsedData.isSchedulePage) {
      throw new Error('BSEU вернул страницу без таблицы расписания');
    }
    fileSetCache(cacheKey, parsedData);
    return { ...parsedData, isFallback: false, _isLive: true };
  } catch (error) {
    logParser(`[Group Schedule] Failed to fetch for ${cacheKey}: ${error.message}. Returning cached fallback if available.`, 'WARN');
    if (/403/.test(error.message)) {
      noteBseuBlocked();
      if (RENDER_PROXY_BASE) {
        try {
          // Для преподавателей tname в body закодирован в win1251 — его не восстановить
          // надёжно, поэтому вызывающие передают исходные tid/taid/sid/tname 4-м параметром.
          let pf = null;
          if (proxyQuery && proxyQuery.tid && proxyQuery.taid && proxyQuery.sid && proxyQuery.tname) {
            pf = { tid: proxyQuery.tid, taid: proxyQuery.taid, sid: proxyQuery.sid, tname: proxyQuery.tname };
          } else {
            // bodyString — POST-тело вида __act=...&faculty=..&form=..&course=..&group=..&period=3
            const q = new URLSearchParams(bodyString);
            const g = { faculty: q.get('faculty'), form: q.get('form'), course: q.get('course'), group: q.get('group') };
            if (g.faculty && g.form && g.course && g.group) pf = g;
          }
          if (pf) {
            const data = await fetchJsonViaProxy('/api/schedule', pf);
            if (data && Array.isArray(data.lessons)) {
              data.lessons = sanitizeProxyLessons(data.lessons);
              // Пустой ответ зеркала — это НЕ «пустое расписание», а признак
              // того, что у зеркала нет данных (как сейчас по преподавателям:
              // зеркало отдаёт lessons:[]). Такой ответ не кэшируем и отдаём
              // локальный полный кэш, если он есть.
              if (data.lessons.length === 0) {
                logParser(`[Proxy] ${cacheKey} mirror returned EMPTY lessons — trying local fallback, NOT caching.`, 'WARN');
                if (cached && !cachedEmpty) return { ...cached.value, isFallback: true, savedAt: cached.updatedAt };
                const fbEmpty = buildFullCacheSchedule(fallback.groupText, fallback.teacherName);
                if (fbEmpty) {
                  logParser(`[FullCacheFallback] ${cacheKey} served from full schedule cache (${fbEmpty.lessons.length} lessons) over empty mirror.`, 'INFO');
                  return fbEmpty;
                }
                return { ...data, isFallback: true, viaProxy: true, degraded: true, degradedReason: 'mirror_empty' };
              }
              // Защита от регрессии зеркала: если для ГРУППОВОГО запроса зеркало
              // вернуло пары, но ни одной непустой subgroup — его парсер устарел
              // (см. buildTag в /api/status зеркала). Такой ответ не кэшируем,
              // чтобы не перезаписать валидный кэш залипшими данными без подгрупп.
              const isGroupQuery = !!(pf.faculty && pf.form && pf.course && pf.group);
              const hasSubgroup = data.lessons.some(l => l && typeof l.subgroup === 'string' && l.subgroup.trim() !== '');
              if (isGroupQuery && data.lessons.length > 0 && !hasSubgroup) {
                logParser(`[Proxy] ${cacheKey} mirror returned ${data.lessons.length} lessons with 0 subgroups — NOT caching (stale mirror parser?).`, 'WARN');
                if (cached && Array.isArray(cached.value && cached.value.lessons) &&
                    cached.value.lessons.some(l => l && typeof l.subgroup === 'string' && l.subgroup.trim() !== '')) {
                  return { ...cached.value, isFallback: true, savedAt: cached.updatedAt };
                }
                return { ...data, isFallback: true, viaProxy: true, degraded: true, degradedReason: 'mirror_no_subgroups' };
              }
              fileSetCache(cacheKey, data);
              logParser(`[Proxy] ${cacheKey} served via Render mirror.`, 'INFO');
              return { ...data, isFallback: true, viaProxy: true };
            }
            throw new Error('Bad proxy schedule payload');
          }
        } catch (pe) {
          logParser(`[Proxy] Schedule via mirror failed: ${pe.message}`, 'WARN');
        }
      }
    }
    if (cached && !cachedEmpty) return { ...cached.value, isFallback: true, savedAt: cached.updatedAt };
    // Если БГЭУ недоступен и кэша расписания нет (или кэш отравлен пустотой) —
    // пробуем собрать расписание из полного кэша (fullScheduleCache.json).
    const fb = buildFullCacheSchedule(fallback.groupText, fallback.teacherName);
    if (fb) {
      logParser(`[FullCacheFallback] ${cacheKey} served from full schedule cache (${fb.lessons.length} lessons).`, 'INFO');
      return fb;
    }
    return { semesterStartDate: null, currentSemesterWeek: 1, lessons: [], isSchedulePage: false, isFallback: true, error: error.message };
  }
}

// ===== Serve static files =====
app.use((req, res, next) => {
  const path = req.path.toLowerCase();
  if (path.endsWith('.html') || path.endsWith('.js') || path === '/sw.js') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});
app.use(express.static(__dirname));

// ===== Список аудиторий (реальные номера "корпус/аудитория" из полного расписания BSEU) =====
// ===== Расписание аудитории: полная копия расписания БГЭУ =====
const BSEU_FACULTIES = ["12","14","13","7","2","8","534","11","263","18","129","450","530","531","497","535","432"];
const FULL_SCHEDULE_INTERVAL = 20 * 60 * 60 * 1000; // Страховка: основной график — рестарт + nightly 01:00 Минск
const FULL_SCHEDULE_CACHE_VERSION = 7;
let fullScheduleCache = null;
let fullScheduleUpdatedAt = 0;
let fullScheduleBuilding = false;
let fullSchedulePromise = null;
let fullScheduleError = null; // Сохраняем ошибку сборки для отображения статуса
let fullScheduleStartedAt = 0;

// Кэш расписания по аудиториям: { "2/301": [{ subject, type, teacher, groupText, startTime, endTime, dates, audience, audienceTokens }, ...] }
let audienceScheduleCache = {};
let audienceScheduleUpdatedAt = 0;

// --- Загрузка кэша и метки времени из файлов ---
const CACHE_FILE = path.join(BASE_DATA_DIR, 'fullScheduleCache.json');
const LAST_FULL_UPDATE_FILE = path.join(BASE_DATA_DIR, 'last_full_update.txt');

function getLastFullUpdateTimestamp() {
  try {
    if (fs.existsSync(LAST_FULL_UPDATE_FILE)) {
      const raw = fs.readFileSync(LAST_FULL_UPDATE_FILE, 'utf-8').trim();
      const ts = parseInt(raw, 10);
      if (!isNaN(ts) && ts > 0) return ts;
    }
  } catch (e) {}
  return fullScheduleUpdatedAt || 0;
}

function setLastFullUpdateTimestamp(ts) {
  fullScheduleUpdatedAt = ts;
  try {
    fs.writeFileSync(LAST_FULL_UPDATE_FILE, String(ts), 'utf-8');
  } catch (e) {}
}

// Версия кэша, лежащего на диске (null — файла нет или он повреждён).
function readCacheFileVersion() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const d = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return d.fullScheduleCacheVersion;
  } catch (e) {
    return null;
  }
}

try {
  if (fs.existsSync(CACHE_FILE)) {
    const cachedData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    // Формат JSON одинаковый для всех версий, поэтому старый по номеру файл
    // всё равно загружаем — это последние известные хорошие данные. Версия
    // будет приведена к актуальной при следующем ЖИВОМ обходе (см. buildFullSchedule).
    if (Array.isArray(cachedData.fullScheduleCache)) {
      fullScheduleCache = cachedData.fullScheduleCache;
      fullScheduleUpdatedAt = cachedData.updatedAt || getLastFullUpdateTimestamp();
      audienceScheduleCache = cachedData.audienceScheduleCache || {};
      audienceScheduleUpdatedAt = cachedData.audienceScheduleUpdatedAt || 0;
      if (cachedData.fullScheduleCacheVersion !== FULL_SCHEDULE_CACHE_VERSION) {
        logParser(`[Cache] Loaded cache with OLD version ${cachedData.fullScheduleCacheVersion} (current: ${FULL_SCHEDULE_CACHE_VERSION}); file will be re-saved on the next live crawl.`, 'WARN');
      } else {
        logParser(`[Cache] Loaded cache from file: ${CACHE_FILE} (${fullScheduleCache.length} items)`);
      }
    } else {
      logParser(`[Cache] Cache file has no valid fullScheduleCache array; ignoring: ${CACHE_FILE}`, 'WARN');
    }
  }
} catch (e) {
  logParser(`[Cache] Could not load cache file: ${e.message}`, 'WARN');
}

async function getFacultyGroups(faculty) {
  const forms = await fetchBseuList("__id.22.main.inpFldsA.GetForms", { faculty });
  if (!Array.isArray(forms)) return [];
  // Форма 10 (группы иностранного языка) не возвращается API GetForms, но
  // существует для каждого факультета. Добавляем её вручную, чтобы не
  // пропустить подгруппы при построении режима аудитории.
  const formValues = new Set(forms.map(f => String(f.value)));
  if (!formValues.has('10')) {
    forms.push({ value: '10', text: 'Иностранный язык' });
  }
  // Последовательно, как в рабочей версии на Render: не hammerим БГЭУ параллельными пачками.
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
  clean.split(/[,;]+/).forEach(part => {
    part = part.trim();
    if (!part) return;
    const rangeMatch = part.match(/^(\d+)\s*[-–—]\s*(\d+)/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (!Number.isNaN(start) && !Number.isNaN(end) && start <= end) {
        for (let i = start; i <= end; i++) result.push(i);
      }
    } else {
      const num = Number(part);
      if (!Number.isNaN(num)) result.push(num);
    }
  });
  return result;
}

function dateFromLessonDay(day) {
  const match = String(day || '').match(/\((\d{1,2})\.(\d{1,2})\.(\d{4})\)/);
  if (!match) return null;
  const [, dayNumber, monthNumber, year] = match;
  return `${year}-${String(monthNumber).padStart(2, '0')}-${String(dayNumber).padStart(2, '0')}`;
}

function cleanLessonDay(day) {
  return String(day || '').replace(/\s*\(\d{1,2}\.\d{1,2}\.\d{4}\)\s*$/, '').trim();
}

function extractRoomNumbers(room) {
  const value = String(room || '')
    .replace(/\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}/g, ' ')
    .trim();
  const matches = value.match(/\d+\s*\/\s*\d+[А-ЯЁа-яёA-Za-z]*/g) || [];
  return [...new Set(matches.map(match => match.replace(/\s*\/\s*/g, '/')))];
}

function extractRoomNumber(room) {
  return extractRoomNumbers(room)[0] || '';
}

// Чистит уроки, пришедшие со старого зеркала (Render): его парсер для таблиц
// без колонки недель клал текст пары в `weeks`, а время вклеивал в `room`
// (напр. room="14:35-15:558/24", weeks="Криминалистика (Лекции) , ...").
// Правила только сужают мусор к виду актуального парсера, корректные данные
// не меняют: room вытягиваем «корпус/аудитория» (если не нашлось —
// оставляем как есть, чтобы не потерять номера без слэша), нечисловой мусор
// в weeks сбрасываем в "" (как у актуального парсера для таких пар).
function sanitizeProxyLessons(lessons) {
  if (!Array.isArray(lessons)) return lessons;
  return lessons.map(l => {
    if (!l || typeof l !== 'object') return l;
    const out = { ...l };
    if (typeof out.room === 'string' && out.room) {
      const cleaned = extractRoomNumbers(out.room).join(', ');
      if (cleaned) out.room = cleaned;
    }
    if (typeof out.weeks === 'string' && out.weeks && parseWeeks(out.weeks).length === 0) {
      out.weeks = '';
    }
    return out;
  });
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

// Вспомогательная функция нормализации названия аудитории: "  2 / 301 " -> "2/301",
// "2/301Б" -> "2/301б". Пробелы вокруг слэша убираются, регистр понижается —
// благодаря этому запрос "1/706" совпадает с "1/706", "1 / 706" и "1/706а".
function normalizeRoomName(room) {
  return String(room || '')
    .trim()
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// Историческое имя (использовалось до появления normalizeRoomName) — оставлено
// как алиас, чтобы не править все существующие вызовы.
function normalizeAudienceRoom(room) {
  return normalizeRoomName(room);
}

function normalizeAudienceNumber(room) {
  const normalized = normalizeAudienceRoom(room);
  const slashIndex = normalized.lastIndexOf('/');
  return (slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized).trim();
}

// Разбивает номер аудитории на цифровую часть и буквенный суффикс.
// БГЭУ использует буквы для подразделов одного и того же помещения
// ("2/301б", "3/136а") — это одна и та же аудитория с номером "301"/"136".
function splitAudienceNumber(room) {
  const normalized = normalizeAudienceNumber(room);
  const m = String(normalized).match(/^(\d+)\s*([А-ЯЁа-яёA-Za-z]*)$/);
  return {
    base: m ? m[1] : normalized,
    letter: (m && m[2]) ? m[2] : ''
  };
}

// Сравнение номеров аудиторий с учётом буквенных суффиксов. Если пользователь
// ввёл номер без буквы ("301"), пары из аудитории "2/301б" тоже должны
// находиться (это то же помещение). Если пользователь явно указал букву
// ("301б") — требуем совпадения по букве, чтобы не подмешивать пары из
// соседней аудитории без буквенного суффикса.
function audienceNumberEquals(a, b) {
  const A = splitAudienceNumber(a);
  const B = splitAudienceNumber(b);
  if (A.base !== B.base) return false;
  if (A.letter && B.letter && A.letter !== B.letter) return false;
  return true;
}

// Сравнение полных "корпус/аудитория" с учётом буквенных суффиксов.
// Корпус (если он указан в запросе) должен совпадать точно, номер
// сравнивается через audienceNumberEquals.
function audienceRoomEquals(a, b) {
  const A = normalizeAudienceRoom(a);
  const B = normalizeAudienceRoom(b);
  const ia = A.lastIndexOf('/');
  const ib = B.lastIndexOf('/');
  const buildingA = ia >= 0 ? A.slice(0, ia) : '';
  const buildingB = ib >= 0 ? B.slice(0, ib) : '';
  if (buildingA && buildingB && buildingA !== buildingB) return false;
  return audienceNumberEquals(
    ia >= 0 ? A.slice(ia + 1) : A,
    ib >= 0 ? B.slice(ib + 1) : B
  );
}

// Возвращает только те аудитории пары, которые реально совпали с запросом.
// Нужно, чтобы в режиме аудитории для "2/300" не показывались все комнаты
// исходной строки BSEU ("2/300, 2/405"), а только запрошенная "2/300".
// Сравнение с учётом буквенных суффиксов: запрос "2/300" находит и "2/300а".
function matchedRoomsOf(audience, hasSlash, targetRooms, queryTokens) {
  const rooms = extractRoomNumbers(audience);
  if (!rooms.length) return [];
  if (hasSlash) {
    return rooms.filter(r => targetRooms.some(target => audienceRoomEquals(target, r)));
  }
  return rooms.filter(r => targetRooms.some(target => audienceNumberEquals(target, r)));
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

// Сбор расписаний всех преподавателей: имена берём из свежесобранных групп
// и существующего полного кэша, id резолвим поиском по фамилии через БГЭУ
// (один поисковый запрос на фамилию). Кэш teacher:* лежит в .cache на хостинге.
async function buildTeacherSchedules(fetchedGroups) {
  try {
    const names = new Map(); // normFull -> display
    const addName = (t) => {
      const s = String(t || '').trim();
      if (!s) return;
      const n = normalizeMatch(s);
      if (!n) return;
      if (!names.has(n)) names.set(n, s);
    };
    (fetchedGroups || []).forEach(({ sched }) => (sched.lessons || []).forEach(l => addName(l.teacher)));
    (fullScheduleCache || []).forEach(p => addName(p.teacher));
    const bySurname = new Map();
    for (const [norm, display] of names) {
      const sur = norm.split(' ')[0];
      if (!sur) continue;
      if (!bySurname.has(sur)) bySurname.set(sur, []);
      bySurname.get(sur).push([norm, display]);
    }
    const surnames = [...bySurname.keys()];
    if (!surnames.length) return;
    logParser(`[Teachers] Starting teacher crawl for ~${names.size} teachers (${surnames.length} surnames)...`, 'INFO');
    const CONC = 8;
    let ok = 0, total = 0;
    for (let i = 0; i < surnames.length; i += CONC) {
      // Через прокси бан не страшен — останавливаемся только если зеркала нет.
      if (isBseuBlocked() && !RENDER_PROXY_BASE) { logParser('[Teachers] Stopped: BSEU block cooldown active.', 'WARN'); break; }
      const batch = surnames.slice(i, i + CONC);
      await Promise.allSettled(batch.map(async (sur) => {
        try {
          const found = await fetchBseuList('__id.24.main.TSchedA.getTeachers', { tname: sur });
          if (!Array.isArray(found)) return;
          for (const [norm, display] of bySurname.get(sur)) {
            total++;
            const hit = found.find(x => teacherMatchCache(x.tname, display));
            if (!hit || !hit.tid || !hit.taid || !hit.sid || !hit.tname) continue;
            const tid = String(hit.tid), taid = String(hit.taid), sid = String(hit.sid), tname = hit.tname;
            const body = `__act=tid.${tid.length}.${tid}taid.${taid.length}.${taid}sid.${sid.length}.${sid}__id.22.main.TSchedA.GetTSched__sp.8.tresults__fp.4.main&tname=${toWin1251Url(tname)}&period=3`;
            try {
              const sched = await getScheduleWithCache(`teacher:${tid}:${taid}:${sid}:${tname}`, body, { teacherName: tname }, { tid, taid, sid, tname });
              if (sched && Array.isArray(sched.lessons) && sched.lessons.length && (!sched.isFallback || sched.viaProxy)) ok++;
            } catch (e) {}
          }
        } catch (e) {}
      }));
      if (i + CONC < surnames.length) await new Promise(r => setTimeout(r, 500));
    }
    logParser(`[Teachers] Done: ${ok}/${total} live teacher schedules cached.`, 'INFO');
  } catch (e) {
    logParser(`[Teachers] Crawl error: ${e.message}`, 'ERROR');
  }
}

async function buildFullSchedule() {
  if (fullScheduleBuilding) return fullSchedulePromise;
  fullScheduleBuilding = true;
  fullScheduleError = null;
  fullScheduleStartedAt = Date.now();
  fullSchedulePromise = (async () => {
    logParser('[FullSchedule] Starting complete university schedule background crawl...', 'INFO');
    const t0 = Date.now();
    let allGroups = [];
    try {
      const facResults = await Promise.allSettled(BSEU_FACULTIES.map(async (fac) => {
        try {
          const gList = await getFacultyGroups(fac);
          return gList;
        } catch (e) {
          logParser(`[FullSchedule] Faculty ${fac} group list error: ${e.message}`, 'WARN');
          return [];
        }
      }));
      for (const r of facResults) {
        if (r.status === 'fulfilled' && Array.isArray(r.value)) {
          allGroups = allGroups.concat(r.value);
        }
      }
    } catch (e) {
      logParser(`[FullSchedule] Error collecting groups: ${e.message}`, 'WARN');
    }

    if (allGroups.length === 0) {
      logParser('[FullSchedule] Failed to fetch groups (BSEU website unavailable or down). Preserving existing cache untouched.', 'WARN');
      fullScheduleBuilding = false;
      return fullScheduleCache;
    }

    // Ограничиваем параллелизм, чтобы полный обход завершался до таймаута
    // фонового процесса, но не создавал чрезмерную нагрузку на BSEU.
    const CONCURRENCY = 15;
    const all = [];
    const fetched = [];
    const newAudienceCache = {};
    let failedGroups = 0;
    let liveCount = 0; // сколько расписаний получено ЖИВЬЁМ от БГЭУ (не из кэша/ошибок)
    const failedGroupItems = [];

    for (let i = 0; i < allGroups.length; i += CONCURRENCY) {
      const batch = allGroups.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map(async (g) => {
        try {
          const body = `__act=__id.25.main.inpFldsA.GetSchedule__sp.7.results__fp.4.main&faculty=${g.faculty}&form=${g.form}&course=${g.course}&group=${g.group}&period=3`;
          const gkey = `group:${g.faculty}:${g.form}:${g.course}:${g.group}`;
          // forceLive: полный обход всегда ходит за живыми данными (см. выше),
          // иначе 2-часовой TTL подсовывал stale-расписания как «живые».
          const sched = await getScheduleWithCache(gkey, body, { groupText: g.groupText }, null, { forceLive: true });
          return { sched, g };
        } catch (e) {
          failedGroups++;
          failedGroupItems.push(g);
          logParser(`[FullSchedule] Group ${g.faculty}/${g.form}/${g.course}/${g.group} failed: ${e.message}`, 'WARN');
          return null;
        }
      }));
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          const s = r.value.sched;
          // Пустой lessons при живом ответе — тоже сбой (БГЭУ отдал страницу
          // без таблицы, а фолбэка в кэше не было). Такую группу повторяем,
          // иначе она тихо выпадет из режима аудитории (как 23 ДФТ-1 01.10).
          const lessons = s && Array.isArray(s.lessons) ? s.lessons : [];
          if (!lessons.length) {
            failedGroups++;
            failedGroupItems.push(r.value.g);
            logParser(`[FullSchedule] Group ${r.value.g.faculty}/${r.value.g.form}/${r.value.g.course}/${r.value.g.group} returned 0 lessons — queued for retry.`, 'WARN');
            continue;
          }
          if (s._isLive || s.viaProxy || !s.isFallback) liveCount++;
          fetched.push(r.value);
        }
      }
      // Небольшая задержка между батчами, чтобы не загружать сервер BSEU (как в рабочей версии на Render).
      if (i + CONCURRENCY < allGroups.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // Повторяем только неудачные группы перед формированием общего кэша.
    // Иначе временный сбой BSEU незаметно удаляет их пары из режима аудитории.
    // Сюда попадают и исключения, и группы с 0 lessons (пустой ответ БГЭУ
    // без фолбэка) — их тоже повторяем живым запросом.
    if (failedGroupItems.length) {
      // Небольшая пауза перед ретраями, чтобы транзитный сбой БГЭУ успел пройти.
      await new Promise(resolve => setTimeout(resolve, 2000));
      const retryResults = await Promise.allSettled(failedGroupItems.map(async (g) => {
        const body = `__act=__id.25.main.inpFldsA.GetSchedule__sp.7.results__fp.4.main&faculty=${g.faculty}&form=${g.form}&course=${g.course}&group=${g.group}&period=3`;
        const gkey = `group:${g.faculty}:${g.form}:${g.course}:${g.group}`;
        return { sched: await getScheduleWithCache(gkey, body, { groupText: g.groupText }, null, { forceLive: true }), g };
      }));
      let recovered = 0;
      for (const result of retryResults) {
        if (result.status === 'fulfilled' && result.value) {
          const s = result.value.sched;
          const lessons = s && Array.isArray(s.lessons) ? s.lessons : [];
          if (!lessons.length) continue; // повтор тоже пустой — группу спасёт слияние со старым кэшем ниже
          if (s._isLive || s.viaProxy || !s.isFallback) liveCount++;
          fetched.push(result.value);
          recovered++;
        }
      }
      logParser(`[FullSchedule] Retry finished: ${recovered}/${failedGroupItems.length} failed groups recovered.`, 'INFO');
    }

    // Группы, по которым БГЭУ не отдал ни одной пары даже после ретрая.
    // Причина почти всегда одна: у группы просто НЕТ расписания на сайте
    // (заочная / заочная сокр. / дистанционная / подготовительное отделение /
    // аспирантура / соискательство / языковые подгруппы, а также магистратура
    // без опубликованных занятий). Такие группы физически не могут попасть в
    // режим аудитории — у них нет аудиторных пар. Печатаем их список в лог,
    // чтобы было видно: обход ничего не «потерял», у БГЭУ этих данных просто нет.
    const groupKeyOf = g => `${g.faculty}:${g.form}:${g.course}:${g.group}`;
    const fetchedKeys = new Set(fetched.map(f => groupKeyOf(f.g)));
    const noDataGroups = allGroups.filter(g => !fetchedKeys.has(groupKeyOf(g)));
    if (noDataGroups.length) {
      logParser(`[FullSchedule] ${noDataGroups.length} groups have no schedule on BSEU (empty page): ` +
        noDataGroups.map(g => g.groupText || groupKeyOf(g)).join(' | '), 'WARN');
    }

    if (fetched.length === 0) {
      logParser('[FullSchedule] No group schedules retrieved from BSEU. Preserving existing cache untouched.', 'WARN');
      fullScheduleBuilding = false;
      return fullScheduleCache;
    }

    // Все ответы пришли из кэша или ошибок — ни одного ЖИВОГО расписания
    // от БГЭУ не получено. Это значит, что подсистема расписания БГЭУ
    // фактически недоступна (404, таймауты и т.п.). Сохраняем кэш как есть
    // и НЕ обновляем метку last_full_update.txt: иначе система решит, что
    // данные свежие, и не станет срочно обновляться после восстановления БГЭУ.
    if (liveCount === 0) {
      logParser('[FullSchedule] No LIVE data from BSEU (all responses served from cache or errors). Preserving existing cache untouched and NOT refreshing last-update timestamp.', 'WARN');
      fullScheduleBuilding = false;
      return fullScheduleCache;
    }

    logParser(`[FullSchedule] Group crawl finished: ${fetched.length}/${allGroups.length} groups with schedule, ${failedGroups} empty/failed, ${noDataGroups.length} without schedule on BSEU.`, 'INFO');

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
        let weeks = parseWeeks(l.weeks);
        const dates = [];
        const explicitDate = dateFromLessonDay(l.day);
        if (explicitDate) {
          dates.push(explicitDate);
        } else {
          if (!weeks.length) weeks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
          for (const w of weeks) {
            const d = lessonDate(semStart, cleanLessonDay(l.day), w);
            if (d) dates.push(d);
          }
        }
        if (!dates.length) continue;
        if (!l.room) continue;
        const roomStr = String(l.room).trim();
        const roomParts = extractRoomNumbers(roomStr);
        const allValid = roomParts.every(part => /\d/.test(part));
        if (!allValid) continue;
        const [start, end] = String(l.time || '').split(/[-–]/).map(s => s.trim());

        for (const singleRoom of roomParts) {
          const entry = {
            audience: singleRoom,
            audienceTokens: audienceTokens(singleRoom),
            dates,
            subject: l.subject,
            type: l.type,
            teacher: l.teacher || '',
            groupText: g ? g.groupText : (l.group || ''),
            startTime: start || '',
            endTime: end || '',
            subgroup: l.subgroup || ''
          };
          all.push(entry);
          if (!newAudienceCache[singleRoom]) newAudienceCache[singleRoom] = [];
          newAudienceCache[singleRoom].push(entry);
        }
      }
    }

    if (all.length === 0 && fullScheduleCache) {
      // Обход завершился без единой пары (БГЭУ вернул страницы без расписания).
      // Ни в коем случае не затираем существующий кэш аудиторий пустым
      // массивом: «пусто» здесь — следствие сбоя, а не реальная пустота.
      logParser('[FullSchedule] No lessons collected (BSEU returned pages without schedule rows). Preserving existing cache untouched.', 'WARN');
      fullScheduleBuilding = false;
      return fullScheduleCache;
    }

    // Слияние со старым кэшем: группы, которые в этом обходе не дали НИ ОДНОЙ
    // пары (живой запрос упал и ретраи не помогли, фолбэка в .cache не было),
    // переносим из предыдущего полного кэша как есть. Иначе один транзитный
    // сбой БГЭУ тихо удалял бы целую группу из режима аудитории (01.10 так
    // пропала вся 23 ДФТ-1 с парой 9:45 в 1/706: обход на хостинге собрал
    // 35852 пары вместо 37813 и перезаписал хороший кэш неполным).
    // Срабатывает только для groupText с НУЛЁМ новых записей — легитимные
    // изменения расписания (новые недели/аудитории) заменяются как раньше,
    // т.к. у таких групп новые записи есть. Смена семестра слиянию не мешает:
    // при смене семестра у всех групп есть новые пары (другие даты), нулевых нет.
    let preservedGroups = 0;
    let preservedLessons = 0;
    try {
      const oldCache = Array.isArray(fullScheduleCache) ? fullScheduleCache : [];
      if (oldCache.length) {
        const newGroupTexts = new Set();
        for (const e of all) {
          if (e && e.groupText) newGroupTexts.add(String(e.groupText));
        }
        const missingGroupTexts = new Set();
        for (const e of oldCache) {
          const gt = e && e.groupText ? String(e.groupText) : '';
          if (gt && !newGroupTexts.has(gt)) missingGroupTexts.add(gt);
        }
        if (missingGroupTexts.size) {
          for (const e of oldCache) {
            const gt = e && e.groupText ? String(e.groupText) : '';
            if (!gt || !missingGroupTexts.has(gt)) continue;
            all.push(e);
            const key = e.audience;
            if (key) {
              if (!newAudienceCache[key]) newAudienceCache[key] = [];
              newAudienceCache[key].push(e);
            }
            preservedLessons++;
          }
          preservedGroups = missingGroupTexts.size;
          logParser(`[FullSchedule] Preserved ${preservedLessons} lessons of ${preservedGroups} failed groups from previous cache (they returned 0 lessons in this crawl).`, 'WARN');
        }
      }
    } catch (e) {
      logParser(`[FullSchedule] Cache merge error (non-fatal): ${e.message}`, 'WARN');
    }

    // Итоговая защита от пустой перезаписи выше (all.length === 0) остаётся;
    // частичные легитимные отмены/переносы пар проходят как обычно.

    const newSignature = scheduleSignature(all);
    const oldSignature = scheduleSignature(fullScheduleCache);
    const changed = !fullScheduleCache || newSignature !== oldSignature;
    const finishTime = Date.now();
    const durationSec = ((finishTime - t0) / 1000).toFixed(1);

    if (changed) {
      fullScheduleCache = all;
      audienceScheduleCache = newAudienceCache;
      audienceScheduleUpdatedAt = finishTime;
      setLastFullUpdateTimestamp(finishTime);
      fullScheduleError = null;
      try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify({
          fullScheduleCacheVersion: FULL_SCHEDULE_CACHE_VERSION,
          fullScheduleCache,
          audienceScheduleCache,
          updatedAt: fullScheduleUpdatedAt,
          audienceScheduleUpdatedAt
        }, null, 2));
        logParser(`[FullSchedule] Cache UPDATED and saved to file: ${all.length} lessons, ${fetched.length}/${allGroups.length} groups with schedule (${noDataGroups.length} without schedule on BSEU) in ${durationSec}s. Changes: YES`, 'INFO');
      } catch (e) {
        logParser(`[FullSchedule] Failed to write cache file: ${e.message}`, 'WARN');
      }
    } else {
      setLastFullUpdateTimestamp(finishTime);
      // Содержимое не изменилось, но файл на диске может быть старой версии
      // формата или с устаревшей меткой. Переписываем его, чтобы при следующем
      // старте версия и updatedAt файла совпадали с текущим состоянием.
      if (readCacheFileVersion() !== FULL_SCHEDULE_CACHE_VERSION || fullScheduleUpdatedAt !== finishTime) {
        try {
          fs.writeFileSync(CACHE_FILE, JSON.stringify({
            fullScheduleCacheVersion: FULL_SCHEDULE_CACHE_VERSION,
            fullScheduleCache,
            audienceScheduleCache,
            updatedAt: fullScheduleUpdatedAt,
            audienceScheduleUpdatedAt
          }, null, 2));
          logParser(`[FullSchedule] Cache file rewritten (version ${FULL_SCHEDULE_CACHE_VERSION}, contents unchanged).`, 'INFO');
        } catch (e) {
          logParser(`[FullSchedule] Failed to rewrite cache file: ${e.message}`, 'WARN');
        }
      }
      logParser(`[FullSchedule] Crawl completed in ${durationSec}s: ${all.length} lessons, ${fetched.length}/${allGroups.length} groups with schedule (${noDataGroups.length} without schedule on BSEU). Changes: NO (cache unchanged)`, 'INFO');
    }

    // Фаза 2: расписания преподавателей. Ошибки здесь не роняют групповой кэш.
    await buildTeacherSchedules(fetched);

    fullScheduleBuilding = false;
    return all;
  })();

  fullSchedulePromise.catch(e => {
    logParser(`[FullSchedule] Crawl error: ${e.message}`, 'ERROR');
    fullScheduleError = e.message;
    fullScheduleBuilding = false;
  });

  return fullSchedulePromise;
}

function checkAndTriggerFullSchedule() {
  const now = Date.now();
  if (isBseuBlocked()) {
    logParser('[FullSchedule] Skipped: BSEU block cooldown active.', 'INFO');
    return;
  }
  const lastUpdate = getLastFullUpdateTimestamp();
  if ((!fullScheduleCache || now - lastUpdate >= FULL_SCHEDULE_INTERVAL) && !fullScheduleBuilding) {
    logParser('[FullSchedule] Triggering background full schedule crawl (interval elapsed or initial run)...', 'INFO');
    buildFullSchedule().catch(e => logParser(`[FullSchedule] Background build error: ${e.message}`, 'ERROR'));
  }
}

async function ensureFullSchedule() {
  checkAndTriggerFullSchedule();
  if (fullScheduleCache) return fullScheduleCache;
  if (fullScheduleBuilding) return null;
  return null;
}

async function getAudienceScheduleBseu(audience, date) {
  // Нормализуем входные параметры: название аудитории ("1 / 706 " -> "1/706")
  // и дату ("2026-9-7" / "2026-09-07T00:00:00" -> "2026-09-07").
  const targetAud = normalizeRoomName(audience);
  const reqDate = normalizeDateStr(date);
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
  const targetRooms = String(targetAud).split(',').map(r => normalizeRoomName(r)).filter(Boolean);
  const queryTokens = audienceTokens(targetAud);
  const matched = src.filter(p => {
    // Дата: сравниваем нормализованные значения, чтобы "2026-9-7" из запроса
    // находил "2026-09-07" в кэше (и наоборот), а лишний хвост времени
    // ("...T00:00:00") не ломал сравнение.
    if (reqDate && !(p.dates || []).some(d => normalizeDateStr(d) === reqDate)) return false;
    const rooms = extractRoomNumbers(p.audience);
    if (hasSlash) {
      return rooms.some(r => targetRooms.some(target => audienceRoomEquals(target, r)));
    }
    return queryTokens.length > 0 && rooms.some(r =>
      targetRooms.some(target => audienceNumberEquals(target, r))
    );
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
  // В ответ отдаём нормализованную дату (YYYY-MM-DD) — она же используется
  // клиентом как ключ кэша и для подписи дня недели.
  const outDate = reqDate || date;
  let dayNameRU = '';
  try { dayNameRU = new Date(outDate + 'T00:00:00').toLocaleDateString('ru-RU', { weekday: 'long' }); } catch (e) {}
  const payload = [{ scheduleOnDays: [{ id: 0, date: outDate + 'T00:00:00', dayNameRU, week: 0, lessons: collected }] }];
  // Клиенту сообщаем, что данные — из локального кэша сервера, и помечаем
  // isFallback, если кэш старше двойного интервала обновления (свежего ЖИВОГО
  // обхода давно не было — вероятно, БГЭУ недоступен). Тогда клиент покажет
  // баннер «Показаны сохранённые данные» и пользователь поймёт, почему.
  const cacheAge_ = Date.now() - (fullScheduleUpdatedAt || 0);
  const isStale_ = fullScheduleUpdatedAt > 0 && cacheAge_ > 2 * FULL_SCHEDULE_INTERVAL;
  return {
    data: payload,
    isFallback: isStale_,
    savedAt: fullScheduleUpdatedAt || Date.now(),
    fromCache: true,
    builtAt: fullScheduleUpdatedAt
  };
}

function normalizeGroupName(str) {
  if (!str) return '';
  return String(str).replace(/\s*\([^)]*\)/g, '').trim().toUpperCase();
}

async function getGroupScheduleAutoDetect(faculty, form, course, group, groupText) {
  const body = `__act=__id.25.main.inpFldsA.GetSchedule__sp.7.results__fp.4.main&faculty=${faculty}&form=${form}&course=${course}&group=${group}&period=3`;
  const cacheKey = `group:${faculty}:${form}:${course}:${group}`;
  const schedule = await getScheduleWithCache(cacheKey, body, { groupText });

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
    // Режим «по аудитории» берёт данные ТОЛЬКО с локального полного кэша
    // хостинга (fullScheduleCache) и НЕ обращается к БГЭУ, поэтому при бане IP
    // зеркало ему не нужно: данные на зеркале могут отсутствовать или быть
    // пустыми (а именно так сейчас на Render). Групповой и преподавательский
    // режимы (которые ходят на bseu.by напрямую) при бане по-прежнему идут
    // через зеркало, как и раньше.
    if (RENDER_PROXY_BASE && isBseuBlocked() && ((tid && taid && sid && tname) || (faculty && form && course && group))) {
      try {
        const data = await fetchJsonViaProxy('/api/schedule', req.query);
        if (data && Array.isArray(data.lessons)) data.lessons = sanitizeProxyLessons(data.lessons);
        // Пустой ответ зеркала — не «пустое расписание», а отсутствие данных
        // у зеркала. Отдаём локальный полный кэш, если он есть, иначе помечаем
        // ответ как degraded, чтобы клиент не сохранял пустоту как валидную.
        if (data && Array.isArray(data.lessons) && data.lessons.length === 0) {
          const localFb = (tid && taid && sid && tname)
            ? buildFullCacheSchedule(null, tname)
            : (faculty && form && course && group)
              ? buildFullCacheSchedule(groupText, null)
              : null;
          if (localFb && Array.isArray(localFb.lessons) && localFb.lessons.length) {
            logParser(`[Proxy] Route mirror returned EMPTY, served ${localFb.lessons.length} lessons from local full cache.`, 'WARN');
            return res.json(localFb);
          }
          logParser('[Proxy] Route mirror returned EMPTY and no local fallback — degraded.', 'WARN');
          return res.json({ ...data, viaProxy: true, degraded: true, degradedReason: 'mirror_empty' });
        }
        if (data && Array.isArray(data.lessons) && faculty && form && course && group && data.lessons.length > 0 &&
            !data.lessons.some(l => l && typeof l.subgroup === 'string' && l.subgroup.trim() !== '')) {
          logParser(`[Proxy] Route group=${group} mirror returned ${data.lessons.length} lessons with 0 subgroups (degraded).`, 'WARN');
          return res.json({ ...data, viaProxy: true, degraded: true, degradedReason: 'mirror_no_subgroups' });
        }
        return res.json({ ...data, viaProxy: true });
      } catch (pe) {
        logParser(`[Proxy] Route via mirror failed: ${pe.message}`, 'WARN');
      }
    }
    if (audience && date) {
      // Нормализация даты и корпуса перед фильтрацией: "1 / 706" -> "1/706",
      // "2026-9-7" -> "2026-09-07". См. getAudienceScheduleBseu.
      const schedule = await getAudienceScheduleBseu(normalizeRoomName(audience), normalizeDateStr(date));
      return res.json(schedule);
    }
    if (tid && taid && sid && tname) {
      // Заглушка из полного кэша (все ID -1): живой запрос к БГЭУ с такими
      // ID бессмысленен — сразу отдаём расписание из полного кэша по ФИО,
      // чтобы режим преподавателя работал даже без реальных ID.
      if (String(tid) === '-1' && String(taid) === '-1' && String(sid) === '-1') {
        const fb = buildFullCacheSchedule(null, tname);
        if (fb) return res.json(fb);
        // Полный кэш пуст — всё равно пробуем живой запрос (мало ли).
      }
      const body = `__act=tid.${tid.length}.${tid}taid.${taid.length}.${taid}sid.${sid.length}.${sid}__id.22.main.TSchedA.GetTSched__sp.8.tresults__fp.4.main&tname=${toWin1251Url(tname)}&period=3`;
      const cacheKey = `teacher:${tid}:${taid}:${sid}:${tname}`;
      const schedule = await getScheduleWithCache(cacheKey, body, { teacherName: tname }, { tid, taid, sid, tname });
      return res.json(schedule);
    }
    // tname без ID (поиск из полного кэша, БГЭУ недоступен): отдаём расписание
    // преподавателя напрямую из полного кэша по ФИО.
    if (tname && !faculty && !audience) {
      const fb = buildFullCacheSchedule(null, tname);
      if (fb) return res.json(fb);
      return res.json({ semesterStartDate: null, currentSemesterWeek: 1, lessons: [], isSchedulePage: false, isFallback: true, error: 'teacher_not_found' });
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
// Короткий алиас для режима аудитории (обратная совместимость клиентов).
app.get('/api/room', handleScheduleRequest);

// Endpoint /api/ping для Keep-Alive системы
app.get('/api/ping', (req, res) => {
  res.status(200).send('OK');
});

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
      const roomParts = extractRoomNumbers(full);
      const allValid = roomParts.every(part => /\d/.test(part.trim()));
      if (!allValid) continue;
      for (const room of roomParts) {
        if (q) {
          if (!room.toLowerCase().includes(q)) continue;
        }
        const key = normalizeAudienceRoom(room);
        const existing = map.get(key);
        map.set(key, {
          audience: existing ? existing.audience : room,
          count: (existing ? existing.count : 0) + 1
        });
      }
    }
    const list = Array.from(map.entries())
      .map(([, value]) => value)
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
    res.json([]);
  }
});
app.get('/api/courses', async (req, res) => {
  try {
    const { faculty, form } = req.query;
    const data = await fetchBseuList("__id.23.main.inpFldsA.GetCourse", { faculty, form });
    res.json(data);
  } catch (error) {
    res.json([]);
  }
});
app.get('/api/groups', async (req, res) => {
  try {
    const { faculty, form, course } = req.query;
    const data = await fetchBseuList("__id.23.main.inpFldsA.GetGroups", { faculty, form, course });
    res.json(data);
  } catch (error) {
    res.json([]);
  }
});
app.get('/api/teachers', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    // Быстрый путь: совпадения из локального индекса — мгновенно, без БГЭУ.
    try {
      const fast = searchTeachersFast(q);
      if (fast.length) {
        res.json(fast);
        // Совпадений мало — тихо дообогащаем индекс из БГЭУ (ответ не ждём).
        const nq = normTeacherQuery(q);
        if (fast.length < 8 && q.length >= 3 && !teacherRefreshInflight.has(nq)) {
          teacherRefreshInflight.add(nq);
          fetchBseuList("__id.24.main.TSchedA.getTeachers", { tname: q }, { retries: 1, timeout: 8000 })
            .catch(() => null)
            .finally(() => teacherRefreshInflight.delete(nq));
        }
        return;
      }
    } catch (e) { /* ниже медленный путь */ }
    // В индексе пусто — идём в БГЭУ с короткими ретраями/таймаутом,
    // чтобы подсказки не висели вечно (раньше: 4 ретрая × 15 с).
    try {
      const data = await fetchBseuList("__id.24.main.TSchedA.getTeachers", { tname: q }, { retries: 1, timeout: 8000 });
      if (Array.isArray(data) && data.length) return res.json(data);
      // БГЭУ вернул пусто (или лежит) — отдаём совпадения из полного кэша,
      // чтобы поиск преподавателей работал даже при недоступности БГЭУ.
      const fb = searchTeachersFullCache(q);
      if (fb.length) return res.json(fb);
      return res.json(data);
    } catch (e) {
      const fb = searchTeachersFullCache(q);
      if (fb.length) return res.json(fb);
      throw e;
    }
  } catch (error) {
    try {
      const fb = searchTeachersFullCache(String(req.query.q || ''));
      if (fb.length) return res.json(fb);
    } catch (_) {}
    res.json([]);
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

// ===== Health check endpoint =====
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
      lastFullUpdate: getLastFullUpdateTimestamp(),
      startedAt: fullScheduleStartedAt,
      error: fullScheduleError,
      buildingTime: fullScheduleStartedAt ? Math.floor((Date.now() - fullScheduleStartedAt) / 1000) + 's' : null
    },
    nodeVersion: process.version,
    timestamp: Date.now()
  });
});

// ===== Cron ping endpoint (для cPanel Cron Job на hoster.by) =====
// Вызывается внешним cron-заданием: curl https://yourdomain.com/api/cron/ping?token=SECRET
// Защищён токеном (CRON_SECRET из env). Запускает фоновую сборку расписания при необходимости.
app.get('/api/cron/ping', (req, res) => {
  const CRON_SECRET = process.env.CRON_SECRET || '';

  // Если секрет задан в env — проверяем токен; если не задан — только с localhost
  if (CRON_SECRET) {
    const token = req.query.token || req.headers['x-cron-token'] || '';
    if (token !== CRON_SECRET) {
      return res.status(403).json({ error: 'Forbidden: invalid token' });
    }
  } else {
    // Без секрета — разрешаем только локальным запросам
    const ip = req.ip || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) {
      return res.status(403).json({ error: 'Forbidden: set CRON_SECRET env variable' });
    }
  }

  const lastUpdate = getLastFullUpdateTimestamp();
  const now = Date.now();
  const ageSeconds = Math.floor((now - lastUpdate) / 1000);
  let triggered = false;

  if (!fullScheduleBuilding && !isBseuBlocked() && (!fullScheduleCache || now - lastUpdate >= FULL_SCHEDULE_INTERVAL)) {
    logParser('[Cron/Ping] External cron triggered background schedule refresh.', 'INFO');
    buildFullSchedule().catch(e => logParser(`[Cron/Ping] Build error: ${e.message}`, 'ERROR'));
    triggered = true;
  }

  res.json({
    ok: true,
    triggered,
    building: fullScheduleBuilding,
    hasCache: !!fullScheduleCache,
    cacheEntries: fullScheduleCache ? fullScheduleCache.length : 0,
    cacheAgeSeconds: ageSeconds,
    lastUpdate: lastUpdate ? new Date(lastUpdate).toISOString() : null,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Любой неизвестный /api/* маршрут — это ошибка (JSON 404), а НЕ index.html.
// Иначе устаревший клиент получит HTML с кодом 200 и упадёт на response.json(),
// из-за чего «расписание и списки не загружаются».
app.use('/api', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.status(404).json({ error: 'Unknown API route', path: req.path });
});

app.use(express.static(__dirname));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Ночной полный сбор (группы + преподаватели) каждый день в 01:00 по Минску.
function runNightlyCrawl() {
  if (fullScheduleBuilding) { logParser('[Cron] Nightly crawl skipped: build already running.', 'INFO'); return; }
  if (isBseuBlocked()) { logParser('[Cron] Nightly crawl skipped: BSEU block cooldown active.', 'INFO'); return; }
  logParser('[Cron] Starting nightly full crawl (groups + teachers)...', 'INFO');
  buildFullSchedule().catch(e => logParser(`[Cron] Nightly build error: ${e.message}`, 'ERROR'));
}
try {
  cron.schedule('0 1 * * *', runNightlyCrawl, { timezone: 'Europe/Minsk' });
  logParser('[Cron] Nightly crawl scheduled at 01:00 Europe/Minsk.', 'INFO');
} catch (e) {
  cron.schedule('0 1 * * *', runNightlyCrawl);
  logParser(`[Cron] Timezone not supported, nightly crawl at server-local 01:00: ${e.message}`, 'WARN');
}

// Глобальный перехват ошибок для предотвращения падения без логов
process.on('uncaughtException', (err) => {
  logParser(`[FATAL] Uncaught Exception: ${err && err.stack ? err.stack : err}`, 'ERROR');
  console.error('[FATAL] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason && (reason.stack || reason.message) ? (reason.stack || reason.message) : reason;
  logParser(`[WARN] Unhandled Promise Rejection: ${msg}`, 'WARN');
  console.error('[WARN] Unhandled Rejection:', reason);
});

// Фоново греем списки форм/курсов при старте, если их нет в кэше,
// чтобы первый заход не ждал живого БГЭУ. Группы подтянет buildFullSchedule.
async function warmListsIfCold() {
  try {
    // Даём фоновому обходу шанс первым заполнить кэш — не удваиваем стартовый burst.
    await new Promise(r => setTimeout(r, 60000));
    if (isBseuBlocked()) return;
    const missing = [];
    for (const fac of BSEU_FACULTIES) {
      const key = `list:__id.22.main.inpFldsA.GetForms:${JSON.stringify({ faculty: fac })}`;
      if (!fileGetCache(key)) missing.push(fac);
    }
    if (!missing.length) return;
    logParser(`[WarmLists] Warming lists for ${missing.length} faculties...`, 'INFO');
    for (const fac of missing) {
      if (isBseuBlocked()) return;
      try {
        const forms = await fetchBseuList("__id.22.main.inpFldsA.GetForms", { faculty: fac });
        if (!Array.isArray(forms)) continue;
        for (const f of forms) {
          try { await fetchBseuList("__id.23.main.inpFldsA.GetCourse", { faculty: fac, form: f.value }); }
          catch (_) {}
        }
      } catch (e) {
        logParser(`[WarmLists] Faculty ${fac} failed: ${e.message}`, 'WARN');
      }
      await new Promise(r => setTimeout(r, 300));
    }
    logParser('[WarmLists] Done.', 'INFO');
  } catch (e) {}
}

function onServerReady() {
  if (fullScheduleCache) {
    logParser(`[Cache] Initial cache loaded with ${fullScheduleCache.length} entries.`);
  } else {
    logParser('[Cache] Cache empty. Initializing background full schedule build...');
  }
  // При рестарте всегда собираем всё (группы + преподаватели).
  // Дешево, если кэш свежий (все хиты локальные); при бане спасают breaker и прокси.
  logParser('[Startup] Triggering full crawl (groups + teachers)...', 'INFO');
  buildFullSchedule().catch(e => logParser(`[Startup] Build error: ${e.message}`, 'ERROR'));
  warmListsIfCold().catch(() => {});
}

const isNumericPort = !isNaN(Number(PORT));
let server;

if (isNumericPort) {
  server = app.listen(Number(PORT), HOST, () => {
    logParser(`Server is running at http://${HOST}:${PORT}`);
    onServerReady();
  });
} else {
  // Для Phusion Passenger / cPanel (когда PORT передаётся как Unix-сокет или pipe)
  server = app.listen(PORT, () => {
    logParser(`Server is running on Passenger socket ${PORT}`);
    onServerReady();
  });
}

server.on('error', (err) => {
  logParser(`Server failed to start: ${err.message}`, 'ERROR');
  console.error('[Server Error]', err);
  process.exit(1);
});

// Обработка сигналов завершения процесса (graceful shutdown)
function handleShutdown(signal) {
  logParser(`Received ${signal}. Shutting down server gracefully...`, 'INFO');
  server.close(() => {
    try {
      if (auth && auth.db) auth.db.close();
    } catch (e) {}
    logParser('Server stopped cleanly.', 'INFO');
    process.exit(0);
  });
}
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// Экспорт app для совместимости с cPanel Node.js Selector (Phusion Passenger) на hoster.by
module.exports = app;