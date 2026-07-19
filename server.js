const express = require('express');
const path = require('path');
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
  // Простой аналог res.cookie (только нужные нам флаги)
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

// ----- Аккаунты и синхронизация (логин+пароль, без email) -----
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

// Простой in-memory rate-limit для эндпоинтов аутентификации
// (5 попыток в минуту на IP). Защита от перебора пароля.
const AUTH_RATE_LIMIT = 5;
const AUTH_RATE_WINDOW = 60 * 1000;
const authAttempts = new Map(); // ip -> { count, resetAt }
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
function authRateHeaders(ip) {
  const rec = authAttempts.get(ip);
  if (!rec) return {};
  const remaining = Math.max(0, AUTH_RATE_LIMIT - rec.count);
  return { 'Retry-After': Math.ceil((rec.resetAt - Date.now()) / 1000) };
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



// Serve static files
app.use(express.static(__dirname));

// Кэш для запросов к studhub
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

    if (response.ok) {
      studhubCache.set(url, {
        contentType,
        body
      });
    }

    res.set('Content-Type', contentType);
    res.set('Access-Control-Allow-Origin', '*');
    res.status(response.status).send(body);
  } catch (error) {
    console.error('Studhub Proxy error:', error);
    res.status(500).json({ error: 'proxy_failed', message: error.message });
  }
}

// Маршруты для расписания аудиторий (API studhub.by)
app.get('/api/audiences', async (req, res) => {
  await proxyJson('https://studhub.by/Schedule/3/audiences?', res);
});

app.get('/api/schedule', async (req, res) => {
  const audience = (req.query.audience || '').trim();
  const date = (req.query.date || '').trim();

  if (!audience || !date) {
    return res.status(400).json({ error: 'missing_params' });
  }

  const apiUrl = `https://studhub.by/Schedule/3/audiences/${encodeURIComponent(audience)}/schedule/date/${date}`;
  await proxyJson(apiUrl, res);
});

// Proxy endpoint to bypass CORS and handle encoding for BSEU schedule
app.post('/api/proxy', async (req, res) => {
  try {
    const { url, body } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: body
    });

    const buffer = await response.arrayBuffer();

    // Detect charset from response Content-Type header
    const contentType = response.headers.get('content-type') || '';
    const charsetMatch = contentType.match(/charset=([^\s;]+)/i);
    let charset = charsetMatch ? charsetMatch[1].replace(/['"]/g, '') : null;

    // If no charset in headers, try to detect:
    if (!charset) {
      const utf8Text = new TextDecoder('utf-8').decode(buffer);
      try {
        JSON.parse(utf8Text);
        charset = 'utf-8';
      } catch {
        if (utf8Text.includes('\uFFFD') || /[\x80-\xFF]/.test(utf8Text)) {
          charset = 'windows-1251';
        } else {
          charset = 'utf-8';
        }
      }
    }

    console.log(`[Proxy] ${body?.substring(0, 80)}... → charset: ${charset}`);

    const decoded = new TextDecoder(charset).decode(buffer);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(decoded);
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: error.message });
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running at http://0.0.0.0:${PORT}`);
});

server.on('error', (err) => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
