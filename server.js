const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const session = require('express-session');

const app = express();
const PORT = 5000;

// Ensure downloads directory exists
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// Database setup
const db = new Database('repls.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS repls (
    id TEXT PRIMARY KEY,
    slug TEXT,
    title TEXT,
    description TEXT,
    language TEXT,
    is_private INTEGER,
    url TEXT,
    owner TEXT,
    created_at TEXT,
    updated_at TEXT,
    downloaded INTEGER DEFAULT 0,
    download_path TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'replit-dl-secret-2024',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use('/downloads', express.static(DOWNLOADS_DIR));

// Helper: get cookies from session
function getCookieHeader(cookieArray) {
  if (!Array.isArray(cookieArray)) return '';
  return cookieArray.map(c => `${c.name}=${c.value}`).join('; ');
}

// Helper: get stored cookies
function getStoredCookies(req) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('cookies');
  if (row) {
    try { return JSON.parse(row.value); } catch { return null; }
  }
  return null;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Main dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Save cookies
app.post('/api/cookies', (req, res) => {
  try {
    const { cookies } = req.body;
    if (!cookies || !Array.isArray(cookies)) {
      return res.json({ success: false, error: 'Invalid cookies format. Must be a JSON array.' });
    }
    // Validate it has connect.sid or __Host-session-sig
    const hasSession = cookies.some(c => c.name === 'connect.sid' || c.name === '__Host-session-sig');
    if (!hasSession) {
      return res.json({ success: false, error: 'Missing session cookies (connect.sid or __Host-session-sig). Please export all cookies from replit.com.' });
    }
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('cookies', JSON.stringify(cookies));
    res.json({ success: true, message: `Saved ${cookies.length} cookies.` });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Check auth status
app.get('/api/auth-status', async (req, res) => {
  const cookies = getStoredCookies(req);
  if (!cookies) return res.json({ authenticated: false, reason: 'No cookies saved' });
  
  try {
    const cookieHeader = getCookieHeader(cookies);
    const resp = await fetch('https://replit.com/api/v0/user', {
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      }
    });
    if (resp.ok) {
      const data = await resp.json();
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('username', data.username || '');
      res.json({ authenticated: true, username: data.username, id: data.id });
    } else {
      res.json({ authenticated: false, reason: `HTTP ${resp.status}` });
    }
  } catch (e) {
    res.json({ authenticated: false, reason: e.message });
  }
});

// Fetch repl list from Replit
app.post('/api/fetch-repls', async (req, res) => {
  const cookies = getStoredCookies(req);
  if (!cookies) return res.json({ success: false, error: 'No cookies saved. Please add your cookies first.' });

  try {
    const cookieHeader = getCookieHeader(cookies);
    const usernameRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('username');
    const username = usernameRow ? usernameRow.value : null;

    if (!username) {
      return res.json({ success: false, error: 'Could not determine username. Please verify your cookies are valid.' });
    }

    // Use Replit's user repls API endpoint
    let allRepls = [];
    let after = null;
    let page = 0;
    const maxPages = 50;

    while (page < maxPages) {
      page++;
      // Use the GraphQL persisted query for user repls (dashboard repls list)
      const queryVars = {
        username,
        count: 50,
        after: after || undefined,
        pinnedReplsFirst: false,
        showUnnamed: true
      };

      // Try Replit's REST-like profile API first
      const profileUrl = `https://replit.com/data/repls/@${username}${after ? `?after=${after}` : ''}`;
      const resp = await fetch(profileUrl, {
        headers: {
          'Cookie': cookieHeader,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Referer': `https://replit.com/@${username}`,
          'X-Requested-With': 'XMLHttpRequest'
        }
      });

      if (!resp.ok) {
        // Fallback: GraphQL with known hash
        break;
      }

      const data = await resp.json();
      const repls = Array.isArray(data) ? data : (data.repls || data.userRepls || data.items || []);
      
      if (!repls.length) break;
      allRepls = allRepls.concat(repls);

      // Check for pagination
      const nextCursor = data.nextCursor || data.cursor || data.after;
      if (!nextCursor || repls.length < 50) break;
      after = nextCursor;
    }

    if (allRepls.length === 0) {
      // Fallback: Try GraphQL with persisted query hash
      const gqlResult = await fetchReplsGraphQL(cookieHeader, username);
      if (gqlResult.success) {
        allRepls = gqlResult.repls;
      }
    }

    // Store repls in DB
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO repls (id, slug, title, description, language, is_private, url, owner, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((repls) => {
      for (const r of repls) {
        const id = r.id || r.slug || `${username}-${r.title}`;
        const slug = r.slug || r.name || '';
        const title = r.title || r.name || slug;
        const lang = r.language || r.templateInfo?.label || r.lang || '';
        const isPrivate = r.isPrivate || r.private || 0;
        const url = r.url || `https://replit.com/@${username}/${slug}`;
        const owner = r.owner?.username || r.username || username;
        insertStmt.run(id, slug, title, r.description || '', lang, isPrivate ? 1 : 0, url, owner, r.timeCreated || '', r.timeUpdated || '');
      }
    });
    insertMany(allRepls);

    res.json({ success: true, count: allRepls.length, repls: allRepls.slice(0, 5) });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

async function fetchReplsGraphQL(cookieHeader, username) {
  // Known working persisted query hash for profileRepls
  const hashes = [
    'e5539818b4e7ca5f3a39ea5f5256e5ef8dac18ad02f6b61a7b83e5dde48bb8cb',
    '29c384d9f2e8fa929e24f21f4e7ba8dfecf7d79f79a87ae51a2c5e2e28f8b024'
  ];

  for (const hash of hashes) {
    try {
      const body = JSON.stringify({
        operationName: 'profileRepls',
        variables: { username, count: 100, pinnedReplsFirst: false, showUnnamed: true },
        extensions: { persistedQuery: { version: 1, sha256Hash: hash } }
      });
      const resp = await fetch('https://replit.com/graphql', {
        method: 'POST',
        headers: {
          'Cookie': cookieHeader,
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': 'Mozilla/5.0',
          'Referrer': `https://replit.com/@${username}`
        },
        body
      });
      if (resp.ok) {
        const data = await resp.json();
        const edges = data?.data?.user?.publicRepls?.items || data?.data?.user?.repls?.items || [];
        if (edges.length > 0) return { success: true, repls: edges };
      }
    } catch {}
  }
  return { success: false, repls: [] };
}

// Get all repls from DB
app.get('/api/repls', (req, res) => {
  const repls = db.prepare('SELECT * FROM repls ORDER BY updated_at DESC').all();
  res.json({ repls, total: repls.length });
});

// Download a single repl as ZIP
app.post('/api/download/:replId', async (req, res) => {
  const { replId } = req.params;
  const cookies = getStoredCookies(req);
  if (!cookies) return res.json({ success: false, error: 'No cookies saved.' });

  const repl = db.prepare('SELECT * FROM repls WHERE id = ?').get(replId);
  if (!repl) return res.json({ success: false, error: 'Repl not found.' });

  try {
    const cookieHeader = getCookieHeader(cookies);
    const usernameRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('username');
    const username = usernameRow ? usernameRow.value : repl.owner;

    // Replit native download URL
    const downloadUrl = `https://replit.com/@${repl.owner}/${repl.slug}.zip`;
    
    const resp = await fetch(downloadUrl, {
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/zip,*/*',
        'Referer': `https://replit.com/@${repl.owner}/${repl.slug}`
      },
      redirect: 'follow'
    });

    if (!resp.ok) {
      return res.json({ success: false, error: `Replit returned HTTP ${resp.status} for ${downloadUrl}` });
    }

    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      return res.json({ success: false, error: 'Replit redirected to login page. Your session may have expired.' });
    }

    const filename = `${repl.owner}-${repl.slug}.zip`;
    const filepath = path.join(DOWNLOADS_DIR, filename);
    
    const buffer = await resp.buffer();
    fs.writeFileSync(filepath, buffer);

    db.prepare('UPDATE repls SET downloaded = 1, download_path = ? WHERE id = ?').run(filename, replId);

    res.json({ success: true, filename, size: buffer.length, url: `/downloads/${filename}` });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Download ALL repls
app.post('/api/download-all', async (req, res) => {
  const cookies = getStoredCookies(req);
  if (!cookies) return res.json({ success: false, error: 'No cookies saved.' });

  const repls = db.prepare('SELECT * FROM repls').all();
  if (!repls.length) return res.json({ success: false, error: 'No repls found. Please fetch repls first.' });

  // Start async download job
  res.json({ success: true, message: `Starting download of ${repls.length} repls...`, total: repls.length });

  // Fire-and-forget background download
  downloadAllBackground(cookies, repls).catch(console.error);
});

async function downloadAllBackground(cookies, repls) {
  const cookieHeader = getCookieHeader(cookies);
  
  for (const repl of repls) {
    if (repl.downloaded) continue;
    try {
      const downloadUrl = `https://replit.com/@${repl.owner}/${repl.slug}.zip`;
      const resp = await fetch(downloadUrl, {
        headers: {
          'Cookie': cookieHeader,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/zip,*/*',
          'Referer': `https://replit.com/@${repl.owner}/${repl.slug}`
        },
        redirect: 'follow'
      });

      if (resp.ok) {
        const contentType = resp.headers.get('content-type') || '';
        if (!contentType.includes('text/html')) {
          const filename = `${repl.owner}-${repl.slug}.zip`;
          const filepath = path.join(DOWNLOADS_DIR, filename);
          const buffer = await resp.buffer();
          fs.writeFileSync(filepath, buffer);
          db.prepare('UPDATE repls SET downloaded = 1, download_path = ? WHERE id = ?').run(filename, repl.id);
        }
      }
      // Small delay to be polite
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.error(`Failed to download ${repl.slug}:`, e.message);
    }
  }
}

// Progress endpoint
app.get('/api/download-progress', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM repls').get().c;
  const downloaded = db.prepare('SELECT COUNT(*) as c FROM repls WHERE downloaded = 1').get().c;
  const repls = db.prepare('SELECT * FROM repls ORDER BY downloaded DESC, updated_at DESC').all();
  res.json({ total, downloaded, pending: total - downloaded, repls });
});

// Clear cookies
app.post('/api/logout', (req, res) => {
  db.prepare('DELETE FROM settings WHERE key = ?').run('cookies');
  db.prepare('DELETE FROM settings WHERE key = ?').run('username');
  res.json({ success: true });
});

// Clear all repls from DB
app.post('/api/clear-repls', (req, res) => {
  db.prepare('DELETE FROM repls').run();
  res.json({ success: true });
});

// Serve downloaded file
app.get('/api/file/:filename', (req, res) => {
  const filepath = path.join(DOWNLOADS_DIR, req.params.filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  res.download(filepath);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Replit Downloader running on port ${PORT}`);
});
