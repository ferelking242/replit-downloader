const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const CHROMIUM_PATH = '/nix/store/43y6k6fj85l4kcd1yan43hpdld6nmjmp-ungoogled-chromium-131.0.6778.204/bin/chromium';
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

// ── Download state ─────────────────────────────────────────────────
const state = {
  running: false,
  status: 'idle',
  total: 0, done: 0, failed: 0,
  current: '',
  repls: [],
  log: [],
  debugMode: false,
  screenshots: [],
  error: null,
};

// ── Login state ────────────────────────────────────────────────────
const loginState = {
  running: false,
  status: 'idle',  // idle | navigating | waiting_captcha | success | error
  step: '',
  screenshots: [],  // live browser screenshots
  error: null,
};

function log(msg) {
  console.log('[scraper]', msg);
  state.log.push(msg);
  if (state.log.length > 300) state.log.shift();
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function takeShot(page, name, stateObj) {
  try {
    ensureDir(SCREENSHOTS_DIR);
    const ts = Date.now();
    const filename = `${ts}-${name.replace(/[^a-z0-9]/gi,'_')}.png`;
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, filename), fullPage: false });
    stateObj.screenshots.push({ name, file: filename, ts });
    if (stateObj.screenshots.length > 60) stateObj.screenshots.shift();
    return filename;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────
// LOGIN via Playwright
// ─────────────────────────────────────────────────────────────────
async function loginWithPassword(email, password) {
  if (loginState.running) return;
  loginState.running = true;
  loginState.status = 'navigating';
  loginState.step = 'Lancement de Chromium…';
  loginState.screenshots = [];
  loginState.error = null;

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });

    const page = await context.newPage();

    loginState.step = 'Navigation vers replit.com/login…';
    await page.goto('https://replit.com/login', { waitUntil: 'networkidle', timeout: 30000 });
    await takeShot(page, 'login-page', loginState);

    // Fill email
    loginState.step = 'Saisie de l\'email…';
    const emailSel = 'input[name="username"], input[type="email"], input[placeholder*="email" i], input[placeholder*="username" i]';
    await page.waitForSelector(emailSel, { timeout: 10000 });
    await page.fill(emailSel, email);
    await page.waitForTimeout(400);

    // Fill password
    loginState.step = 'Saisie du mot de passe…';
    const passSel = 'input[type="password"]';
    await page.waitForSelector(passSel, { timeout: 5000 });
    await page.fill(passSel, password);
    await takeShot(page, 'filled-form', loginState);
    await page.waitForTimeout(300);

    // Submit
    loginState.step = 'Soumission du formulaire…';
    const submitSel = 'button[type="submit"], button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Continue")';
    await page.click(submitSel);

    // Wait for navigation or captcha
    loginState.step = 'Attente de la réponse…';
    await takeShot(page, 'after-submit', loginState);

    // Poll for up to 30s: success = redirect away from /login, or captcha
    let success = false;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000);
      const url = page.url();
      await takeShot(page, `poll-${i+1}`, loginState);

      if (!url.includes('/login') && !url.includes('/signin')) {
        success = true;
        break;
      }

      // Check for captcha
      const hasCaptcha = await page.evaluate(() =>
        !!(document.querySelector('iframe[src*="hcaptcha"]') ||
           document.querySelector('.h-captcha') ||
           document.querySelector('[data-hcaptcha-widget-id]') ||
           document.querySelector('iframe[src*="recaptcha"]'))
      ).catch(() => false);

      if (hasCaptcha) {
        loginState.status = 'waiting_captcha';
        loginState.step = 'Captcha détecté — vérifie les screenshots et utilise la méthode Cookies si bloqué.';
        // Keep polling in case it auto-resolves
      }

      // Check for wrong-password error
      const hasError = await page.evaluate(() => {
        const t = document.body?.innerText || '';
        return t.includes('Invalid') || t.includes('incorrect') || t.includes('wrong') || t.includes('Incorrect');
      }).catch(() => false);
      if (hasError) throw new Error('Email ou mot de passe incorrect.');
    }

    if (!success) {
      throw new Error('Timeout: impossible de se connecter. Captcha non résolu ou identifiants incorrects.');
    }

    // Extract cookies
    loginState.step = 'Connexion réussie — extraction des cookies…';
    loginState.status = 'success';
    const cookies = await context.cookies();
    await takeShot(page, 'success', loginState);
    return { success: true, cookies };

  } catch (e) {
    loginState.status = 'error';
    loginState.error = e.message;
    return { success: false, error: e.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
    loginState.running = false;
    if (loginState.status !== 'success' && loginState.status !== 'error') {
      loginState.status = 'idle';
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// DOWNLOAD repls
// ─────────────────────────────────────────────────────────────────
async function run(cookies) {
  if (state.running) return;
  state.running = true;
  state.status = 'starting';
  state.done = 0; state.failed = 0;
  state.repls = []; state.log = [];
  state.screenshots = []; state.error = null;

  ensureDir(DOWNLOADS_DIR);

  let browser;
  try {
    log('Lancement de Chromium…');
    browser = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      acceptDownloads: true,
      downloadsPath: DOWNLOADS_DIR,
      viewport: { width: 1280, height: 900 },
    });

    log(`Injection de ${cookies.length} cookies…`);
    const playwrightCookies = cookies
      .filter(c => c.name && c.value)
      .map(c => ({
        name: c.name, value: c.value,
        domain: c.domain || '.replit.com',
        path: c.path || '/',
        secure: c.secure || false,
        httpOnly: c.httpOnly || false,
        sameSite: normalizeSameSite(c.sameSite),
        expires: c.expirationDate ? Math.floor(c.expirationDate) : undefined,
      }));
    await context.addCookies(playwrightCookies);

    const page = await context.newPage();
    page.setDefaultTimeout(30000);

    // Step 1: Navigate
    state.status = 'navigating';
    log('Navigation vers replit.com/repls…');
    await page.goto('https://replit.com/repls', { waitUntil: 'networkidle', timeout: 60000 });

    const url = page.url();
    log('URL: ' + url);
    if (state.debugMode) await takeShot(page, '01-navigation', state);

    if (url.includes('/login') || url.includes('/signin')) {
      if (state.debugMode) await takeShot(page, 'login-redirect', state);
      throw new Error('Redirigé vers login — cookies expirés. Reconnecte-toi et exporte de nouveaux cookies.');
    }

    // Step 2: Scroll
    state.status = 'loading';
    log('Scroll pour charger tous les repls…');
    await autoScroll(page);
    if (state.debugMode) await takeShot(page, '02-scroll', state);

    // Step 3: Collect
    state.status = 'collecting';
    log('Collecte des repls…');

    let replData = await page.evaluate(() => {
      const results = []; const seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/@"]')) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/@([\w-]+)\/([\w-]+)(?:$|[?#/])/);
        if (!m) continue;
        const key = m[1]+'/'+m[2];
        if (seen.has(key)) continue;
        seen.add(key);
        const title = a.querySelector('[class*="title"],[class*="name"],[class*="heading"]')?.textContent?.trim()
          || a.textContent?.trim().slice(0,80) || m[2];
        results.push({ owner: m[1], slug: m[2], title });
      }
      return results;
    });

    if (replData.length === 0) {
      log('Fallback: scan HTML…');
      const html = await page.content();
      const seen2 = new Set();
      for (const m of html.matchAll(/"slug":"([\w-]+)"[^}]{0,300}"username":"([\w-]+)"/g)) {
        const key = m[2]+'/'+m[1];
        if (!seen2.has(key)) { seen2.add(key); replData.push({ slug: m[1], title: m[1], owner: m[2] }); }
      }
    }

    log(`Trouvé ${replData.length} repls`);
    if (state.debugMode) await takeShot(page, '03-collected', state);

    state.total = replData.length;
    state.repls = replData.map(r => ({ ...r, status: 'pending', file: null, error: null }));

    if (replData.length === 0) {
      throw new Error('Aucun repl trouvé. Cookies expirés ou compte vide.');
    }

    // Step 4: Download
    state.status = 'downloading';
    log('Démarrage des téléchargements…');

    for (let i = 0; i < state.repls.length; i++) {
      const repl = state.repls[i];
      state.current = repl.title;
      repl.status = 'downloading';

      try {
        const filename = `${repl.owner}-${repl.slug}.zip`;
        const filepath = path.join(DOWNLOADS_DIR, filename);
        const zipUrl = `https://replit.com/@${repl.owner}/${repl.slug}.zip`;
        log(`[${i+1}/${state.repls.length}] ${repl.title}`);

        const response = await context.request.get(zipUrl, {
          timeout: 120000,
          headers: { 'Accept': 'application/zip,application/octet-stream,*/*', 'Referer': 'https://replit.com/repls' },
        });

        if (!response.ok()) throw new Error(`HTTP ${response.status()}`);

        const ct = response.headers()['content-type'] || '';
        if (ct.includes('text/html')) {
          const snippet = (await response.text()).slice(0,120);
          throw new Error(`Réponse HTML (auth expirée?): ${snippet}`);
        }

        const body = await response.body();
        if (body.length < 22) throw new Error(`Archive trop petite (${body.length}B)`);

        fs.writeFileSync(filepath, body);
        const size = fs.statSync(filepath).size;
        repl.status = 'done'; repl.file = filename; repl.size = size;
        state.done++;
        log(`✓ ${repl.title} (${fmtBytes(size)})`);

        await page.waitForTimeout(600);
      } catch (e) {
        repl.status = 'error'; repl.error = e.message;
        state.failed++;
        log(`✗ ${repl.title}: ${e.message}`);
        if (state.debugMode) await takeShot(page, `err-${repl.slug}`, state);
      }
    }

    state.status = 'done';
    log(`✅ Terminé — ${state.done} téléchargés, ${state.failed} erreurs.`);
    if (state.debugMode) await takeShot(page, '04-done', state);

  } catch (e) {
    state.status = 'error'; state.error = e.message;
    log('ERREUR: ' + e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    state.running = false; state.current = '';
  }
}

// ── Retry a single failed repl ─────────────────────────────────────
async function retryRepl(slug, cookies) {
  const repl = state.repls.find(r => r.slug === slug);
  if (!repl || repl.status === 'done') return;
  repl.status = 'downloading'; repl.error = null;

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: CHROMIUM_PATH, headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
    });
    const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
    await context.addCookies(cookies.filter(c=>c.name&&c.value).map(c=>({
      name:c.name, value:c.value, domain:c.domain||'.replit.com', path:c.path||'/',
      secure:c.secure||false, httpOnly:c.httpOnly||false, sameSite:normalizeSameSite(c.sameSite),
      expires:c.expirationDate?Math.floor(c.expirationDate):undefined,
    })));

    const zipUrl = `https://replit.com/@${repl.owner}/${repl.slug}.zip`;
    const filename = `${repl.owner}-${repl.slug}.zip`;
    const filepath = path.join(DOWNLOADS_DIR, filename);

    const response = await context.request.get(zipUrl, { timeout: 120000 });
    if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
    const body = await response.body();
    if (body.length < 22) throw new Error(`Archive trop petite (${body.length}B)`);

    fs.writeFileSync(filepath, body);
    const size = fs.statSync(filepath).size;
    repl.status = 'done'; repl.file = filename; repl.size = size;
    state.done = Math.min(state.done + 1, state.total);
    state.failed = Math.max(state.failed - 1, 0);
    log(`✓ Retry réussi: ${repl.title} (${fmtBytes(size)})`);
  } catch(e) {
    repl.status = 'error'; repl.error = e.message;
    log(`✗ Retry échoué: ${repl.title}: ${e.message}`);
  } finally {
    if (browser) await browser.close().catch(()=>{});
  }
}

function normalizeSameSite(v) {
  if (!v) return 'Lax';
  const val = String(v).toLowerCase();
  if (val === 'strict') return 'Strict';
  if (val === 'none' || val === 'no_restriction') return 'None';
  return 'Lax';
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let total = 0, stuckCount = 0, lastH = document.body.scrollHeight;
      const t = setInterval(() => {
        window.scrollBy(0, 900); total += 900;
        const h = document.body.scrollHeight;
        if (h === lastH) { if (++stuckCount >= 5) { clearInterval(t); resolve(); } }
        else { stuckCount = 0; lastH = h; }
        if (total > 80000) { clearInterval(t); resolve(); }
      }, 350);
    });
  });
  await page.waitForTimeout(2000);
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n/1024).toFixed(1)+' KB';
  return (n/1048576).toFixed(1)+' MB';
}

module.exports = { run, retryRepl, loginWithPassword, state, loginState };
