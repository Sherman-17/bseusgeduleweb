const express = require('express');
const path = require('path');
const fs = require('fs');
const iconv = require('iconv-lite');
const cheerio = require('cheerio');
const auth = require('./server/auth');

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
function ensureCacheDir() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch (e) { /* ignore */ }
}
ensureCacheDir();

function cacheFilePath(key) {
  const safe = Buffer.from(key).toString('base64').replace(/[/+=]/g, '_');
  return path.join(CACHE_DIR, `${safe}.json`);
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

// ===== BSEU schedule engine (same as schedj.js) =====
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
      if (utf8Text.includes('�') || /[\x80-\xFF]/.test(utf8Text)) charset = 'windows-1251';
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
    const response = await fetch("https://bseu.by/schedule/", {
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

function parseScheduleHtml(html) {
  const $ = cheerio.load(html);
  const table = $('table').first();
  let semesterStartDate = null;
  let currentSemesterWeek = 1;
  const semesterMatch = html.match(/<!--(?:first|second)\s+semester=(.*?)-->/i);
  if (semesterMatch) {
    semesterStartDate = new Date(semesterMatch[1]);
  } else {
    const weekMatch = html.match(/Текущая\s+-\s+<strong>(\d+)<\/strong>\s+учебная\s+неделя/i);
    if (weekMatch) {
      const currentWeekNum = Number(weekMatch[1]);
      currentSemesterWeek = currentWeekNum;
      const today = new Date();
      const day = today.getDay();
      const diff = today.getDate() - day + (day === 0 ? -6 : 1);
      const todayMonday = new Date(today.setDate(diff));
      todayMonday.setHours(0, 0, 0, 0);
      semesterStartDate = new Date(todayMonday.getTime() - (currentWeekNum - 1) * 7 * 24 * 60 * 60 * 1000);
    } else {
      semesterStartDate = new Date();
      currentSemesterWeek = 1;
    }
  }
  if (!table.length) return { semesterStartDate, currentSemesterWeek, lessons: [] };

  const rows = table.find('tr');
  let currentDay = '';
  const lessons = [];
  const headers = [];
  table.find('thead th').each((idx, th) => headers.push($(th).text().trim().toLowerCase()));
  const isTeacherSchedule = headers.includes('группа');
  const rowArr = rows.toArray();

  for (let i = 0; i < rowArr.length; i++) {
    const row = $(rowArr[i]);
    const wdayCell = row.find('td.wday');
    if (wdayCell.length) { currentDay = wdayCell.text().trim(); continue; }
    const cells = row.find('td');
    if (cells.length >= 3) {
      if (isTeacherSchedule) {
        if (cells.length >= 5) {
          const time = $(cells[0]).text().trim();
          const group = $(cells[1]).text().trim();
          const subgroup = $(cells[2]).text().trim();
          const contentCell = $(cells[3]);
          const room = $(cells[4]).text().trim();
          const distypeSpan = contentCell.find('.distype');
          const type = distypeSpan.length ? distypeSpan.text().replace(/[()]/g, '').trim() : '';
          const emEl = contentCell.find('em');
          const subject = emEl.length ? emEl.text().trim() : '';
          let weeks = '';
          const clone = contentCell.clone();
          clone.find('.distype').remove();
          clone.find('em').remove();
          const rawText = clone.text().trim();
          const match = rawText.match(/^\(([^)]+)\)/);
          if (match) weeks = match[1];
          else weeks = rawText;
          const displayGroup = subgroup ? `${group} (${subgroup})` : group;
          if (subject && time) {
            lessons.push({ day: currentDay || "Вне сетки", time, weeks, subject, type, teacher: displayGroup, room, isTeacher: true });
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
          const clone = contentCell.clone();
          clone.find('.distype').remove();
          clone.find('.teacher, .teacher.dd').remove();
          subject = clone.text().replace(/,\s*$/, '').trim();
        }
        if (rightCell.length) {
          room = rightCell.text().trim();
        } else if (subject) {
          const subgroupRooms = [];
          for (let j = i + 1; j < rowArr.length; j++) {
            const subRow = $(rowArr[j]);
            if (subRow.find('td.wday').length) break;
            const subCells = subRow.find('td');
            if (subCells.length >= 3 && !subRow.find('td.sg').length) break;
            const lastCell = subCells.last();
            if (lastCell.length) {
              const r = lastCell.text().replace(/<!--[\s\S]*?-->/g, '').trim();
              if (r && !subgroupRooms.includes(r)) subgroupRooms.push(r);
            }
          }
          room = subgroupRooms.join(', ');
        }
        if (subject && time) {
          lessons.push({ day: currentDay || "Вне сетки", time, weeks, subject, type, teacher, room, isTeacher: false });
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
    const response = await fetch("https://bseu.by/schedule/", {
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

// ===== Список аудиторий (реальные номера "корпус/аудитория" из studhub.by) =====
// Serve static files
app.use(express.static(__dirname));

const studhubCache = new Map();
async function proxyJson(url, res) {
  if (studhubCache.has(url)) {
    const cached = studhubCache.get(url);
    res.set('Content-Type', cached.contentType);
    res.set('Access-Control-Allow-Origin', '*');
    res.send(cached.body);
    return;
  }
  try {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'api-version': '1.0',
        'Origin': 'https://studhub.by',
        'Referer': 'https://studhub.by/bseu/schedule/audiences',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const body = await response.text();
    const contentType = response.headers.get('content-type') || 'application/json; charset=utf-8';
    if (response.ok) studhubCache.set(url, { contentType, body });
    res.set('Content-Type', contentType);
    res.set('Access-Control-Allow-Origin', '*');
    res.status(response.status).send(body);
  } catch (error) {
    console.error('Studhub Proxy error:', error);
    res.status(500).json({ error: 'proxy_failed', message: error.message });
  }
}

app.get('/api/audiences', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const schedule = await ensureFullSchedule();
    const map = new Map();
    for (const p of (schedule || [])) {
      const full = p.audience;
      if (!full || !/\d|\//.test(String(full).trim())) continue;
      // фильтруем по токенам, если задан q
      if (q && !p.audienceTokens.some(t => t.includes(q))) continue;
      map.set(full, (map.get(full) || 0) + 1);
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

// ===== Расписание аудитории: полная копия расписания БГЭУ =====
const BSEU_FACULTIES = ["12","14","13","7","2","8","534","11","263","18","129","450","530","531","497","535","432"];
const FULL_SCHEDULE_INTERVAL = 10 * 60 * 1000;
let fullScheduleCache = null;
let fullScheduleUpdatedAt = 0;
let fullScheduleBuilding = false;
let fullSchedulePromise = null;

// Кэш расписания по аудиториям: { "2/301": [{ subject, type, teacher, groupText, startTime, endTime, dates, audience, audienceTokens }, ...] }
let audienceScheduleCache = {};
let audienceScheduleUpdatedAt = 0;

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
  const start = new Date(semesterStartDate);
  const monday = new Date(start);
  const sd = monday.getDay();
  monday.setDate(monday.getDate() - (sd === 0 ? 6 : sd - 1));
  monday.setHours(0, 0, 0, 0);
  const result = new Date(monday);
  result.setDate(monday.getDate() + (weekNum - 1) * 7 + dayIndex);
  const y = result.getFullYear();
  const m = String(result.getMonth() + 1).padStart(2, '0');
  const d = String(result.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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

async function buildFullSchedule() {
  if (fullScheduleBuilding) return fullSchedulePromise;
  fullScheduleBuilding = true;
  fullSchedulePromise = (async () => {
    console.log('[FullSchedule] Начинаем сборку полной копии расписания...');
    const t0 = Date.now();
    let allGroups = [];
    const groupLists = await Promise.all(BSEU_FACULTIES.map(fac =>
      getFacultyGroups(fac).catch(e => { console.warn(`[FullSchedule] Факультет ${fac}: ${e.message}`); return []; })
    ));
    groupLists.forEach(list => { allGroups = allGroups.concat(list); });

    const CONCURRENCY = 30;
    const all = [];
    for (let i = 0; i < allGroups.length; i += CONCURRENCY) {
      const batch = allGroups.slice(i, i + CONCURRENCY);
      const results = await Promise.all(batch.map(async (g) => {
        try {
          const body = `__act=__id.25.main.inpFldsA.GetSchedule__sp.7.results__fp.4.main&faculty=${g.faculty}&form=${g.form}&course=${g.course}&group=${g.group}&period=3`;
          const gkey = `group:${g.faculty}:${g.form}:${g.course}:${g.group}`;
          const sched = await getScheduleWithCache(gkey, body);
          return { sched, g };
        } catch (e) { return null; }
      }));
      for (const r of results) {
        if (!r) continue;
        const { sched, g } = r;
        const lessons = sched.lessons || [];
        const semStart = sched.semesterStartDate;
        for (const l of lessons) {
          const weeks = parseWeeks(l.weeks);
          const dates = [];
          for (const w of weeks) {
            const d = lessonDate(semStart, l.day, w);
            if (d) dates.push(d);
          }
          if (!dates.length) continue;
          // Пропускаем записи, где аудитория не валидна (содержит фамилии преподавателей и т.п.)
          if (!l.room || !/\d|\//.test(String(l.room).trim())) continue;
          const [start, end] = String(l.time || '').split(/[-–]/).map(s => s.trim());
          const entry = {
            audience: l.room,
            audienceTokens: audienceTokens(l.room),
            dates,
            subject: l.subject,
            type: l.type,
            teacher: l.teacher || '',
            groupText: g.groupText,
            startTime: start || '',
            endTime: end || ''
          };
          all.push(entry);
          
          // Заполняем кэш по аудиториям
          if (l.room) {
            if (!audienceScheduleCache[l.room]) {
              audienceScheduleCache[l.room] = [];
            }
            audienceScheduleCache[l.room].push(entry);
          }
        }
      }
    }
    fullScheduleCache = all;
    fullScheduleUpdatedAt = Date.now();
    console.log(`[FullSchedule] Готово: ${all.length} пар, ${allGroups.length} групп, за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
    fullScheduleBuilding = false;
    return all;
  })();
  return fullSchedulePromise;
}
async function ensureFullSchedule() {
  if (fullScheduleCache) return fullScheduleCache;
  return buildFullSchedule();
}
async function getAudienceScheduleBseu(audience, date) {
  const targetAud = audience.trim();
  const schedule = await ensureFullSchedule();
  const src = schedule || fullScheduleCache || [];
  const collected = src.filter(p =>
    (p.audience === targetAud || p.audienceTokens.includes(targetAud)) && p.dates.includes(date)
  ).map(p => ({
    shortNameRU: p.subject,
    lessonTypeShortNameRU: p.type,
    teachers: p.teacher ? [p.teacher] : [],
    groups: [p.groupText],
    audience: p.audience,
    startTime: p.startTime,
    endTime: p.endTime
  }));
  collected.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
  let dayNameRU = '';
  try { dayNameRU = new Date(date + 'T00:00:00').toLocaleDateString('ru-RU', { weekday: 'long' }); } catch (e) {}
  const payload = [{ scheduleOnDays: [{ id: 0, date: date + 'T00:00:00', dayNameRU, week: 0, lessons: collected }] }];
  return { data: payload, isFallback: false, fromCache: false, builtAt: fullScheduleUpdatedAt };
}

// ===== Unified schedule endpoint (group / teacher / room) =====
async function handleScheduleRequest(req, res) {
  try {
    const { faculty, form, course, group, tid, taid, sid, tname, audience, date } = req.query;
    if (audience && date) {
      const schedule = await getAudienceScheduleBseu(audience.trim(), date.trim());
      return res.json(schedule);
    }
    if (tid && taid && sid && tname) {
      const body = `tid.${tid.length}.${tid}taid.${taid.length}.${taid}sid.${sid.length}.${sid}__id.22.main.TSchedA.GetTSched__sp.8.tresults__fp.4.main&tname=${tname}&period=3`;
      const cacheKey = `teacher:${tid}:${taid}:${sid}:${tname}`;
      const schedule = await getScheduleWithCache(cacheKey, body);
      return res.json(schedule);
    }
    if (faculty && form && course && group) {
      const body = `__act=__id.25.main.inpFldsA.GetSchedule__sp.7.results__fp.4.main&faculty=${faculty}&form=${form}&course=${course}&group=${group}&period=3`;
      const cacheKey = `group:${faculty}:${form}:${course}:${group}`;
      const schedule = await getScheduleWithCache(cacheKey, body);
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

app.use(express.static(__dirname));

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running at http://0.0.0.0:${PORT}`);
  buildFullSchedule().catch(e => console.error('[FullSchedule] Ошибка начальной сборки:', e.message));
  setInterval(() => {
    buildFullSchedule().catch(e => console.error('[FullSchedule] Ошибка периодической сборки:', e.message));
  }, FULL_SCHEDULE_INTERVAL);
});

server.on('error', (err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
