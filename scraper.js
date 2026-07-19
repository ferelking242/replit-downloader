// Playwright scraper — navigates replit.com/repls with real cookies,
// scrolls to load all repls, then downloads each via 3-dot → Download as ZIP
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const CHROMIUM_PATH = '/nix/store/43y6k6fj85l4kcd1yan43hpdld6nmjmp-ungoogled-chromium-131.0.6778.204/bin/chromium';
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

// Progress state shared with server
const state = {
  running: false,
  status: 'idle',
  total: 0,
  done: 0,
  failed: 0,
  current: '',
  repls: [],   // { title, slug, owner, status: 'pending'|'downloading'|'done'|'error', file, error }
  log: []
};

function log(msg) {
  console.log('[scraper]', msg);
  state.log.push(msg);
  if (state.log.length > 200) state.log.shift();
}

async function run(cookies) {
  if (state.running) return;
  state.running = true;
  state.status = 'starting';
  state.done = 0;
  state.failed = 0;
  state.repls = [];
  state.log = [];

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
    await page.goto('https://replit.com/repls', { waitUntil: 'networkidle', timeout: 45000 });

    // Check if logged in
    const url = page.url();
    log('URL courante: ' + url);
    if (url.includes('/login') || url.includes('/signin')) {
      throw new Error('Redirigé vers la page de login — tes cookies sont expirés. Exporte-en de nouveaux depuis replit.com.');
    }

    // ── Step 2: Scroll to load ALL repls ──────────────────────────────────
    state.status = 'loading';
    log('Scroll pour charger tous les repls…');
    await autoScroll(page);

    // ── Step 3: Collect all repl cards ────────────────────────────────────
    state.status = 'collecting';
    log('Collecte des repls…');

    // Replit repl cards have various selectors — try multiple
    const replData = await page.evaluate(() => {
      const results = [];
      // Try anchor tags that point to /@username/replname
      const links = Array.from(document.querySelectorAll('a[href*="/@"]'));
      const seen = new Set();
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/@([\w-]+)\/([\w-]+)$/);
        if (!m) continue;
        const key = m[1] + '/' + m[2];
        if (seen.has(key)) continue;
        seen.add(key);
        // Get title from nearby text
        const title = a.querySelector('[class*="title"],[class*="name"],[class*="heading"]')?.textContent?.trim()
          || a.textContent?.trim()
          || m[2];
        results.push({ owner: m[1], slug: m[2], title });
      }
      return results;
    });

    if (replData.length === 0) {
      // Fallback: try to extract from page text/JSON
      const pageContent = await page.content();
      const matches = [...pageContent.matchAll(/"slug":"([^"]+)","title":"([^"]+)"[^}]*"user":\{"username":"([^"]+)"/g)];
      for (const m of matches) {
        replData.push({ slug: m[1], title: m[2], owner: m[3] });
      }
    }

    log(`Trouvé ${replData.length} repls`);
    state.total = replData.length;
    state.repls = replData.map(r => ({ ...r, status: 'pending', file: null, error: null }));

    if (replData.length === 0) {
      throw new Error('Aucun repl trouvé sur la page. Essaie de te reconnecter à replit.com et de réexporter tes cookies.');
    }

    // ── Step 4: Download each repl via .zip URL ────────────────────────────
    state.status = 'downloading';
    log('Démarrage des téléchargements…');

    for (let i = 0; i < state.repls.length; i++) {
      const repl = state.repls[i];
      state.current = repl.title;
      repl.status = 'downloading';

      try {
        const filename = `${repl.owner}-${repl.slug}.zip`;
        const filepath = path.join(DOWNLOADS_DIR, filename);

        // Use page.goto to trigger the download via the native zip URL
        const zipUrl = `https://replit.com/@${repl.owner}/${repl.slug}.zip`;
        log(`[${i+1}/${state.repls.length}] Téléchargement: ${repl.title} → ${zipUrl}`);

        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 60000 }),
          page.goto(zipUrl, { waitUntil: 'commit', timeout: 30000 })
        ]);

        await download.saveAs(filepath);
        const stat = fs.statSync(filepath);

        if (stat.size < 22) {
          fs.unlinkSync(filepath);
          throw new Error(`Fichier trop petit (${stat.size} bytes)`);
        }

        repl.status = 'done';
        repl.file = filename;
        repl.size = stat.size;
        state.done++;
        log(`✓ ${repl.title} (${(stat.size/1024).toFixed(1)} KB)`);

        // Small pause between downloads
        await page.waitForTimeout(500);

      } catch (e) {
        repl.status = 'error';
        repl.error = e.message;
        state.failed++;
        log(`✗ ${repl.title}: ${e.message}`);
      }
    }

    state.status = 'done';
    log(`Terminé! ${state.done} téléchargés, ${state.failed} erreurs.`);

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
      const step = 800;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= document.body.scrollHeight * 3) {
          clearInterval(timer);
          resolve();
        }
      }, 300);
    });
  });
  await page.waitForTimeout(2000);
}

module.exports = { run, state };
