const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const session = require('express-session');

const app = express();
const PORT = 5000;

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

const db = new Database('repls.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS repls (
    id TEXT PRIMARY KEY,
    slug TEXT,
    title TEXT,
    description TEXT,
    language TEXT,
    is_private INTEGER DEFAULT 0,
    url TEXT,
    owner TEXT,
    created_at TEXT,
    updated_at TEXT,
    downloaded INTEGER DEFAULT 0,
    download_path TEXT,
    download_size INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'replit-dl-2026',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use('/downloads', express.static(DOWNLOADS_DIR));

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeCookieHeader(arr) {
  if (!Array.isArray(arr) || !arr.length) return '';
  return arr.map(c => `${c.name}=${c.value}`).join('; ');
}

function getStoredCookies() {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get('cookies');
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, value);
}

// Decode JWT payload (no verification needed — we trust our own stored cookies)
function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const pad = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
  } catch { return null; }
}

// Standard Replit browser headers
function replitHeaders(cookieHeader, referer = 'https://replit.com/repls') {
  return {
    'Cookie': cookieHeader,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': referer,
    'Origin': 'https://replit.com',
    'X-Requested-With': 'XMLHttpRequest',
  };
}

// Extract username from Replit HTML (embedded in __NEXT_DATA__ or window.__REDUX__)
function extractUsername(html) {
  // Try multiple patterns
  const patterns = [
    /"username":"([^"]+)"/,
    /"currentUser":\{"username":"([^"]+)"/,
    /"viewer":\{"username":"([^"]+)"/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m[1]) return m[1];
  }
  return null;
}

// Extract repls from __NEXT_DATA__ JSON in profile page HTML
function extractReplsFromHtml(html, username) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  try {
    const data = JSON.parse(m[1]);
    const props = data?.props?.pageProps;
    
    // Various possible locations of repl data
    const candidates = [
      props?.user?.publicRepls?.items,
      props?.user?.repls?.items,
      props?.initialUserRepls,
      props?.repls,
    ];
    for (const c of candidates) {
      if (Array.isArray(c) && c.length > 0) return c;
    }

    // Flatten any nested structure
    if (props?.user) {
      const user = props.user;
      for (const key of Object.keys(user)) {
        if (Array.isArray(user[key]) && user[key][0]?.slug) return user[key];
        if (user[key]?.items && Array.isArray(user[key].items)) return user[key].items;
      }
    }
  } catch {}
  return [];
}

// ── Routes ─────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Save cookies
app.post('/api/cookies', (req, res) => {
  try {
    const { cookies } = req.body;
    if (!Array.isArray(cookies) || !cookies.length)
      return res.json({ success: false, error: 'Pas un tableau JSON valide.' });

    const hasSession = cookies.some(c => ['connect.sid', '__Host-session-sig', 'replit_authed'].includes(c.name));
    if (!hasSession)
      return res.json({ success: false, error: 'Cookie de session manquant. Exporte TOUS les cookies de replit.com.' });

    // Try to decode user info from connect.sid JWT (instant, no HTTP call)
    const sessionCookie = cookies.find(c => c.name === 'connect.sid');
    let userId = null, email = null;
    if (sessionCookie) {
      const payload = decodeJwtPayload(sessionCookie.value);
      userId = payload?.replit_user_id || null;
      email = payload?.email || null;
    }

    setSetting('cookies', JSON.stringify(cookies));
    if (userId) setSetting('user_id', String(userId));
    if (email) setSetting('email', email);

    res.json({ success: true, message: `${cookies.length} cookies sauvegardés.`, userId, email });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Check auth — primary: decode JWT from connect.sid (no HTTP needed)
// secondary: verify session by fetching /repls (background, updates username cache)
app.get('/api/auth-status', async (req, res) => {
  const cookies = getStoredCookies();
  if (!cookies) return res.json({ authenticated: false, reason: 'Aucun cookie sauvegardé.' });

  const sessionCookie = cookies.find(c => c.name === 'connect.sid');
  const jwtPayload = sessionCookie ? decodeJwtPayload(sessionCookie.value) : null;
  const cachedUsername = getSetting('username');
  const storedEmail = getSetting('email');

  // If we have a cached verified username → return immediately
  if (cachedUsername) {
    return res.json({ authenticated: true, username: cachedUsername });
  }

  // If JWT has user_id → cookies are structurally valid, we're "authenticated"
  // Derive display name and try to confirm in background
  if (jwtPayload?.replit_user_id) {
    const userId = jwtPayload.replit_user_id;
    const email = jwtPayload.email || storedEmail || '';
    
    // Use email prefix as provisional username, then verify async
    const provisionalUsername = email ? email.split('@')[0] : `user_${userId}`;

    // Background: try to get real username from /repls page
    const cookieHeader = makeCookieHeader(cookies);
    fetch('https://replit.com/repls', {
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow'
    }).then(async resp => {
      if (!resp.ok) return;
      const html = await resp.text();
      // Only extract if NOT redirected to login
      if (resp.url.includes('/login')) return;
      const username = extractUsername(html);
      if (username && username !== 'login') {
        setSetting('username', username);
      }
    }).catch(() => {});

    return res.json({ authenticated: true, username: provisionalUsername, userId, provisional: true });
  }

  // No JWT, no cache — try live fetch as last resort
  try {
    const cookieHeader = makeCookieHeader(cookies);
    const resp = await fetch('https://replit.com/repls', {
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow'
    });
    if (resp.url.includes('/login')) {
      return res.json({ authenticated: false, reason: 'Session expirée. Exporte de nouveaux cookies depuis replit.com.' });
    }
    const html = await resp.text();
    const username = extractUsername(html);
    if (username) {
      setSetting('username', username);
      return res.json({ authenticated: true, username });
    }
    res.json({ authenticated: false, reason: 'Username introuvable. Vérifie que tu es connecté sur replit.com avant d\'exporter.' });
  } catch (e) {
    res.json({ authenticated: false, reason: e.message });
  }
});

// Fetch all repls from profile page
app.post('/api/fetch-repls', async (req, res) => {
  const cookies = getStoredCookies();
  if (!cookies) return res.json({ success: false, error: 'Aucun cookie. Ajoute tes cookies d\'abord.' });

  const username = getSetting('username');
  if (!username) return res.json({ success: false, error: 'Username inconnu. Clique d\'abord sur "Check Connection".' });

  try {
    const cookieHeader = makeCookieHeader(cookies);
    let allRepls = [];

    // Strategy 1: fetch profile page and parse __NEXT_DATA__
    const profileResp = await fetch(`https://replit.com/@${username}`, {
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow'
    });
    const profileHtml = await profileResp.text();
    allRepls = extractReplsFromHtml(profileHtml, username);

    // Strategy 2: try /data/repls API (may work with fresh cookies)
    if (allRepls.length === 0) {
      try {
        const dataResp = await fetch(`https://replit.com/data/repls/@${username}`, {
          headers: {
            ...replitHeaders(cookieHeader),
            'Accept': 'application/json',
          },
          redirect: 'follow'
        });
        if (dataResp.ok) {
          const ct = dataResp.headers.get('content-type') || '';
          if (ct.includes('json')) {
            const data = await dataResp.json();
            if (Array.isArray(data)) allRepls = data;
            else if (Array.isArray(data?.repls)) allRepls = data.repls;
          }
        }
      } catch {}
    }

    // Strategy 3: GraphQL with Origin header
    if (allRepls.length === 0) {
      const gqlResult = await tryGraphQL(cookieHeader, username);
      if (gqlResult.length > 0) allRepls = gqlResult;
    }

    if (allRepls.length === 0) {
      return res.json({ 
        success: false, 
        error: 'Impossible de récupérer les repls. Tes cookies sont peut-être expirés — exporte-les à nouveau depuis replit.com.' 
      });
    }

    // Persist to DB
    const insert = db.prepare(`
      INSERT OR REPLACE INTO repls (id, slug, title, description, language, is_private, url, owner, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
      for (const r of allRepls) {
        const slug = r.slug || r.name || '';
        const id = r.id || `${username}-${slug}`;
        const title = r.title || r.name || slug;
        const lang = r.language?.displayName || r.language || r.lang || '';
        const isPriv = r.isPrivate || r.isPriv || 0;
        const owner = r.user?.username || r.owner?.username || r.username || username;
        const url = r.url || `https://replit.com/@${owner}/${slug}`;
        insert.run(id, slug, title, r.description || '', lang, isPriv ? 1 : 0, url, owner, r.timeCreated || r.createdAt || '', r.timeUpdated || r.updatedAt || '');
      }
    })();

    res.json({ success: true, count: allRepls.length });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

async function tryGraphQL(cookieHeader, username) {
  // Known persisted query hashes for user repls
  const hashes = [
    'e5539818b4e7ca5f3a39ea5f5256e5ef8dac18ad02f6b61a7b83e5dde48bb8cb',
    '4778fd4b43617ef5f51b5e6b3c3a44a9f61dc6a6e4e34dafef93481ad7fccd3d',
  ];
  for (const hash of hashes) {
    try {
      const r = await fetch('https://replit.com/graphql', {
        method: 'POST',
        headers: {
          'Cookie': cookieHeader,
          'Content-Type': 'application/json',
          'Origin': 'https://replit.com',
          'Referer': `https://replit.com/@${username}`,
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': 'Mozilla/5.0',
        },
        body: JSON.stringify({
          operationName: 'profileRepls',
          variables: { username, count: 100, pinnedReplsFirst: false, showUnnamed: true },
          extensions: { persistedQuery: { version: 1, sha256Hash: hash } }
        })
      });
      if (r.ok) {
        const d = await r.json();
        const items = d?.data?.user?.publicRepls?.items || d?.data?.user?.repls?.items || [];
        if (items.length > 0) return items;
      }
    } catch {}
  }
  return [];
}

// All repls with progress
app.get('/api/repls', (req, res) => {
  const repls = db.prepare('SELECT * FROM repls ORDER BY downloaded ASC, updated_at DESC').all();
  const total = repls.length;
  const downloaded = repls.filter(r => r.downloaded).length;
  res.json({ repls, total, downloaded, pending: total - downloaded });
});

// Download progress
app.get('/api/download-progress', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM repls').get().c;
  const downloaded = db.prepare('SELECT COUNT(*) as c FROM repls WHERE downloaded=1').get().c;
  const repls = db.prepare('SELECT * FROM repls ORDER BY downloaded ASC, updated_at DESC').all();
  res.json({ total, downloaded, pending: total - downloaded, repls });
});

// Download single repl
app.post('/api/download/:replId', async (req, res) => {
  const cookies = getStoredCookies();
  if (!cookies) return res.json({ success: false, error: 'Aucun cookie.' });

  const replId = decodeURIComponent(req.params.replId);
  const repl = db.prepare('SELECT * FROM repls WHERE id=?').get(replId);
  if (!repl) return res.json({ success: false, error: 'Repl introuvable.' });

  const result = await downloadRepl(repl, makeCookieHeader(cookies));
  res.json(result);
});

async function downloadRepl(repl, cookieHeader) {
  const slug = repl.slug || repl.title;
  const owner = repl.owner;
  const filename = `${owner}-${slug}.zip`;
  const filepath = path.join(DOWNLOADS_DIR, filename);

  // Replit native ZIP download URL
  const url = `https://replit.com/@${owner}/${slug}.zip`;

  try {
    const resp = await fetch(url, {
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/zip, application/octet-stream, */*',
        'Referer': `https://replit.com/@${owner}/${slug}`,
        'Origin': 'https://replit.com',
      },
      redirect: 'follow'
    });

    if (!resp.ok) {
      return { success: false, error: `HTTP ${resp.status} pour ${url}` };
    }

    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('text/html')) {
      // Check if it's a login redirect
      const snippet = await resp.text();
      if (snippet.includes('login') || snippet.includes('sign-in')) {
        return { success: false, error: 'Session expirée — exporte de nouveaux cookies.' };
      }
      return { success: false, error: 'Replit a retourné du HTML au lieu d\'un ZIP.' };
    }

    const buffer = await resp.buffer();
    if (buffer.length < 22) { // 22 bytes = minimum valid zip
      return { success: false, error: `Fichier trop petit (${buffer.length} bytes) — probablement une erreur.` };
    }

    fs.writeFileSync(filepath, buffer);
    db.prepare('UPDATE repls SET downloaded=1, download_path=?, download_size=? WHERE id=?')
      .run(filename, buffer.length, repl.id);

    return { success: true, filename, size: buffer.length, url: `/downloads/${filename}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Download all repls (background)
let downloadRunning = false;
app.post('/api/download-all', async (req, res) => {
  const cookies = getStoredCookies();
  if (!cookies) return res.json({ success: false, error: 'Aucun cookie.' });
  const total = db.prepare('SELECT COUNT(*) as c FROM repls').get().c;
  if (!total) return res.json({ success: false, error: 'Aucun repl. Lance d\'abord "Fetch Repls".' });

  if (downloadRunning) return res.json({ success: true, message: 'Téléchargement déjà en cours…', total });

  res.json({ success: true, message: `Démarrage du téléchargement de ${total} repls…`, total });
  
  downloadRunning = true;
  const cookieHeader = makeCookieHeader(cookies);
  const repls = db.prepare('SELECT * FROM repls WHERE downloaded=0').all();
  
  ;(async () => {
    for (const repl of repls) {
      await downloadRepl(repl, cookieHeader);
      await new Promise(r => setTimeout(r, 400)); // polite delay
    }
    downloadRunning = false;
  })().catch(e => { console.error('Download error:', e); downloadRunning = false; });
});

// Clear repls
app.post('/api/clear-repls', (req, res) => {
  db.prepare('DELETE FROM repls').run();
  res.json({ success: true });
});

// Logout
app.post('/api/logout', (req, res) => {
  db.prepare('DELETE FROM settings WHERE key IN (?,?,?,?)').run('cookies', 'username', 'user_id', 'email');
  res.json({ success: true });
});

// Direct file download
app.get('/api/file/:filename', (req, res) => {
  const fp = path.join(DOWNLOADS_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Fichier introuvable.' });
  res.download(fp);
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Replit Downloader sur le port ${PORT}`));
