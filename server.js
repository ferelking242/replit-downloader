const express = require('express');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const session = require('express-session');
const scraper = require('./scraper');

const app = express();
const PORT = 5000;

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
[DOWNLOADS_DIR, SCREENSHOTS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const db = new Database('repls.db');
db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'replit-dl-2026',
  resave: false, saveUninitialized: true,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use('/downloads', express.static(DOWNLOADS_DIR));
app.use('/screenshots', express.static(SCREENSHOTS_DIR));

// ── Helpers ──────────────────────────────────────────────────────
const getSetting = k => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : null; };
const setSetting = (k, v) => db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(k, v);
const getStoredCookies = () => { const r = getSetting('cookies'); try { return r ? JSON.parse(r) : null; } catch { return null; } };

function decodeJwt(token) {
  try {
    const p = token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
    return JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
  } catch { return null; }
}

function extractIdentity(cookies) {
  const sc = cookies.find(c => c.name === 'connect.sid');
  const jwt = sc ? decodeJwt(sc.value) : null;
  const email = jwt?.email || '';
  const userId = jwt?.replit_user_id || null;
  const username = email ? email.split('@')[0] : (userId ? `user_${userId}` : null);
  return { email, userId, username };
}

// ── Static ───────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Auth status ──────────────────────────────────────────────────
app.get('/api/auth-status', (req, res) => {
  const cookies = getStoredCookies();
  if (!cookies) return res.json({ authenticated: false });
  const username = getSetting('username');
  if (username) return res.json({ authenticated: true, username });
  return res.json({ authenticated: false });
});

// ── Save cookies (manual paste) ──────────────────────────────────
app.post('/api/cookies', (req, res) => {
  const { cookies } = req.body;
  if (!Array.isArray(cookies) || !cookies.length)
    return res.json({ success: false, error: 'JSON invalide — doit être un tableau.' });

  const hasSession = cookies.some(c => ['connect.sid','__Host-session-sig','replit_authed'].includes(c.name));
  if (!hasSession)
    return res.json({ success: false, error: 'Cookie connect.sid manquant. Exporte TOUS les cookies de replit.com.' });

  const { email, username } = extractIdentity(cookies);
  setSetting('cookies', JSON.stringify(cookies));
  if (username) setSetting('username', username);
  if (email) setSetting('email', email);

  scraper.state.repls = [];
  scraper.state.status = 'idle';

  res.json({ success: true, message: `${cookies.length} cookies sauvegardés.`, username });
});

// ── Login via email + password (Playwright) ──────────────────────
app.post('/api/login-pw', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ success: false, error: 'Email et mot de passe requis.' });
  if (scraper.loginState.running) return res.json({ success: false, error: 'Connexion déjà en cours.' });

  // Fire async
  scraper.loginWithPassword(email, password).then(result => {
    if (result.success && result.cookies) {
      const { email: em, username } = extractIdentity(result.cookies);
      setSetting('cookies', JSON.stringify(result.cookies));
      if (username) setSetting('username', username);
      if (em) setSetting('email', em);
      scraper.state.repls = []; scraper.state.status = 'idle';
    }
  }).catch(console.error);

  res.json({ success: true, message: 'Connexion Chromium démarrée…' });
});

// ── Login status (poll) ──────────────────────────────────────────
app.get('/api/login-status', (req, res) => {
  const { running, status, step, error, screenshots } = scraper.loginState;
  res.json({ running, status, step, error, screenshots: (screenshots||[]).slice(-10) });
});

// ── Logout ───────────────────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  db.prepare("DELETE FROM settings WHERE key IN ('cookies','username','email')").run();
  scraper.state.repls = []; scraper.state.status = 'idle';
  res.json({ success: true });
});

// ── Toggle debug mode ────────────────────────────────────────────
app.post('/api/debug', (req, res) => {
  scraper.state.debugMode = !!req.body.enabled;
  res.json({ success: true, debugMode: scraper.state.debugMode });
});

// ── Start download ───────────────────────────────────────────────
app.post('/api/start', (req, res) => {
  const cookies = getStoredCookies();
  if (!cookies) return res.json({ success: false, error: 'Aucun cookie. Connecte-toi d\'abord.' });
  if (scraper.state.running) return res.json({ success: true, message: 'Déjà en cours…' });
  scraper.run(cookies).catch(console.error);
  res.json({ success: true });
});

// ── Retry single repl ────────────────────────────────────────────
app.post('/api/retry/:slug', (req, res) => {
  const cookies = getStoredCookies();
  if (!cookies) return res.json({ success: false, error: 'Pas de cookies.' });
  scraper.retryRepl(req.params.slug, cookies).catch(console.error);
  res.json({ success: true });
});

// ── Progress ─────────────────────────────────────────────────────
app.get('/api/progress', (req, res) => {
  const { running, status, total, done, failed, current, repls, log, error, debugMode, screenshots } = scraper.state;
  res.json({
    running, status, total, done, failed, current, error, debugMode,
    log: log.slice(-60),
    screenshots: (screenshots||[]).slice(-20),
    repls: repls.map(r => ({ title:r.title, slug:r.slug, owner:r.owner, status:r.status, file:r.file, size:r.size, error:r.error }))
  });
});

// ── List downloaded files ─────────────────────────────────────────
app.get('/api/files', (req, res) => {
  const files = fs.existsSync(DOWNLOADS_DIR)
    ? fs.readdirSync(DOWNLOADS_DIR).filter(f => f.endsWith('.zip')).map(f => {
        const stat = fs.statSync(path.join(DOWNLOADS_DIR, f));
        return { name: f, size: stat.size, mtime: stat.mtime };
      }).sort((a, b) => b.mtime - a.mtime)
    : [];
  res.json({ files });
});

// ── Delete a file ─────────────────────────────────────────────────
app.delete('/api/file/:filename', (req, res) => {
  const fp = path.join(DOWNLOADS_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Introuvable.' });
  fs.unlinkSync(fp);
  // Also clear from scraper state
  const repl = scraper.state.repls.find(r => r.file === path.basename(req.params.filename));
  if (repl) { repl.status = 'error'; repl.file = null; repl.error = 'Supprimé'; }
  res.json({ success: true });
});

// ── Serve a file ──────────────────────────────────────────────────
app.get('/api/file/:filename', (req, res) => {
  const fp = path.join(DOWNLOADS_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Introuvable.' });
  res.download(fp);
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Replit Downloader — port ${PORT}`));
