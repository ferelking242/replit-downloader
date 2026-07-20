const express = require('express');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const session = require('express-session');
const scraper = require('./scraper');

const app = express();
const PORT = 5000;

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

const db = new Database('repls.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'replit-dl-2026',
  resave: false, saveUninitialized: true,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use('/downloads', express.static(DOWNLOADS_DIR));

// ── Helpers ────────────────────────────────────────────────────────
function getSetting(k) { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : null; }
function setSetting(k, v) { db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(k, v); }
function getStoredCookies() { const r = getSetting('cookies'); try { return r ? JSON.parse(r) : null; } catch { return null; } }

function decodeJwt(token) {
  try {
    const p = token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
    return JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
  } catch { return null; }
}

// ── Routes ─────────────────────────────────────────────────────────

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Save cookies
app.post('/api/cookies', (req, res) => {
  const { cookies } = req.body;
  if (!Array.isArray(cookies) || !cookies.length)
    return res.json({ success: false, error: 'JSON invalide — doit être un tableau.' });

  const hasSession = cookies.some(c => ['connect.sid','__Host-session-sig','replit_authed'].includes(c.name));
  if (!hasSession)
    return res.json({ success: false, error: 'Cookie connect.sid manquant. Exporte TOUS les cookies de replit.com.' });

  // Decode username from JWT
  const sc = cookies.find(c => c.name === 'connect.sid');
  const jwt = sc ? decodeJwt(sc.value) : null;
  const email = jwt?.email || '';
  const userId = jwt?.replit_user_id || null;
  const username = email ? email.split('@')[0] : (userId ? `user_${userId}` : null);

  setSetting('cookies', JSON.stringify(cookies));
  if (username) setSetting('username', username);
  if (email) setSetting('email', email);

  // Clear old scraper data when new cookies saved
  scraper.state.repls = [];
  scraper.state.status = 'idle';

  res.json({ success: true, message: `${cookies.length} cookies sauvegardés.`, username });
});

// Auth status
app.get('/api/auth-status', (req, res) => {
  const cookies = getStoredCookies();
  if (!cookies) return res.json({ authenticated: false, reason: 'Aucun cookie.' });
  const username = getSetting('username');
  if (username) return res.json({ authenticated: true, username });
  return res.json({ authenticated: false, reason: 'Clique Save Cookies.' });
});

// Logout
app.post('/api/logout', (req, res) => {
  db.prepare("DELETE FROM settings WHERE key IN ('cookies','username','email')").run();
  scraper.state.repls = [];
  scraper.state.status = 'idle';
  res.json({ success: true });
});

// ── Scraper ─────────────────────────────────────────────────────────

// Start scrape + download everything
app.post('/api/start', (req, res) => {
  const cookies = getStoredCookies();
  if (!cookies) return res.json({ success: false, error: 'Aucun cookie.' });
  if (scraper.state.running) return res.json({ success: true, message: 'Déjà en cours…' });

  // Fire and forget
  scraper.run(cookies).catch(console.error);
  res.json({ success: true, message: 'Chromium lancé — ça prend 30–60 sec.' });
});

// Live progress
app.get('/api/progress', (req, res) => {
  const { running, status, total, done, failed, current, repls, log, error, debugMode, screenshots } = scraper.state;
  res.json({ running, status, total, done, failed, current, error, debugMode,
    log: log.slice(-50),
    screenshots: (screenshots || []).slice(-20),
    repls: repls.map(r => ({ title: r.title, slug: r.slug, owner: r.owner, status: r.status, file: r.file, size: r.size, error: r.error }))
  });
});

// Toggle debug mode
app.post('/api/debug', (req, res) => {
  const { enabled } = req.body;
  scraper.state.debugMode = !!enabled;
  res.json({ success: true, debugMode: scraper.state.debugMode });
});

// Serve screenshots
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
app.use('/screenshots', express.static(SCREENSHOTS_DIR));

// Download a single file
app.get('/api/file/:filename', (req, res) => {
  const fp = path.join(DOWNLOADS_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Introuvable.' });
  res.download(fp);
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Replit Downloader sur port ${PORT}`));
