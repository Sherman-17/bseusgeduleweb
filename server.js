const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
