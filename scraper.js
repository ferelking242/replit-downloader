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
  status: 'idle',
  step: '',
  screenshots: [],
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
    const filename = `${ts}-${name.replace(/[^a-z0-9]/gi, '_')}.png`;
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, filename), fullPage: false });
    stateObj.screenshots.push({ name, file: filename, ts });
    if (stateObj.screenshots.length > 60) stateObj.screenshots.shift();
    return filename;
  } catch { return null; }
}

function normalizeSameSite(v) {
  if (!v) return 'Lax';
  const val = String(v).toLowerCase();
  if (val === 'strict') return 'Strict';
  if (val === 'none' || val === 'no_restriction') return 'None';
  return 'Lax';
}

function normalizeCookies(cookies) {
  return cookies
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
}

// ─────────────────────────────────────────────────────────────────
// LIST REPLS — tries GraphQL API first, falls back to page scrape
// ─────────────────────────────────────────────────────────────────
async function listReplsViaGraphQL(context) {
  log('GraphQL: récupération de la liste des repls…');

  // Step 1: get current username
  const meQuery = `query { currentUser { username id } }`;
  const meResp = await context.request.post('https://replit.com/graphql', {
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://replit.com',
      'Referer': 'https://replit.com/',
    },
    data: JSON.stringify({ query: meQuery }),
    timeout: 20000,
  });

  if (!meResp.ok()) {
    throw new Error(`GraphQL auth check failed: HTTP ${meResp.status()}`);
  }

  const meBody = await meResp.json();
  if (!meBody?.data?.currentUser?.username) {
    throw new Error('Non connecté — cookies expirés ou invalides. Reconnecte-toi dans l\'onglet Connexion.');
  }

  const username = meBody.data.currentUser.username;
  log(`Connecté en tant que @${username}`);

  // Step 2: paginate through all repls
  const allRepls = [];
  let cursor = null;
  let page = 0;

  const replsQuery = `
    query userRepls($username: String!, $after: String) {
      userByUsername(username: $username) {
        publicRepls(count: 50, after: $after) {
          items {
            id
            title
            slug
            owner { username }
            isPrivate
          }
          pageInfo { hasNextPage nextCursor }
        }
      }
    }
  `;

  // Also try to get private repls via currentUser
  const privateQuery = `
    query {
      currentUser {
        repls(count: 50, after: null) {
          items {
            id title slug isPrivate
            owner { username }
          }
          pageInfo { hasNextPage nextCursor }
        }
      }
    }
  `;

  // Fetch public repls
  do {
    page++;
    log(`GraphQL page ${page} (cursor: ${cursor || 'début'})…`);
    const resp = await context.request.post('https://replit.com/graphql', {
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': 'https://replit.com',
        'Referer': 'https://replit.com/',
      },
      data: JSON.stringify({
        query: replsQuery,
        variables: { username, after: cursor },
      }),
      timeout: 20000,
    });

    if (!resp.ok()) break;
    const body = await resp.json();
    const data = body?.data?.userByUsername?.publicRepls;
    if (!data) break;

    for (const r of data.items || []) {
      if (!allRepls.find(x => x.slug === r.slug)) {
        allRepls.push({ slug: r.slug, title: r.title || r.slug, owner: r.owner?.username || username });
      }
    }

    if (data.pageInfo?.hasNextPage) {
      cursor = data.pageInfo.nextCursor;
    } else {
      cursor = null;
    }
  } while (cursor && page < 50);

  // Also try currentUser repls (includes private)
  try {
    let pCursor = null;
    let pPage = 0;
    const pQuery = `query currentRepls($after: String) {
      currentUser {
        repls(count: 50, after: $after) {
          items { id title slug isPrivate owner { username } }
          pageInfo { hasNextPage nextCursor }
        }
      }
    }`;
    do {
      pPage++;
      const pr = await context.request.post('https://replit.com/graphql', {
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': 'https://replit.com',
          'Referer': 'https://replit.com/',
        },
        data: JSON.stringify({ query: pQuery, variables: { after: pCursor } }),
        timeout: 20000,
      });
      if (!pr.ok()) break;
      const pb = await pr.json();
      const pd = pb?.data?.currentUser?.repls;
      if (!pd) break;
      for (const r of pd.items || []) {
        if (!allRepls.find(x => x.slug === r.slug)) {
          allRepls.push({ slug: r.slug, title: r.title || r.slug, owner: r.owner?.username || username });
        }
      }
      pCursor = pd.pageInfo?.hasNextPage ? pd.pageInfo.nextCursor : null;
    } while (pCursor && pPage < 50);
  } catch (e) {
    log('(Info: repls privés inaccessibles via currentUser)');
  }

  log(`GraphQL: ${allRepls.length} repls trouvés pour @${username}`);
  return allRepls;
}

// ─────────────────────────────────────────────────────────────────
// FALLBACK: scrape /repls page
// ─────────────────────────────────────────────────────────────────
async function listReplsViaPage(page) {
  log('Fallback: navigation vers replit.com…');

  // Try multiple dashboard URLs
  const candidates = [
    'https://replit.com/repls',
    'https://replit.com/dashboard',
    'https://replit.com/~',
  ];

  let url = '';
  for (const candidate of candidates) {
    try {
      log(`Essai: ${candidate}`);
      await page.goto(candidate, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);
      url = page.url();
      log('URL: ' + url);
      if (!url.includes('/login') && !url.includes('/signin')) break;
    } catch (e) {
      log(`Timeout sur ${candidate}: ${e.message}`);
    }
  }

  if (url.includes('/login') || url.includes('/signin')) {
    throw new Error('Redirigé vers login — cookies expirés. Reconnecte-toi dans l\'onglet Connexion.');
  }

  await autoScroll(page);

  let replData = await page.evaluate(() => {
    const results = []; const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/@"]')) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/@([\w-]+)\/([\w-]+)(?:$|[?#/])/);
      if (!m) continue;
      const key = m[1] + '/' + m[2];
      if (seen.has(key)) continue;
      seen.add(key);
      const title = a.querySelector('[class*="title"],[class*="name"],[class*="heading"]')?.textContent?.trim()
        || a.textContent?.trim().slice(0, 80) || m[2];
      results.push({ owner: m[1], slug: m[2], title });
    }
    return results;
  });

  if (replData.length === 0) {
    log('Fallback HTML scan…');
    const html = await page.content();
    const seen2 = new Set();
    for (const m of html.matchAll(/"slug":"([\w-]+)"[^}]{0,300}"username":"([\w-]+)"/g)) {
      const key = m[2] + '/' + m[1];
      if (!seen2.has(key)) { seen2.add(key); replData.push({ slug: m[1], title: m[1], owner: m[2] }); }
    }
  }

  return replData;
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
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    });

    const page = await context.newPage();

    loginState.step = 'Navigation vers replit.com/login…';
    await page.goto('https://replit.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await takeShot(page, 'login-page', loginState);

    loginState.step = 'Saisie de l\'email…';
    const emailSel = 'input[name="username"], input[type="email"], input[placeholder*="email" i], input[placeholder*="username" i]';
    await page.waitForSelector(emailSel, { timeout: 15000 });
    await page.fill(emailSel, email);
    await page.waitForTimeout(400);

    loginState.step = 'Saisie du mot de passe…';
    const passSel = 'input[type="password"]';
    await page.waitForSelector(passSel, { timeout: 10000 });
    await page.fill(passSel, password);
    await takeShot(page, 'filled-form', loginState);
    await page.waitForTimeout(300);

    loginState.step = 'Soumission du formulaire…';
    const submitSel = 'button[type="submit"], button:has-text("Log in"), button:has-text("Sign in"), button:has-text("Continue")';
    await page.click(submitSel);

    loginState.step = 'Attente de la réponse…';
    await takeShot(page, 'after-submit', loginState);

    let success = false;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(1000);
      const url = page.url();
      await takeShot(page, `poll-${i + 1}`, loginState);

      if (!url.includes('/login') && !url.includes('/signin')) {
        success = true;
        break;
      }

      const hasCaptcha = await page.evaluate(() =>
        !!(document.querySelector('iframe[src*="hcaptcha"]') ||
          document.querySelector('.h-captcha') ||
          document.querySelector('[data-hcaptcha-widget-id]') ||
          document.querySelector('iframe[src*="recaptcha"]'))
      ).catch(() => false);

      if (hasCaptcha) {
        loginState.status = 'waiting_captcha';
        loginState.step = 'Captcha détecté — utilise la méthode Cookies si bloqué.';
      }

      const hasError = await page.evaluate(() => {
        const t = document.body?.innerText || '';
        return t.includes('Invalid') || t.includes('incorrect') || t.includes('wrong') || t.includes('Incorrect');
      }).catch(() => false);
      if (hasError) throw new Error('Email ou mot de passe incorrect.');
    }

    if (!success) {
      throw new Error('Timeout: impossible de se connecter. Captcha non résolu ou identifiants incorrects.');
    }

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
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      acceptDownloads: true,
      downloadsPath: DOWNLOADS_DIR,
      viewport: { width: 1280, height: 900 },
    });

    log(`Injection de ${cookies.length} cookies…`);
    await context.addCookies(normalizeCookies(cookies));

    // Step 1: List repls via GraphQL (fast, reliable)
    state.status = 'collecting';
    let replData = [];

    try {
      replData = await listReplsViaGraphQL(context);
    } catch (gqlErr) {
      log(`GraphQL échoué: ${gqlErr.message}`);
      // If it's an auth error, throw immediately
      if (gqlErr.message.includes('expirés') || gqlErr.message.includes('connecté')) {
        throw gqlErr;
      }
      // Otherwise fallback to page scrape
      log('Fallback vers scraping de page…');
      state.status = 'navigating';
      const page = await context.newPage();
      page.setDefaultTimeout(30000);
      replData = await listReplsViaPage(page);
      if (state.debugMode) await takeShot(page, '01-page-fallback', state);
    }

    log(`Trouvé ${replData.length} repls`);

    if (replData.length === 0) {
      throw new Error('Aucun repl trouvé. Vérifie tes cookies ou ton compte.');
    }

    state.total = replData.length;
    state.repls = replData.map(r => ({ ...r, status: 'pending', file: null, error: null }));

    // Step 2: Download each repl
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
        log(`[${i + 1}/${state.repls.length}] ${repl.title}`);

        const response = await context.request.get(zipUrl, {
          timeout: 120000,
          headers: {
            'Accept': 'application/zip,application/octet-stream,*/*',
            'Referer': 'https://replit.com/',
          },
        });

        if (!response.ok()) throw new Error(`HTTP ${response.status()}`);

        const ct = response.headers()['content-type'] || '';
        if (ct.includes('text/html')) {
          const snippet = (await response.text()).slice(0, 120);
          throw new Error(`Réponse HTML (auth expirée?): ${snippet}`);
        }

        const body = await response.body();
        if (body.length < 22) throw new Error(`Archive trop petite (${body.length}B)`);

        fs.writeFileSync(filepath, body);
        const size = fs.statSync(filepath).size;
        repl.status = 'done'; repl.file = filename; repl.size = size;
        state.done++;
        log(`✓ ${repl.title} (${fmtBytes(size)})`);

        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        repl.status = 'error'; repl.error = e.message;
        state.failed++;
        log(`✗ ${repl.title}: ${e.message}`);
      }
    }

    state.status = 'done';
    log(`✅ Terminé — ${state.done} téléchargés, ${state.failed} erreurs.`);

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
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    });
    await context.addCookies(normalizeCookies(cookies));

    const zipUrl = `https://replit.com/@${repl.owner}/${repl.slug}.zip`;
    const filename = `${repl.owner}-${repl.slug}.zip`;
    const filepath = path.join(DOWNLOADS_DIR, filename);

    const response = await context.request.get(zipUrl, {
      timeout: 120000,
      headers: { 'Accept': 'application/zip,application/octet-stream,*/*' },
    });
    if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
    const body = await response.body();
    if (body.length < 22) throw new Error(`Archive trop petite (${body.length}B)`);

    fs.writeFileSync(filepath, body);
    const size = fs.statSync(filepath).size;
    repl.status = 'done'; repl.file = filename; repl.size = size;
    state.done = Math.min(state.done + 1, state.total);
    state.failed = Math.max(state.failed - 1, 0);
    log(`✓ Retry réussi: ${repl.title} (${fmtBytes(size)})`);
  } catch (e) {
    repl.status = 'error'; repl.error = e.message;
    log(`✗ Retry échoué: ${repl.title}: ${e.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
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
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

module.exports = { run, retryRepl, loginWithPassword, state, loginState };
