// Playwright scraper — navigates replit.com/repls with real cookies,
// scrolls to load all repls, then downloads each via Playwright request API.
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const CHROMIUM_PATH = '/nix/store/43y6k6fj85l4kcd1yan43hpdld6nmjmp-ungoogled-chromium-131.0.6778.204/bin/chromium';
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

// Progress state shared with server
const state = {
  running: false,
  status: 'idle',
  total: 0,
  done: 0,
  failed: 0,
  current: '',
  repls: [],   // { title, slug, owner, status, file, size, error }
  log: [],
  debugMode: false,
  screenshots: [],  // { name, file, ts }
  error: null,
};

function log(msg) {
  console.log('[scraper]', msg);
  state.log.push(msg);
  if (state.log.length > 300) state.log.shift();
}

async function screenshot(page, name) {
  if (!state.debugMode) return;
  try {
    if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    const ts = Date.now();
    const filename = `${ts}-${name.replace(/[^a-z0-9]/gi, '_')}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: false });
    state.screenshots.push({ name, file: filename, ts });
    if (state.screenshots.length > 50) state.screenshots.shift();
    log(`📸 Screenshot: ${name}`);
  } catch (e) {
    log(`⚠ Screenshot failed: ${e.message}`);
  }
}

async function run(cookies) {
  if (state.running) return;
  state.running = true;
  state.status = 'starting';
  state.done = 0;
  state.failed = 0;
  state.repls = [];
  state.log = [];
  state.screenshots = [];
  state.error = null;

  if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

  let browser;
  try {
    log('Lancement de Chromium…');
    browser = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      acceptDownloads: true,
      downloadsPath: DOWNLOADS_DIR,
      viewport: { width: 1280, height: 900 },
    });

    // Inject all cookies
    log(`Injection de ${cookies.length} cookies…`);
    const playwrightCookies = cookies
      .filter(c => c.name && c.value)
      .map(c => ({
        name: c.name,
        value: c.value,
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

    // ── Step 1: Navigate to /repls ─────────────────────────────────────────
    state.status = 'navigating';
    log('Navigation vers replit.com/repls…');
    await page.goto('https://replit.com/repls', { waitUntil: 'networkidle', timeout: 60000 });

    const url = page.url();
    log('URL courante: ' + url);
    await screenshot(page, '01-after-navigation');

    if (url.includes('/login') || url.includes('/signin')) {
      await screenshot(page, '01-login-redirect');
      throw new Error('Redirigé vers login — cookies expirés. Exporte des cookies frais depuis replit.com.');
    }

    // ── Step 2: Scroll to load ALL repls ──────────────────────────────────
    state.status = 'loading';
    log('Scroll pour charger tous les repls…');
    await autoScroll(page);
    await screenshot(page, '02-after-scroll');

    // ── Step 3: Collect repl cards ────────────────────────────────────────
    state.status = 'collecting';
    log('Collecte des repls…');

    let replData = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Strategy 1: anchor tags with /@username/replname pattern
      const links = Array.from(document.querySelectorAll('a[href*="/@"]'));
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/@([\w-]+)\/([\w-]+)(?:$|[?#/])/);
        if (!m) continue;
        const key = m[1] + '/' + m[2];
        if (seen.has(key)) continue;
        seen.add(key);
        const title = a.querySelector('[class*="title"],[class*="name"],[class*="heading"]')?.textContent?.trim()
          || a.textContent?.trim()
          || m[2];
        results.push({ owner: m[1], slug: m[2], title: title.slice(0, 100) });
      }
      return results;
    });

    // Fallback: scan page HTML for JSON patterns
    if (replData.length === 0) {
      log('Aucun repl via liens — tentative via HTML brut…');
      await screenshot(page, '03-no-repls-found');
      const html = await page.content();

      // Pattern 1: slug+title+user object
      const matches1 = [...html.matchAll(/"slug":"([^"]+)","[^"]*":"[^"]*"[^}]*?"title":"([^"]+)"[^}]*?"username":"([^"]+)"/g)];
      for (const m of matches1) {
        replData.push({ slug: m[1], title: m[2], owner: m[3] });
      }

      // Pattern 2: simpler slug/owner
      if (replData.length === 0) {
        const matches2 = [...html.matchAll(/"slug":"([\w-]+)"[^}]{0,200}"username":"([\w-]+)"/g)];
        const seen2 = new Set();
        for (const m of matches2) {
          const key = m[2] + '/' + m[1];
          if (!seen2.has(key)) { seen2.add(key); replData.push({ slug: m[1], title: m[1], owner: m[2] }); }
        }
      }
    }

    log(`Trouvé ${replData.length} repls`);
    state.total = replData.length;
    state.repls = replData.map(r => ({ ...r, status: 'pending', file: null, error: null }));

    if (replData.length === 0) {
      await screenshot(page, '04-zero-repls');
      throw new Error('Aucun repl trouvé. Vérifie que tu es connecté sur replit.com et que tes cookies sont frais.');
    }

    await screenshot(page, '03-repls-collected');

    // ── Step 4: Download each repl via Playwright request API ─────────────
    // Using context.request.get() instead of page.goto() to avoid ERR_ABORTED
    // The request API carries all session cookies from the context automatically.
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

        log(`[${i+1}/${state.repls.length}] Téléchargement: ${repl.title} → ${zipUrl}`);

        // ✅ Fixed approach: use Playwright's request API (carries cookies, no navigation abort)
        const response = await context.request.get(zipUrl, {
          timeout: 120000,
          headers: {
            'Accept': 'application/zip,application/octet-stream,*/*',
            'Referer': 'https://replit.com/repls',
          }
        });

        if (!response.ok()) {
          throw new Error(`HTTP ${response.status()} — ${response.statusText()}`);
        }

        const contentType = response.headers()['content-type'] || '';
        if (contentType.includes('text/html')) {
          // Got HTML back — likely a redirect to login or 404 page
          const bodyText = (await response.text()).slice(0, 200);
          throw new Error(`Réponse HTML reçue (auth expirée?). Début: ${bodyText}`);
        }

        const body = await response.body();
        if (body.length < 22) {
          throw new Error(`Archive trop petite (${body.length} bytes) — repl vide ou erreur auth`);
        }

        fs.writeFileSync(filepath, body);
        const stat = fs.statSync(filepath);

        repl.status = 'done';
        repl.file = filename;
        repl.size = stat.size;
        state.done++;
        log(`✓ ${repl.title} (${fmtBytes(stat.size)})`);

        // Optionally take a debug screenshot every few repls
        if (state.debugMode && i % 5 === 0) {
          await screenshot(page, `05-progress-${i+1}`);
        }

        // Small pause to be polite to Replit's servers
        await page.waitForTimeout(800);

      } catch (e) {
        repl.status = 'error';
        repl.error = e.message;
        state.failed++;
        log(`✗ ${repl.title}: ${e.message}`);
        if (state.debugMode) {
          await screenshot(page, `05-error-${repl.slug}`);
        }
      }
    }

    state.status = 'done';
    log(`Terminé! ${state.done} téléchargés, ${state.failed} erreurs.`);
    await screenshot(page, '06-finished');

  } catch (e) {
    state.status = 'error';
    state.error = e.message;
    log('ERREUR: ' + e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    state.running = false;
    state.current = '';
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
      let total = 0;
      const step = 900;
      let lastHeight = document.body.scrollHeight;
      let stuckCount = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        const newHeight = document.body.scrollHeight;
        if (newHeight === lastHeight) {
          stuckCount++;
          if (stuckCount >= 5) { clearInterval(timer); resolve(); return; }
        } else {
          stuckCount = 0;
          lastHeight = newHeight;
        }
        if (total > 60000) { clearInterval(timer); resolve(); }
      }, 350);
    });
  });
  await page.waitForTimeout(2000);
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

module.exports = { run, state };
