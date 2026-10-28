// GOETHE RACER - the fast version of the bot.
//
// Why this is faster than bot.js: bot.js reloaded the whole exam page every
// 2 seconds and lost ~12s at the opening moment. This one keeps one page open
// and fires tiny background requests from inside it (~3 per second), then the
// instant the seat appears it claims the booking session and drives the whole
// booking through background requests too - no page rendering anywhere.
//
// Usage:
//   node racer.js                  # live, Lahore
//   node racer.js --city=Islamabad
//   node racer.js --dry            # stop before the final ORDER click
//   node racer.js --date=19.09     # only book a row matching this date

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = {};
process.argv.slice(2).forEach(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args[m[1]] = m[2] !== undefined ? m[2] : true;
});

const CONFIG = {
  CITY: args.city || 'Lahore',
  TARGET_DATE: args.date || '',
  EXAM_URL: args.url || 'https://www.goethe.de/ins/pk/en/spr/prf/gzb1.cfm',
  // background request cadence, seconds
  POLL_SEC: 1.0,
  // flat-out cadence in the final minutes before the opening moment
  TURBO_POLL_SEC: 0.25,
  ULTRA_POLL_SEC: 0.08,   // last 60s before the opening: maximum rate (12/s, tested safe at 16/s)
  // arm turbo this many seconds before the row's own advertised opening time
  TURBO_LEAD_SEC: Number(args.lead || 180),   // --lead=99999: force turbo NOW (testing)
  // how long turbo stays on after the opening moment
  TURBO_MINUTES: 10,
  // experimental: fire booking-entry requests this many seconds before the
  // advertised opening, using the product code from the locked row
  PREHAMMER: !!args.prehammer,
  PREHAMMER_LEAD_SEC: Number(args['prehammer-lead'] || 30),
  // CONTESTED-OPENING MODE (the 04.09 Lahore lesson): at a mass opening,
  // Akamai boxes IPs that poll fast and hammer the entry - our proxy IP got
  // 429-blocked 11s after the flip and stayed blind for 28 minutes while the
  // seats drained. --calm polls at 1/s and enters patiently: ~0.5s slower
  // to detect, but does not get locked out. The watcher launches racers in
  // calm mode by default. --fast restores the old aggressive behavior.
  CALM: args.calm !== undefined ? !!args.calm : !args.fast,
  // base 429 cooldown (calm mode): race-day forensics showed the ban lasted
  // 27+ minutes, so short pauses only kept poking a banned IP. --cool=60 slows further.
  COOL_SEC: Number(args.cool || 30),
  // stop before the final ORDER click
  DRY_RUN: !!args.dry,
  HOLD_SEC: Number(args.hold || 0),   // --hold=120: at review, hold the seat N sec (experiment)
  ATTACH: !!args.attach,              // --attach: use the already-running Brave (2nd instance)
  // The exam rows advertise their opening time in PAKISTAN time (e.g.
  // "04.09.2026 11:12"). The racer converts that to a real moment using this
  // offset, so it works on any machine clock (your PC = PKT, the RDP = UTC).
  TZ_OFFSET_HOURS: Number(args.tz !== undefined ? args.tz : 5),
  BRAVE_PATH: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  CDP_PORT: Number(args.port || 9222),
  // second racer on the SAME machine (e.g. booking for a friend): give it
  // its own profile, port, proxy config AND relay port, e.g.
  //   node racer.js --port=9223 --profile=brave-profile-friend \
  //     --proxy=proxy-friend.json --relay=3129 --creds=creds-friend.json
  PROFILE_DIR: args.profile ? path.resolve(String(args.profile)) : path.join(__dirname, 'brave-profile'),
  RELAY_PORT: Number(args.relay || 3128),
};

let CREDS = { email: '', password: '' };
try {
  const credFile = args.creds ? path.resolve(String(args.creds)) : path.join(__dirname, 'creds.json');
  CREDS = { ...CREDS, ...JSON.parse(fs.readFileSync(credFile, 'utf8')) };
} catch (e) {}

// Optional proxy: if proxy.json exists, ALL traffic goes through it
// (via the local relay started by ensureBrave). --proxy=<file> picks a
// different proxy config (second racer for a friend on another exit IP).
let PROXY = null;
try {
  const proxyFile = args.proxy ? path.resolve(String(args.proxy)) : path.join(__dirname, 'proxy.json');
  PROXY = JSON.parse(fs.readFileSync(proxyFile, 'utf8'));
  PROXY.__file = path.basename(proxyFile); // relay reads the same config
} catch (e) {}

const LOG_FILE = path.join(__dirname, 'racer.log');
// Wording the portal uses when the race is lost (from other bots' live
// sessions, EN + DE). Checked against page HTML we already hold - free.
// NOTE: "Fully booked" is deliberately NOT here - on the options page it is
// a per-MODULE availability label (some modules full, others bookable).
const LOST_RACE_RE = /already booked|bereits gebucht|slot full|platz voll|no slots|keine pl[aä]tze|maximale teilnehmerzahl|max participants/i;
// Forensic event log: every timing that matters, one JSON object per line,
// millisecond timestamps. Post-mortem material for after the race.
const EV_FILE = path.join(__dirname, 'race-events.jsonl');
function ev(type, data) {
  try { fs.appendFileSync(EV_FILE, JSON.stringify(Object.assign({ t: Date.now(), type }, data || {})) + '\n', 'utf8'); } catch (e) {}
}
function log(msg) {
  const line = `[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (e) {}
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function beep(times = 1) {
  // ONE powershell process for all beeps. Spawning several at once hogs a
  // weak RDP vCPU for seconds - and beep(3) fires exactly at ENTRY SECURED,
  // stealing the CPU from the booking steps that follow (measured: the first
  // form POST started 2.5s late on the RDP, instantly on a fast PC).
  const one = '[console]::beep(1000,250);[console]::beep(1400,350);';
  try {
    spawn('powershell.exe', ['-NoProfile', '-Command', one.repeat(Math.max(1, times))], { stdio: 'ignore' });
  } catch (e) {}
}
async function alarm(headline) {
  console.log('\n' + '='.repeat(60));
  console.log('  *** ' + headline + ' ***');
  console.log('='.repeat(60) + '\n');
  for (let i = 0; i < 15; i++) { beep(); await sleep(700); }
}

let bravePID = null; // only OUR Brave process (never kill other instances)

async function ensureBrave() {
  const check = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${CONFIG.CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch (e) { return false; }
  };
  if (CONFIG.ATTACH) {
    // attach to an already-running Brave (e.g. a second racer instance on
    // another profile/port) - never kill or launch anything
    const check = () => fetch(`http://127.0.0.1:${CONFIG.CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) }).then(() => true).catch(() => false);
    for (let i = 0; i < 10; i++) { if (await check()) { log(`Attaching to Brave on port ${CONFIG.CDP_PORT}.`); return; } await sleep(1000); }
    throw new Error(`No Brave on port ${CONFIG.CDP_PORT} - start it first.`);
  }
  if (await check() && !(PROXY && PROXY.host)) {
    log('Brave already running with debug port.');
    return;
  }
  // A previous Brave WE launched (same racer) may be holding the profile -
  // kill only OUR process, never all Brave instances: a second racer for a
  // friend may be racing on this same machine right now.
  if (bravePID) {
    try { spawn('taskkill', ['/PID', String(bravePID), '/F', '/T'], { stdio: 'ignore' }); } catch (e) {}
    bravePID = null;
    await sleep(2000);
  }

  // If a proxy is configured, start the local relay (holds the password for
  // Brave, which cannot send proxy passwords itself) and launch Brave through
  // it. If no proxy config, everything goes direct as before.
  const braveArgs = [
    `--remote-debugging-port=${CONFIG.CDP_PORT}`,
    `--user-data-dir=${CONFIG.PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1400,950',
  ];
  if (PROXY && PROXY.host) {
    const relayOk = () => new Promise((resolve) => {
      const net = require('net');
      const s = net.connect(CONFIG.RELAY_PORT, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
      setTimeout(() => { s.destroy(); resolve(false); }, 1000);
    });
    if (!(await relayOk())) {
      log('Starting local proxy relay (proxyauth.js)...');
      const relay = spawn('node', [path.join(__dirname, 'proxyauth.js'), String(CONFIG.RELAY_PORT), PROXY.__file || ''], { detached: true, stdio: 'ignore' });
      relay.unref();
      for (let i = 0; i < 10; i++) { await sleep(500); if (await relayOk()) break; }
    }
    braveArgs.push(`--proxy-server=http://127.0.0.1:${CONFIG.RELAY_PORT}`);
    // The LOGIN server is NOT blocked from datacenter IPs (verified live) -
    // only www.goethe.de is. Sending login traffic DIRECT skips the proxy
    // hop on 2 of the login's 5 round trips (login page + password POST):
    // the RDP sits ~20ms from login.goethe.de while the proxy detours via
    // Munich. Everything else stays on the residential proxy.
    braveArgs.push('--proxy-bypass-list=login.goethe.de');
    log(`Using proxy ${PROXY.host}:${PROXY.port} (relay :${CONFIG.RELAY_PORT}; login.goethe.de DIRECT).`);
  }

  log('Launching Brave with debug port...');
  const child = spawn(CONFIG.BRAVE_PATH, braveArgs, { detached: true, stdio: 'ignore' });
  child.unref();
  bravePID = child.pid;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await check()) { log('Brave is up.'); return; }
  }
  throw new Error('Could not start Brave with debug port.');
}

// Connect to Brave; if the port answers but the connection is broken (which
// happens after a renderer crash), kill Brave and start it fresh.
async function connectBrave() {
  for (let attempt = 0; attempt < 3; attempt++) {
    await ensureBrave();
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${CONFIG.CDP_PORT}`, { timeout: 15000 });
    } catch (e) {
      log('Brave connection broken - restarting it (' + (attempt + 1) + '/3)...');
      try { spawn('taskkill', ['/IM', 'brave.exe', '/F'], { stdio: 'ignore' }); } catch (e2) {}
      await sleep(4000);
    }
  }
  throw new Error('Could not connect to Brave.');
}

// ------------------------------------------------------------- in-page helpers
// Everything runs inside the real exam page, so requests carry the browser's
// real cookies and fingerprint - same as a normal user, just without rendering.

// Grab the examfinder API URL(s) the page itself uses. Big pages host several
// finders (one per institute) - we need them all, or rows go missing.
async function getFinderUrls(page) {
  return await page.evaluate(() => {
    const urls = [...new Set(performance.getEntriesByType('resource')
      .map(r => r.name).filter(u => u.includes('/rest/examfinder')))];
    // prefer the URLs that carry the page's own country code, if any
    return urls;
  });
}

// Fire every finder API from inside the page; returns merged DATA rows.
// The &_= cache-buster is CRITICAL: without it the answer can come from a
// cache and lag many seconds behind reality - which is how we lost Islamabad.
async function fetchRows(page, finderUrls) {
  const t0 = Date.now();
  const r = await page.evaluate(async (urls) => {
    const t0 = performance.now();
    // all finders in PARALLEL - sequential polling cost us ~3x latency
    const results = await Promise.all(urls.map(async (u) => {
      const ts = performance.now();
      try {
        const bust = u + (u.includes('?') ? '&' : '?') + '_=' + Date.now();
        // the finder API rejects plain fetches with a "service interruption"
        // page - it wants the XHR signature the exam page itself sends
        const r = await fetch(bust, { credentials: 'include', cache: 'no-store',
          headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01' } });
        if (!r.ok) return { err: 'HTTP ' + r.status, rows: [], ms: Math.round(performance.now() - ts) };
        const ct = r.headers.get('content-type') || '';
        if (!/json/.test(ct)) return { err: 'blocked (non-json reply)', rows: [], ms: Math.round(performance.now() - ts) };
        const j = await r.json();
        return { err: null, rows: (j && j.DATA) ? j.DATA : [], ms: Math.round(performance.now() - ts) };
      } catch (e) { return { err: String(e).substring(0, 80), rows: [], ms: Math.round(performance.now() - ts) }; }
    }));
    const rows = results.flatMap((r, i) => r.rows.map(x => Object.assign(x, { __src: i })));
    const err = results.find(r => r.err);
    return { rows, err: err ? err.err : null, perUrl: results.map(r => r.ms) };
  }, finderUrls);
  ev('poll', { ms: Date.now() - t0, urls: finderUrls.length, rows: (r.rows || []).length,
    perUrl: r.perUrl, err: r.err || undefined });
  return r;
}

function parseRows(rows) {
  return rows.map(ex => {
    const oid = ex.oid ? String(ex.oid).trim() : '';
    // v2 rows carry buttonLink (prod-form; the site's script swaps in the oid).
    // v3 rows open with the oid but an EMPTY buttonLink - so build the exact
    // entry URL the site itself opens (coe?lang=en&oid=...) in that case.
    let link = ex.buttonLink || '';
    if (!link && oid) link = 'https://www.goethe.de/coe?lang=en&oid=' + encodeURIComponent(oid);
    return {
      location: String(ex.locationName || '').trim(),
      span: String(ex.eventTimeSpan || '').replace(/\s+/g, ' ').trim(),
      bookFrom: ex.bookFrom, bookFromTime: ex.bookFromTime,
      bookFromStamp: ex.bookFromStamp,           // v3: UTC stamp of the opening instant
      availability: ex.availability,             // 1 open · 2 fully booked · 11 bookable-from<future>
      encOID: ex.encOID || '',                   // v3: 128-hex token, present even while locked
      disabled: !!(ex.buttonDisabled && String(ex.buttonDisabled).trim()) || (!oid && ex.availability !== 1),
      link, oid,
      moduleId: ex.moduleId, acadYear: ex.acadYear, acadPeriod: ex.acadPeriod,
      src: ex.__src,
    };
  });
}

function parseOpenAt(row) {
  if (!row) return null;
  // v3 rows carry the opening moment as a UTC stamp - trust it over the
  // text fields. The 04.09 race saw bookFromTime silently flip from
  // 11:12 (PKT) to 07:12 (CMS timezone) mid-race, so the text path is only a fallback.
  const stamp = row.bookFromStamp;
  if (stamp) {
    const t = /^\d{12,13}$/.test(String(stamp)) ? Number(stamp) : Date.parse(stamp);
    if (!isNaN(t)) return new Date(t);
  }
  if (!row.bookFrom) return null;
  const d = String(row.bookFrom).match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!d) return null;
  const t = String(row.bookFromTime || '00:00').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const h = t ? +t[1] : 0, m = t ? +t[2] : 0, s = t && t[3] ? +t[3] : 0;
  // The advertised time is Pakistan local (UTC+5). Build the true instant in
  // UTC so it is correct no matter what timezone this machine runs on.
  return new Date(Date.UTC(+d[3], +d[2] - 1, +d[1], h - CONFIG.TZ_OFFSET_HOURS, m, s));
}

// One step of the booking chain: fetch a URL inside the page, return
// { finalUrl, html, ms }. Redirects are followed by the browser itself.
async function fetchPage(page, url) {
  const t0 = Date.now();
  const r = await page.evaluate(async (u) => {
    const t0 = performance.now();
    try {
      const r = await fetch(u, { credentials: 'include', redirect: 'follow', cache: 'no-store' });
      const html = await r.text();
      return { status: r.status, finalUrl: r.url, html, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return { status: 0, finalUrl: u, html: '', err: String(e).substring(0, 100), ms: Math.round(performance.now() - t0) };
    }
  }, url);
  ev('fetch', { url: String(url).substring(0, 100), ms: Date.now() - t0, net: r.ms, status: r.status, err: r.err || undefined });
  return r;
}

// Pull a Wicket button URL out of a page's HTML (first match).
function extractLink(html, key) {
  return extractLinks(html, key)[0] || null;
}

// Pull ALL matching Wicket button URLs (a page can embed several - hidden
// modals carry copies of the CONTINUE link that lead nowhere).
function extractLinks(html, key) {
  const re = new RegExp('"\\.\\/((?:coe\\/)?[a-zA-Z0-9;\\/=.-]+\\?[0-9][^"]*' + key + '[^"]*)"', 'g');
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push('https://www.goethe.de/coe/' + m[1]);
  return out;
}

// POST a form to a Wicket URL from inside the page (same-origin, cookies
// included). Used for pages that submit data (e.g. the account-details page).
async function fetchPost(page, url, fields) {
  const body = fields.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const r = await page.evaluate(async ({ u, b }) => {
    const t0 = performance.now();
    try {
      const r = await fetch(u, {
        method: 'POST', credentials: 'include', redirect: 'follow',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: b,
      });
      const html = await r.text();
      return { status: r.status, finalUrl: r.url, html, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return { status: 0, finalUrl: u, html: '', err: String(e).substring(0, 100), ms: Math.round(performance.now() - t0) };
    }
  }, { u: url, b: body });
  ev('post', { url: String(url).substring(0, 100), fields: fields.length, ms: r.ms, status: r.status, err: r.err || undefined });
  return r;
}

// Collect every form field (inputs + selects) from a page's HTML, so a form
// can be re-submitted exactly as the browser would.
function extractForm(html) {
  const fields = [];
  let m;
  const re = /<input[^>]*name="([^"]+)"[^>]*>/g;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const type = (tag.match(/type="([^"]+)"/) || [])[1] || 'text';
    const value = (tag.match(/value="([^"]*)"/) || [])[1] || '';
    const checked = /checked/.test(tag);
    if (type === 'checkbox') { if (checked) fields.push([m[1], value || 'on']); }
    else if (type === 'radio') { if (checked) fields.push([m[1], value]); }
    else if (!['button', 'submit', 'reset', 'image'].includes(type)) fields.push([m[1], value]);
  }
  const sre = /<select[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g;
  while ((m = sre.exec(html))) {
    const sel = m[2].match(/<option[^>]*selected[^>]*>/);
    let val = '';
    if (sel) val = (sel[0].match(/value="([^"]*)"/) || [])[1] || '';
    fields.push([m[1], val]);
  }
  return fields;
}

// ------------------------------------------------------------- automatic login
// The booking always forces a login (CAS), even if the browser is signed in.
//
// fastLogin: the login tab must already be SITTING on the CAS login page
// (put it there with tab.goto(wallUrl) - navigations can cross sites,
// background fetches cannot). Then we submit the login form from the page's
// own DOM with a no-cors POST: the browser follows the redirect chain back
// to goethe.de, registering the ticket and the booking session. ~1s.
async function fastLogin(tab) {
  return await tab.evaluate(async ({ email, password }) => {
    const t0 = performance.now();
    try {
      const form = document.querySelector('form');
      const user = document.querySelector('input[name="username"]');
      if (!form || !user) return { ok: true, note: 'no login form on this page', ms: Math.round(performance.now() - t0) };
      const fields = [];
      form.querySelectorAll('input[type="hidden"]').forEach(h => {
        if (h.name) fields.push(encodeURIComponent(h.name) + '=' + encodeURIComponent(h.value || ''));
      });
      fields.push('username=' + encodeURIComponent(email));
      fields.push('password=' + encodeURIComponent(password));
      const action = form.action || location.href;
      const p = await fetch(action, {
        method: 'POST',
        mode: 'no-cors',             // lets the browser follow the redirect to goethe.de
        credentials: 'include',
        redirect: 'follow',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: fields.join('&'),
      });
      // opaque = the redirect chain was followed; the login itself happened.
      return { ok: p.type === 'opaque' || p.type === 'opaqueredirect' || p.ok, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return { ok: false, err: String(e).substring(0, 80), ms: Math.round(performance.now() - t0) };
    }
  }, { email: CREDS.email, password: CREDS.password });
}

// Navigate-login: submit the CAS form as a REAL navigation. The login tab
// itself follows the whole redirect chain (credential POST -> service ticket
// -> /coe/cas -> cas-gid -> back into the booking chain) and ends up sitting
// ON the page after the wall - the chain then takes that page straight from
// the tab. That kills the ~3s "re-fetch a page we already rendered" step a
// background (fetch) login needs. If it does not land cleanly within ~10s,
// the caller falls back to the proven fastLogin below - worst case equals
// the old behaviour.
async function navLogin(tab) {
  const t0 = Date.now();
  try {
    const how = await tab.evaluate(({ email, password }) => {
      const f = document.querySelector('form');
      const u = document.querySelector('input[name="username"]');
      const p = document.querySelector('input[name="password"]');
      if (!f || !u || !p) return 'noform';
      u.value = email; p.value = password;
      const btn = f.querySelector('input[type="submit"], button[type="submit"]');
      if (btn) { btn.click(); return 'click'; }
      f.submit(); return 'submit';
    }, { email: CREDS.email, password: CREDS.password });
    if (how === 'noform') return { ok: false, err: 'no form' };
  } catch (e) {
    return { ok: false, err: String(e.message || e).substring(0, 60) };
  }
  // The tab now travels: POST -> ticket -> back into /coe/. The POST chain
  // is server-slow (4.5-9s idle, worse at peak load - measured a full run
  // where every step took 2-3x longer), so a fixed timeout gives up on
  // logins that are still making progress. Instead: fail only after the
  // URL has not moved for ~12s, hard cap ~30s.
  let last = '', stall = 0;
  for (let i = 0; i < 200; i++) {
    await sleep(150);
    let u = '';
    try { u = tab.url(); } catch (e) { u = last; }
    if (u !== last) { stall = 0; last = u; } else stall += 150;
    if (/session-expired|\/coe\/(error|wicket\/page)/i.test(u)) {
      return { ok: false, err: 'landed on ' + u.replace(/\?.*/, ''), ms: Date.now() - t0 };
    }
    // the ticket redirects (/coe/cas?...&ticket=..., /coe/cas-gid?...) are
    // pass-throughs, not landings - keep travelling
    if (/\/coe\/(cas|cas-gid)\?/.test(u)) continue;
    if (/\/coe\//.test(u) && !/login\.goethe\.de/.test(u)) {
      // The HTML text is ALL we need - do NOT wait for domcontentloaded:
      // that signal waits for parser-blocking JS/CSS/fonts to download
      // (measured ~800ms-1.1s of pure waste on the landing page). Poll the
      // DOM directly until a booking-page marker is parsed.
      let c = '';
      const MARK = /navSection-nextLink|infoSection-forwardLink|moduleDetailsPanel/;
      for (let i = 0; i < 60 && !MARK.test(c); i++) {
        c = await tab.content().catch(() => '');
        if (!MARK.test(c)) await sleep(100);
      }
      let u2 = u; try { u2 = tab.url(); } catch (e) {}
      if (/\/coe\/(cas|cas-gid)\?/.test(u2)) { stall = 0; continue; } // still moving
      if (c && c.length > 500 && MARK.test(c)) {
        return { ok: true, ms: Date.now() - t0, url: u2 };
      }
      return { ok: false, err: 'landed without a booking page: ' + u2.replace(/\?.*/, ''), ms: Date.now() - t0 };
    }
    if (stall >= 12000) {
      return { ok: false, err: 'stalled ' + (stall / 1000) + 's at ' + String(last).replace(/\?.*/, '').substring(0, 60), ms: Date.now() - t0 };
    }
  }
  return { ok: false, err: 'timeout', ms: Date.now() - t0 };
}

// Fallback: type the login into the visible page (slower, but sure).
async function autoLogin(page, url) {
  if (!CREDS.email || !CREDS.password) {
    log('!! No creds.json - LOG IN BY HAND IN THE BRAVE WINDOW NOW.');
    beep(3);
    await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
    for (let i = 0; i < 200 && /login\.goethe\.de/.test(page.url()); i++) await sleep(600);
    return { html: await page.content(), url: page.url() };
  }
  log('Login wall - logging in automatically...');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // Sometimes CAS lets a signed-in browser straight through (redirect back
  // to goethe.de without a form). Detect that and skip the typing.
  for (let t = 0; t < 20 && /login\.goethe\.de/.test(page.url()); t++) {
    try {
      await page.fill('input[name="username"]', CREDS.email, { timeout: 800 });
      await page.fill('input[name="password"]', CREDS.password, { timeout: 800 });
      log(`Submitting login (${CREDS.email})...`);
      const hit = await clickFirst(page, ['input[name="submit"]', 'input[type="submit"]', 'button:has-text("Log in")'], 1500);
      if (hit) break;
    } catch (e) { await sleep(400); }
  }

  // Wait for CAS to bounce us back to goethe.de (max 60s).
  for (let i = 0; i < 120 && /login\.goethe\.de/.test(page.url()); i++) await sleep(500);
  if (/login\.goethe\.de/.test(page.url())) {
    const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').substring(0, 150));
    log('!! Login did not go through: ' + body);
    return null;
  }
  log('Logged in. Back at: ' + page.url());
  await sleep(1000); // let the booking session settle
  return { html: await page.content(), url: page.url() };
}

async function clickFirst(page, selectors, timeout = 1200) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout })) { await el.click(); return sel; }
    } catch (e) { /* try next */ }
  }
  return null;
}

// ------------------------------------------------------------------ main race
async function main() {
  console.log('\nGOETHE RACER (fast version)');
  console.log(`Target : "${CONFIG.CITY}" ${CONFIG.TARGET_DATE ? '| date: ' + CONFIG.TARGET_DATE : '(any date)'}`);
  console.log(`Login  : ${CREDS.email ? CREDS.email + ' (auto)' : 'NOT SET'}`);
  console.log(`Mode   : ${CONFIG.DRY_RUN ? 'DRY RUN (stops before ORDER)' : 'LIVE - will complete the booking'}${CONFIG.CALM ? ' [calm: gentle rates, no lockout risk]' : ' [FAST: aggressive rates]'}`);
  console.log(`Proxy  : ${PROXY && PROXY.host ? PROXY.host + ' (Germany exit)' : 'direct'}`);
  console.log('Press Ctrl+C to stop.\n');

  let browser = await connectBrave();
  let ctx = browser.contexts()[0];
  let page = await ctx.newPage();

  log('Opening exam page (once - it stays open, no more reloading)...');
  await page.goto(CONFIG.EXAM_URL, { waitUntil: 'load', timeout: 60000 });
  try { await page.getByText('Accept All', { exact: true }).first().click({ timeout: 3000 }); log('Cookie banner dismissed.'); } catch (e) { log('No cookie banner.'); }

  // Drop any stale booking session so the first attempt is clean.
  try {
    const doomed = (await ctx.cookies()).filter(c => /goethe/i.test(c.domain) && /session/i.test(c.name));
    for (const c of doomed) await ctx.clearCookies({ name: c.name, domain: c.domain, path: c.path });
  } catch (e) {}

  // The finder XHRs are lazy: they fire seconds after page load, and on a
  // slow/blocked first load they may not fire at all (Akamai sometimes serves
  // a forbidden interstitial to a cold session). Poll for them, and if the
  // page looks blocked, reload it. This MUST succeed - the fallback URL is
  // only correct for Pakistan.
  let finderUrls = [];
  for (let attempt = 0; attempt < 3 && !finderUrls.length; attempt++) {
    if (attempt > 0) {
      const blocked = await page.evaluate(() => /forbidden|Service-Unterbrechung|Request was blocked/i.test(document.body ? document.body.innerText : '')).catch(() => false);
      log(blocked ? 'Exam page came back blocked - reloading after a pause...' : 'Finder API not seen yet - reloading the exam page...');
      if (blocked) await sleep(6000);
      await page.goto(CONFIG.EXAM_URL, { waitUntil: 'load', timeout: 60000 });
      try { await page.getByText('Accept All', { exact: true }).first().click({ timeout: 3000 }); } catch (e) {}
    }
    for (let wait = 0; wait < 12 && !finderUrls.length; wait++) {
      finderUrls = await getFinderUrls(page);
      if (!finderUrls.length) await sleep(1500);
    }
  }
  if (!finderUrls.length) {
    // Fallback: build the finder URL from the exam page's own country code
    // (works because the institute id for the exam pages is derivable from
    // the page's country). Known institutes; extend if targeting elsewhere.
    const ccMatch = CONFIG.EXAM_URL.match(/\/ins\/([a-z]{2})\//i);
    const cc = ccMatch ? ccMatch[1].toLowerCase() : 'pk';
    const KNOWN_INSTITUTES = { pk: 'O%2010000366', ae: 'O%2010000260', bd: 'O%2010000362', om: 'O%2013000478' };
    const inst = KNOWN_INSTITUTES[cc] || 'O%2010000366';
    log(`Exam API not seen on the page - using the known ${cc.toUpperCase()} B1 finder URL (no rows = STOP and check by hand).`);
    finderUrls = [`https://www.goethe.de/rest/examfinder/exams/institute/${inst}?category=E006&type=ER&countryIsoCode=${cc}&locationName=&count=10&start=1&langId=1&timezone=47&isODP=0&sortField=startDate&sortOrder=ASC&dataMode=0&langIsoCodes=en`];
  } else {
    log("Exam APIs found: " + finderUrls.length + " finders");
  }
  // The institute id (e.g. "O 10000366") sits in the finder URL itself -
  // needed to build pre-open booking URLs from the locked row's data.
  let instituteId = '';
  try {
    const m = decodeURIComponent(finderUrls[0]).match(/institute\/([^?/]+)/);
    if (m) instituteId = m[1];
  } catch (e) {}

  // The full exam page is heavy and its scripts eventually crash the tab.
  // We only need A page on goethe.de to send requests from - so park the tab
  // on a tiny static page. Cookies and requests still work exactly the same.
  const PARK_URL = 'https://www.goethe.de/robots.txt';
  await page.goto(PARK_URL, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
  log('Tab parked on a light page (' + PARK_URL + ') - polling from there.');

  // Pre-warm a second tab on the login server: when the forced login hits
  // mid-booking, its TLS/DNS connection is already established (~0.5s saved).
  try {
    const warm = await ctx.newPage();
    await warm.goto('https://login.goethe.de/', { waitUntil: 'commit', timeout: 20000 }).catch(() => {});
    log('Login tab pre-warmed (login.goethe.de connection open).');
  } catch (e) {}

  // Pre-clear the Akamai bot challenge: it fires randomly on the FIRST /coe
  // request of a fresh browser session (~1 in 7 in our tests) - and if that
  // first request is the race entry, we lose ~5s clearing it. Loading a /coe
  // page NOW (harmless, no booking session) makes any challenge fire and
  // clear long before the flip.
  try {
    const warm = await ctx.newPage();
    await warm.goto('https://www.goethe.de/coe/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(2500);
    try { await warm.close(); } catch (e2) {}
    log('Bot-challenge pre-cleared (first /coe request done before the race).');
  } catch (e) {}

  let openAt = null;    // advertised opening moment of the target row
  let cycle = 0;
  let cityFinderUrl = null;  // the finder URL that carries our city (learned
                             // during full polls only - in turbo we poll ONLY
                             // it: one small request per cycle)
  let prevTurbo = false, prevUltra = false;
  const rowSigs = {};   // last-seen signature per row (change detection)
  let seenOid = false;  // first oid appearance (logged loudly)
  let pollErrs = 0;     // consecutive poll failures (backoff state)

  // (Re)open the racer tab. Used whenever the tab crashes.
  const openTab = async () => {
    await page.goto(PARK_URL, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
  };

  while (true) {
    cycle++;
    let res;
    // Which phase are we in? turbo arms TURBO_LEAD_SEC before the advertised
    // opening; ultra (last 60s) polls at maximum rate.
    const turbo = openAt && (openAt - Date.now() <= CONFIG.TURBO_LEAD_SEC * 1000) &&
                  (openAt - Date.now() >= -CONFIG.TURBO_MINUTES * 60000);
    // ULTRA (max rate) for the last 60s: rate-limit tested - 16 req/s for a
    // full minute produced zero blocks, so 8 req/s is deep in the safe zone.
    const ultra = turbo && openAt && (openAt - Date.now() <= 60 * 1000);
    if (turbo && !prevTurbo) { log(`TURBO engaged - ${Math.round((openAt - Date.now()) / 1000)}s to opening`); ev('phase', { phase: 'turbo' }); }
    if (ultra && !prevUltra) { log(`ULTRA engaged (max polling rate) - ${Math.round((openAt - Date.now()) / 1000)}s to opening`); ev('phase', { phase: 'ultra' }); }
    prevTurbo = turbo; prevUltra = ultra;
    // In turbo, poll only the finder that carries our city (one small
    // request) - the other finders are pure latency.
    const pollUrls = (turbo && cityFinderUrl && finderUrls.length > 1) ? [cityFinderUrl] : finderUrls;
    try {
      res = await fetchRows(page, pollUrls);
    } catch (e) {
      // tab crashed or was closed - get a fresh one and keep racing
      log(`Tab problem (${String(e.message || e).substring(0, 50)}) - recovering...`);
      await sleep(2000);
      try {
        try { await page.close(); } catch (e2) {}
        page = await ctx.newPage();
        await page.goto(PARK_URL, { waitUntil: 'load', timeout: 30000 });
        log('New tab ready - continuing.');
      } catch (e2) {
        // the whole browser must be gone - relaunch it
        log('Browser gone - relaunching Brave...');
        try { spawn('taskkill', ['/IM', 'brave.exe', '/F'], { stdio: 'ignore' }); } catch (e3) {}
        await sleep(4000);
        browser = await connectBrave();
        ctx = browser.contexts()[0];
        page = await ctx.newPage();
        await page.goto(PARK_URL, { waitUntil: 'load', timeout: 30000 });
        log('Brave restarted - continuing.');
      }
      continue;
    }
    if (res.err) {
      // BACKOFF, never hammer while blocked: a detected rate-limit is what
      // turned the old bot's 5-minute block into an hour. Each consecutive
      // error doubles the pause (3s -> 6s -> 12s, max 30s) and drops us to
      // the slow polling rate until the server is friendly again.
      pollErrs++;
      const back = Math.min(30000, 3000 * Math.pow(2, pollErrs - 1));
      if (pollErrs === 1 || pollErrs % 5 === 0)
        log(`#${cycle}: API problem (${res.err}) - backing off ${Math.round(back / 1000)}s (streak ${pollErrs})`);
      ev('poll_error', { err: res.err, streak: pollErrs, backoffMs: back });
      await sleep(back);
      continue;
    }
    if (pollErrs) { log(`API recovered after ${pollErrs} error(s) - resuming normal pace.`); ev('poll_recovered', { streak: pollErrs }); }
    pollErrs = 0;

    const rows = parseRows(res.rows);
    const mine = rows.filter(r => r.location.toLowerCase().includes(CONFIG.CITY.toLowerCase()));
    // Learn which finder URL carries our city - ONLY from full polls. (A
    // single-URL turbo poll reindexes everything to 0, which would corrupt
    // the learned index and make us poll the WRONG finder after turbo arms.)
    if (mine.length && finderUrls.length > 1) {
      const idx = res.rows.find(r => String(r.locationName || '').toLowerCase().includes(CONFIG.CITY.toLowerCase()) && r.__src !== undefined);
      if (idx) cityFinderUrl = finderUrls[idx.__src];
    }

    // ---- RAW ROW FORENSICS: log every state change of our city's rows with
    // the complete raw data - the oid appearing, the availability draining,
    // availabilityText, lastUpdated, the real buttonLink. This is the only
    // chance to observe exactly what the API does at a genuine opening.
    for (const raw of res.rows) {
      const loc = String(raw.locationName || '');
      if (!loc.toLowerCase().includes(CONFIG.CITY.toLowerCase())) continue;
      const sig = [loc, raw.eventTimeSpan, raw.oid, raw.buttonDisabled, raw.availability,
                   raw.availabilityText, raw.lastUpdated, raw.buttonLink].join('|');
      const key = loc + '|' + raw.eventTimeSpan;
      if (rowSigs[key] !== sig) {
        rowSigs[key] = sig;
        ev('row_change', {
          location: loc, span: String(raw.eventTimeSpan || '').replace(/\s+/g, ' ').trim(),
          oid: raw.oid || null,
          oidLength: raw.oid ? String(raw.oid).length : 0,
          buttonDisabled: raw.buttonDisabled,
          availability: raw.availability,
          availabilityText: String(raw.availabilityText || '').replace(/<br\s*\/?>/gi, ' ').trim(),
          lastUpdated: raw.lastUpdated,
          bookFrom: raw.bookFrom, bookFromTime: raw.bookFromTime,
          buttonLink: raw.buttonLink || '',
          moduleId: raw.moduleId, acadYear: raw.acadYear, acadPeriod: raw.acadPeriod,
          instituteId: raw.instituteId, locationId: raw.locationId,
          cycle, phase: ultra ? 'ultra' : turbo ? 'turbo' : 'normal',
        });
        if (raw.oid && !seenOid) {
          seenOid = true;
          log(`>>> OID APPEARED at cycle ${cycle}: ${String(raw.oid).substring(0, 24)}... (avail ${raw.availability})`);
        }
      }
    }

    // remember / update the advertised opening moment. ONLY future openings
    // count: pages also list expired rows (exam date passed, bookFrom long
    // ago, locked forever) whose past timestamps would pin openAt in the
    // past and disarm turbo for the row that actually opens.
    for (const r of mine) {
      const oa = parseOpenAt(r);
      if (oa && oa > Date.now() - 60000 && (!openAt || oa < openAt)) {
        openAt = oa;
        log(`${r.location} [${r.span}] opens ${oa.toLocaleString('en-GB')} - turbo will arm ${CONFIG.TURBO_LEAD_SEC}s before`);
      }
    }

    if (cycle % 30 === 1 || turbo) {
      const status = mine.map(r => `[${r.span}] ${r.disabled ? 'x' : 'OPEN'}`).join(' ') || 'not listed';
      const left = openAt ? ` | opens in ${Math.max(0, Math.round((openAt - Date.now()) / 1000))}s` : '';
      log(`#${cycle}${turbo ? ' [TURBO]' : ''}: ${status}${left}`);
    }

    const target = mine.find(r => !r.disabled && r.link &&
      (!CONFIG.TARGET_DATE || (r.span + ' ' + r.bookFrom).includes(CONFIG.TARGET_DATE)));

    // ---- PRE-OPEN HAMMER (experimental): in the final seconds before the
    // advertised opening, fire booking-entry requests built from the locked
    // row's own product code. The site normally wants a one-time oid that
    // only appears once open - but if the entry ever accepts the product
    // route at the flip moment, we are the first request in. Harmless if it
    // just 403s; enable with --prehammer.
    if (!target && CONFIG.PREHAMMER && turbo && openAt && mine.length &&
        (openAt - Date.now()) <= CONFIG.PREHAMMER_LEAD_SEC * 1000) {
      const row = mine.find(r => !CONFIG.TARGET_DATE || (r.span + ' ' + r.bookFrom).includes(CONFIG.TARGET_DATE)) || mine[0];
      if (row.moduleId && row.acadYear && row.acadPeriod && instituteId) {
        const prod = instituteId + row.moduleId + '      00000000' + row.acadYear + row.acadPeriod + '          000';
        const fake = { link: 'https://www.goethe.de/coe?lang=en&prod=' + encodeURIComponent(prod), oid: null };
        const left = Math.max(0, Math.round((openAt - Date.now()) / 1000));
        if (cycle % 10 === 1) log(`pre-hammer active (${left}s to opening)`);
        try {
          const r = await fetchPage(page, fake.link);
          if (!r.err && r.status !== 403 && !/cannot be booked/i.test(r.html || '') &&
              /navSection-nextLink|moduleDetailsPanel/.test(r.html || '')) {
            log('*** PRE-HAMMER GOT IN! Booking straight away. ***');
            beep(3);
            const booked = await attemptBooking(page, fake, ctx);
            if (booked === 'won') { await alarm('BOOKING COMPLETED - CHECK YOUR EMAIL'); return; }
            if (booked === 'claimed') { await alarm('SEAT CLAIMED - FINISHING IN BRAVE'); return; }
          }
        } catch (e) { /* keep hammering */ }
      }
    }

    if (target) {
      // how close to the advertised opening did the oid actually appear?
      if (openAt) {
        const delta = Math.round((Date.now() - openAt) / 100) / 10;
        log(`FLIP DETECTED ${delta}s after the advertised opening time`);
        ev('flip', { deltaSec: delta, location: target.location, span: target.span, cycle });
      }
      log(`*** SEAT OPEN: ${target.location} ${target.span} ***`);
      beep(2);
      let booked;
      try {
        booked = await attemptBooking(page, target, ctx);
      } catch (e) {
        log('Booking attempt error: ' + String(e.message || e).substring(0, 100));
        try { await openTab(); } catch (e2) {}
        booked = 'lost';
      }
      if (booked === 'won') { ev('result', { outcome: 'won' }); await alarm('BOOKING COMPLETED - CHECK YOUR EMAIL'); return; }
      if (booked === 'claimed') { ev('result', { outcome: 'claimed' }); await alarm('SEAT CLAIMED - FINISHING IN BRAVE, TAKE OVER IF IT ASKS'); return; }
      if (CONFIG.DRY_RUN) { log('Dry run finished (seat not secured) - stopping so we do not create more bookings.'); return; }
      log('Seat not secured yet - resuming the watch.');
    }

    // in calm mode every cadence is gentle: detection ~1s worst case, but
    // no rate-limit lockout (a blocked IP detects nothing at all)
    const pollSec = CONFIG.CALM ? 1.0 : (ultra ? CONFIG.ULTRA_POLL_SEC : turbo ? CONFIG.TURBO_POLL_SEC : CONFIG.POLL_SEC);
    await sleep(pollSec * 1000);
  }
}

// In a DRY RUN we stop at the review page. But the half-made booking still
// exists on the account (it blocks future tests until it times out), so we
// cancel it in the live page: the ✕ (button.cs-checkout__close) opens the
// "are you sure" layer, whose CANCEL BOOKING button discards the booking.
// After cancelling, the checkout session is gone (summary -> session-expired).
async function cancelReviewBooking(ctx, currentUrl) {
  // Use a dedicated tab: navigating the parked polling tab to the heavy
  // review page can crash it, and we need the polling tab untouched.
  const tab = await ctx.newPage();
  try {
    try {
      await tab.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (e) { log('cancel: could not open the review page: ' + String(e.message).substring(0, 60)); return false; }
    await sleep(2000);

    const step = async (mode) => tab.evaluate((m) => {
      const vis = el => !!(el.offsetWidth || el.offsetHeight);
      const cancel = Array.from(document.querySelectorAll('button'))
        .find(el => vis(el) && /cancel booking/i.test((el.innerText || '').trim()));
      if (cancel && m !== 'close-only') { cancel.click(); return 'cancel'; }
      if (m === 'cancel-only') return null;
      const close = Array.from(document.querySelectorAll('button'))
        .find(el => vis(el) && /cs-checkout__close/.test(el.className.toString()));
      if (close) { close.click(); return 'close'; }
      return null;
    }, mode).catch(() => null);

    // 1) open the dialog once (the ✕) - its buttons take ~2s to render
    let opened = false;
    for (let i = 0; i < 6 && !opened; i++) {
      if (await step('close-only') === 'close') opened = true;
      else await sleep(1000);
    }
    if (!opened) { log('cancel: no close button found on the review page.'); return false; }
    // 2) wait for CANCEL BOOKING to appear, then click it
    for (let i = 0; i < 12; i++) {
      await sleep(i === 0 ? 2500 : 1200);
      if (await step('cancel-only') === 'cancel') {
        await sleep(3500);
        let url = ''; try { url = tab.url(); } catch (e) { return false; }
        if (!/\/coe\/summary/.test(url) || /session-expired/.test(url)) {
          log('cancel: booking discarded.');
          return true;
        }
      }
    }
    // verify via request: a dead session answers with session-expired
    const chk = await fetchPage(tab, currentUrl);
    if (!chk.err && /session-expired/.test(chk.finalUrl)) { log('cancel: booking discarded (verified by request).'); return true; }
    log('cancel: could NOT cancel - an unconfirmed booking may block the next test for a while.');
    return false;
  } finally {
    try { await tab.close(); } catch (e) {}
  }
}

// Detect the Akamai bot-challenge interstitial: a tiny page whose body is
// just a script from a scrambled path (e.g. /g1HNvumGvjJl24TwqxY0/...?v=).
// A background fetch CANNOT pass this challenge - it needs a real page to
// execute the script, which then sets a clearance cookie.
function isChallenge(html) {
  const h = String(html || '');
  return h.length < 2500 && /<body>\s*<script[^>]+src="\/[a-zA-Z0-9_\-\/]{15,}\?v=/.test(h);
}

// Clear the challenge by loading the URL in a REAL tab (the challenge JS
// runs, sets the clearance cookie browser-wide), then the background
// requests pass again.
async function clearChallenge(ctx, url) {
  log('bot-check challenge received - executing it in a real tab to clear...');
  try {
    const t = await ctx.newPage();
    await t.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000); // let the challenge script finish and reload
    try { await t.close(); } catch (e) {}
    return true;
  } catch (e) { return false; }
}

// On the payment-method page, find the INVOICE option's Wicket toggle URL
// (the request a real click sends). The boxes and their toggle URLs are
// numbered in the same order: variantBox-0 = first option, variantBox-1 =
// second, ... Returns null when there is no invoice option.
function pickInvoiceToggle(html) {
  const chunks = html.split('cs-payment__box');
  let invBox = -1;
  for (let i = 1; i < chunks.length; i++) {
    if (/invoice|rechnung|bank\s*transfer|ueberweisung/i.test(chunks[i])) { invBox = i - 1; break; }
  }
  if (invBox < 0) return null;
  const m = html.match(new RegExp('"\\.\\/((?:coe\\/)?psp-selection\\?[^"]*variantBox-' + invBox + '-toggle)"'));
  return m ? 'https://www.goethe.de/coe/' + m[1] : null;
}

// A Wicket AJAX GET - what the page's own JavaScript sends when a user
// clicks. The response is an xml partial; a <redirect> element names the
// next page. Plain fetches of these URLs just re-render the page.
async function fetchAjax(page, url, base) {
  return await page.evaluate(async ({ u, b }) => {
    const t0 = performance.now();
    try {
      const r = await fetch(u, { credentials: 'include', cache: 'no-store',
        headers: {
          'Wicket-Ajax': 'true',
          'Wicket-Ajax-BaseURL': b,
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01',
        } });
      const body = await r.text();
      return { status: r.status, body, ms: Math.round(performance.now() - t0) };
    } catch (e) { return { status: 0, body: '', err: String(e).substring(0, 80), ms: Math.round(performance.now() - t0) }; }
  }, { u: url, b: base });
}

// Fire the booking chain. 'won' = order placed. 'claimed' = seat held but a
// step needs a human. 'lost' = seat not secured.
async function attemptBooking(page, exam, ctx) {
  const T0 = Date.now();
  const el = () => `+${Date.now() - T0}ms`;

  // Build the booking URL: buttonLink + oid
  let url = exam.link;
  try {
    const u = new URL(exam.link);
    if (exam.oid) { u.searchParams.set('oid', exam.oid); u.searchParams.delete('prod'); }
    url = u.toString();
  } catch (e) {}

  // A second tab used only for logging in. Navigations can cross from
  // goethe.de to login.goethe.de (background fetches cannot), so we drive
  // this tab to the login wall, then submit the form from its own page.
  //
  // SPEED: the login is the single slowest step (~5s), so we start it the
  // MOMENT the race starts - in parallel with the gate hammering and the
  // first chain steps - instead of waiting for the wall to block us. By the
  // time the chain needs the session, the login is usually already done.
  let loginTab = null;
  let loginPromise = null; // in-flight parallel login (do not await early)
  const getLoginTab = async () => {
    if (!loginTab) {
      // prefer the pre-warmed tab already sitting on the login server
      for (const t of ctx.pages()) {
        if (/login\.goethe\.de/.test(t.url())) { loginTab = t; return loginTab; }
      }
      loginTab = await ctx.newPage();
    }
    return loginTab;
  };
  // wallUrl: the goethe.de URL that bounced to the login site.
  // Returns 'ok' (logged in, verify by re-fetching), 'through' (walked the
  // chain and no login was demanded), or false (failed - caller uses the
  // slow fallback). The forced login (renew) usually hits at the step after
  // BOOK FOR MYSELF, so if the first URL lets us through we keep walking
  // (in the second tab, in parallel) until the login form appears.
  const doLogin = async (wallUrl) => {
    const tab = await getLoginTab();
    let at = wallUrl;
    for (let hop = 0; hop < 3; hop++) {
      await tab.goto(at, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      const u = tab.url();
      if (/login\.goethe\.de/.test(u)) {
        // wait for the login form to be parsed before submitting
        for (let i = 0; i < 20 && !(await tab.evaluate(() => !!document.querySelector('form input[name="username"]')).catch(() => false)); i++) await sleep(150);
        // FAST PATH: submit as a real navigation - the tab lands directly on
        // the page AFTER the wall and the chain takes it from the tab (no
        // ~3s re-fetch). Falls back to the proven background login instantly
        // if it does not land cleanly.
        const nv = await navLogin(tab);
        if (nv.ok) {
          log(`[${el()}] login: navigation login -> landed on ${nv.url.replace(/\?.*/, '').substring(0, 50)} (${nv.ms}ms)`);
          ev('login', { how: 'navigation', ms: nv.ms, url: nv.url });
          return 'nav';
        }
        log(`[${el()}] login: navigation login failed (${nv.err}${nv.ms ? ', ' + nv.ms + 'ms' : ''}) - fetch login instead`);
        ev('login_nav_fail', { err: nv.err, ms: nv.ms || 0 });
        // reset the tab onto a clean wall page, then the PROVEN path
        await tab.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        for (let i = 0; i < 20 && !(await tab.evaluate(() => !!document.querySelector('form input[name="username"]')).catch(() => false)); i++) await sleep(150);
        let r = null;
        try { r = await fastLogin(tab); } catch (e) { r = { ok: false, err: 'nav race: ' + String(e.message).substring(0, 50) }; }
        if (r && r.ok) {
          log(`[${el()}] login POST ok (${r.ms}ms${r.note ? ', ' + r.note : ''})`);
          return 'ok';
        }
        log(`[${el()}] fast login failed (${r && r.err ? r.err : '?'}) - falling back to typing it in the browser...`);
        return false;
      }
      // SSO let this hop through - advance towards the forced-login wall
      const html = await tab.content().catch(() => '');
      const next = extractLink(html, 'bookContractor') || extractLink(html, 'navSection-nextLink');
      if (!next) {
        log(`[${el()}] login: SSO let us straight through (${u.substring(0, 60)})`);
        return 'through';
      }
      at = next;
    }
    log(`[${el()}] login: walked 3 hops without a login wall`);
    return 'through';
  };
  // NOTE: a "dual login" (two parallel login tabs, keep the faster one) was
  // built and tested live on 01.09 - the backend answers it with
  // /coe/account-pairing-error and kills the whole booking session. DO NOT
  // retry this. One account = one login chain, ever.
  // Kick the login off in the background, in parallel with the gate/chain.
  const startParallelLogin = (wallUrl) => {
    if (loginPromise) return;
    loginPromise = (async () => {
      const t = Date.now();
      const runner = doLogin(wallUrl);
      const r = await runner.catch(e => {
        log(`[${el()}] background login CRASHED: ${String(e.message || e).substring(0, 100)}`);
        return false;
      });
      log(`[${el()}] background login finished (${r || 'failed'}, ${Date.now() - t}ms)`);
      ev('login', { result: r || 'failed', ms: Date.now() - t });
      return r;
    })();
  };

  log(`[${el()}] RACE START: ${url.substring(0, 90)}`);
  ev('race_start', { url });

  // ---- GATE: the entry request. This is the race. Every retry is a fresh
  // lottery ticket as other people's sessions time out. The 04.09 lesson
  // decides the pacing: our IP tripped Akamai's limit ~10s after the flip
  // (hammering at 0.7s) and stayed blind for 28 MINUTES while the seats
  // stayed open - so calm mode starts patient and ESCALATES the gap, and a
  // real 429 gets a long cooldown plus a loud "switch IP" call-out.
  const GATE_MS = 8 * 60 * 1000; // keep retrying up to 8 minutes
  const gateStart = Date.now();
  let html = '', finalUrl = '', status = 0, gateErr = false, gate429 = 0, gateTry = 0;
  // calm: 1.5s -> ~4s cap (each retry still a fresh ticket, but the IP stays
  // under Akamai's radar); fast: the old 0.7s hammer
  const gapFor = () => (CONFIG.CALM ? Math.min(1500 + gateTry * 250, 4000) : 700);

  while (Date.now() - gateStart < GATE_MS) {
    const r = await fetchPage(page, url);
    gateTry++;
    status = r.status; html = r.html || ''; finalUrl = r.finalUrl;
    if (r.err) { gateErr = true; break; }              // login-site redirect
    if (/\/coe\/(options|entry)/.test(finalUrl) && /navSection-nextLink|moduleDetailsPanel/.test(html)) break;
    // Akamai bot challenge: background fetches cannot execute it - clear it
    // in a real tab, then retry. This is transient and random, but it CAN
    // hit at the flip moment, so it must never end the attempt.
    if (isChallenge(html)) {
      await clearChallenge(ctx, url);
      await sleep(300);
      continue;
    }
    // The "high traffic" Wicket interstitial (documented by other bots):
    // the entry lands on /coe/wicket/page;coesessionid=... instead of the
    // options page at peak moments. It is transient - retry like a demand
    // block, never treat it as a dead session.
    if (/\/coe\/wicket\/page/.test(finalUrl) || /high traffic|very high demand|sehr hohe nachfrage|hohe auslastung/i.test(html)) {
      const n = Math.floor((Date.now() - gateStart) / 1000);
      if (n < 30 || n % 10 === 0) log(`[${el()}] gate: high-traffic interstitial (try #${gateTry}) - retrying in ${Math.round(gapFor() / 100) / 10}s...`);
      await sleep(gapFor());
      continue;
    }
    if (/cannot be booked at the moment/i.test(html)) {
      // Normal contention response at a real opening - retry patiently:
      // each retry is a fresh chance as other sessions die.
      const n = Math.floor((Date.now() - gateStart) / 1000);
      if (n < 30 || n % 10 === 0) log(`[${el()}] gate: demand-blocked (try #${gateTry}) - ${CONFIG.CALM ? 'retrying patiently' : 'hammering'}...`);
      await sleep(gapFor());
      continue;
    }
    if (status === 429 || /Too Many Requests/i.test(html)) {
      // A REAL rate limit: re-probing fast only extends the block - on 04.09
      // the IP was banned 27+ minutes while the seats were still open ~20.
      // Long cooldowns instead; at hit 2 call the exit IP burned so a second
      // racer on another IP (--proxy=proxy-2.json) can take over.
      gate429 = Math.min(gate429 + 1, 6);
      const pause = Math.min(gate429 * (CONFIG.CALM ? CONFIG.COOL_SEC : 2) * 1000, 90000);
      if (gate429 === 2) log(`[${el()}] !! gate: still rate-limited at ${Math.round((Date.now() - gateStart) / 1000)}s in - this exit IP looks BANNED. Start the second racer on another IP NOW (and give this one --cool=60).`);
      log(`[${el()}] gate: HTTP 429 - cooling down ${Math.round(pause / 1000)}s (hit ${gate429}x).`);
      ev('gate_429', { hits: gate429, pauseMs: pause, likely_banned: gate429 >= 2 });
      await sleep(pause);
      continue;
    }
    break; // some other response - inspect below
  }

  let current, currentUrl;
  let stuckCount = 0; // same-page repeats (account page refusing to advance)
  let invoiceTried = false; // payment page: invoice toggle sent once per attempt
  let wallSkipDone = false; // the "skip the wall fetch" shortcut fired once per attempt
  let pspStuck = 0; // how many times we have (re)seen the payment page without advancing
  if (gateErr) {
    log(`[${el()}] gate: login site - awaiting the parallel login...`);
    const ok = loginPromise ? await loginPromise : await doLogin(url);
    if (!ok) {
      const after = await autoLogin(page, url);
      if (!after) return 'lost';
      current = after.html; currentUrl = after.url;
    } else {
      // login done in background; re-enter the booking
      const r2 = await fetchPage(page, url);
      if (r2.err || !/navSection-nextLink|moduleDetailsPanel/.test(r2.html || '')) {
        log(`[${el()}] after fast login the booking did not resume: ${r2.finalUrl}`);
        const after = await autoLogin(page, url);
        if (!after) return 'lost';
        current = after.html; currentUrl = after.url;
      } else {
        current = r2.html; currentUrl = r2.finalUrl;
      }
    }
    if (!/navSection-nextLink|moduleDetailsPanel/.test(current)) {
      log(`[${el()}] not on the options page after login: ${currentUrl}`);
      return 'claimed';
    }
    log(`[${el()}] *** ENTRY SECURED (after login) - seat held in our session ***`);
    // no beep here ON PURPOSE: a powershell spawn at this exact moment steals
    // the RDP's CPU from the booking steps that follow (measured 2.5s delay)
    const pre = extractLink(current, 'navSection-nextLink') ||
                extractLink(current, 'bookContractor');
    if (pre) startParallelLogin(pre);
  } else if (/\/coe\/(options|entry)/.test(finalUrl) && /navSection-nextLink|moduleDetailsPanel/.test(html)) {
    log(`[${el()}] *** ENTRY SECURED - seat held in our session ***`);
    // no beep here ON PURPOSE: a powershell spawn at this exact moment steals
    // the RDP's CPU from the booking steps that follow (measured 2.5s delay)
    // per-module availability warning: "Fully booked" labels on the options
    // page mean some modules are gone - booking would be PARTIAL (and still
    // locks the account for 30 minutes). Warn loudly, let the human decide.
    const fullModules = (html.match(/cs-checkbox__exam-avalability--not-avalailable[^>]*>([^<]+)</g) || []).length;
    if (fullModules) {
      log(`[${el()}] !!! WARNING: ${fullModules} module(s) FULLY BOOKED on this exam - booking would be partial!`);
      ev('partial_availability', { fullModules });
      beep(2);
    }
    current = html; currentUrl = finalUrl;
    // NOTE: the parallel login is NOT started here anymore. It starts one
    // step later, straight from the bookContractor link (see the chain loop)
    // - the login tab used to re-render the selection page itself (~1.2s)
    // just to find that link, but the main chain already has it.
  } else {
    log(`[${el()}] Entry did not reach the options page (${status}). Response: ${html.replace(/\s+/g, ' ').substring(0, 150)}`);
    return 'lost';
  }

  // ---- CHAIN: follow the CONTINUE link from page to page until we reach
  // the review page, then click its link (the ORDER). The exact number of
  // steps varies (an account-details page appears after login, a voucher
  // page sometimes, etc.) - so we loop on page shape, not a fixed list.
  // Hard cap so we can never loop forever.
  for (let hop = 0; hop < 12; hop++) {
    // START THE LOGIN THE MOMENT WE HOLD THE bookContractor LINK - the login
    // wall sits behind it. The main chain just fetched this page, so the
    // login tab can jump straight to the wall instead of re-walking
    // (re-rendering) the earlier steps itself (~1.2s saved).
    if (!loginPromise && /\/coe\/selection/.test(currentUrl) && !/bookContractor/.test(currentUrl)) {
      const bc = extractLink(current, 'bookContractor');
      if (bc) {
        log(`[${el()}] login started (bookContractor link in hand)`);
        ev('login_start', { from: 'selection' });
        startParallelLogin(bc);
      }
    }

    // SKIP THE WALL FETCH: this page's bookContractor link leads to the
    // login wall, and the parallel login is already driving through it.
    // Fetching the link here would bounce off the login site and throw the
    // result away (~0.4s serially wasted) - go straight to waiting for the
    // login and taking the page its tab landed on.
    if (loginPromise && !wallSkipDone && /\/coe\/selection/.test(currentUrl) &&
        !/bookContractor/.test(currentUrl) && extractLink(current, 'bookContractor')) {
      wallSkipDone = true;
      const bcUrl = extractLink(current, 'bookContractor');
      const ok = await loginPromise;
      let took = false;
      try {
        const tu = loginTab ? loginTab.url() : '';
        if (loginTab && /\/coe\//.test(tu) && !/login\.goethe\.de/.test(tu)) {
          const c = await loginTab.content();
          if (c && c.length > 500) { current = c; currentUrl = tu; took = true; }
        }
      } catch (e) {}
      if (!took) {
        const r2 = await fetchPage(page, bcUrl);
        if (!r2.err) { current = r2.html; currentUrl = r2.finalUrl; }
      }
      if (/login\.goethe\.de/.test(currentUrl)) {
        const after = await autoLogin(page, currentUrl);
        if (!after) return 'lost';
        current = after.html; currentUrl = after.url;
      }
      continue;
    }

    // FAST-FAIL: the seat is gone (documented wording from other bots and
    // live sessions). Zero extra requests - a text scan on the page we
    // already hold. Only checked AFTER the module-selection step: the
    // options page carries per-module availability labels that look similar.
    // Bail out instantly and go back to hunting released seats instead of
    // walking a dead chain for 10 more seconds.
    if (hop > 0 && LOST_RACE_RE.test(current)) {
      const m = current.match(LOST_RACE_RE);
      log(`[${el()}] *** RACE LOST mid-chain ("${(m && m[0] || '').trim().substring(0, 40)}") - back to hunting released seats ***`);
      ev('race_lost', { at: currentUrl.substring(0, 90), phrase: m && m[0], hop });
      beep(2);
      return 'lost';
    }

    // Login wall in the middle of the chain (typical after BOOK FOR MYSELF).
    // The parallel login started at RACE START is usually done by now.
    if (/login\.goethe\.de/.test(currentUrl)) {
      const ok = loginPromise ? await loginPromise : await doLogin(currentUrl);
      if (ok) {
        // The navigation login leaves the login tab ON the post-login page:
        // reuse it directly - no extra round trip to re-download the page.
        let took = false;
        try {
          const tu = loginTab ? loginTab.url() : '';
          if (loginTab && /\/coe\//.test(tu) && !/login\.goethe\.de/.test(tu)) {
            const c = await loginTab.content();
            if (c && c.length > 500) {
              current = c; currentUrl = tu;
              took = true;
              log(`[${el()}] took the post-login page straight from the login tab: ${tu.substring(0, 60)}`);
            }
          }
        } catch (e) {}
        if (!took) {
          const r2 = await fetchPage(page, currentUrl);
          if (!r2.err) { current = r2.html; currentUrl = r2.finalUrl; }
        }
      }
      if (/login\.goethe\.de/.test(currentUrl)) {
        const after = await autoLogin(page, currentUrl);
        if (!after) return 'lost';
        current = after.html; currentUrl = after.url;
      }
    }

    // count (re)visits of the payment page: reaching it twice without
    // advancing means nothing is pre-selected there (Tunis rehearsal finding)
    if (/\/coe\/psp-selection/.test(currentUrl)) pspStuck++;

    // A leftover unconfirmed booking on the account blocks the flow with a
    // "DISCARD OTHER BOOKING" modal. Discard the OLD one and keep ours.
    if (/unconfirmedBookContainer/.test(current) && !/cancelUnconfirmed/.test(currentUrl)) {
      const disc = extractLink(current, 'unconfirmedBookContainer-cancelUnconfirmed');
      if (disc) {
        log(`[${el()}] An older unconfirmed booking is blocking - discarding it...`);
        const rd = await fetchPage(page, disc);
        if (!rd.err) { current = rd.html; currentUrl = rd.finalUrl; continue; }
      }
    }

    // On the review page the "continue" link IS the ORDER button.
    const onReview = /\/coe\/summary/.test(currentUrl);
    if (onReview && CONFIG.DRY_RUN) {
      log(`[${el()}] REVIEW page reached - DRY RUN stops here, ORDER not clicked.`);
      if (CONFIG.HOLD_SEC > 0) {
        log(`HOLDING the seat for ${CONFIG.HOLD_SEC}s (seat-holding experiment)...`);
        const t0 = Date.now();
        while (Date.now() - t0 < CONFIG.HOLD_SEC * 1000) {
          log(`  holding... ${Math.round((Date.now() - t0) / 1000)}s / ${CONFIG.HOLD_SEC}s`);
          await sleep(15000);
        }
      }
      log('DRY RUN cleanup: cancelling the half-made booking...');
      await cancelReviewBooking(ctx, currentUrl);
      return 'claimed';
    }
    if (onReview) log(`[${el()}] REVIEW page - clicking ORDER...`);

    // "BOOK FOR MYSELF" on the selection page; plain CONTINUE everywhere else.
    const key = /\/coe\/selection/.test(currentUrl) && !/bookContractor/.test(currentUrl)
      ? 'bookContractor' : 'navSection-nextLink';
    // A page can embed SEVERAL continue URLs (hidden modals carry copies).
    // On the review page we must use exactly one (it is the ORDER - never
    // click it more than once). Everywhere else we try each candidate in
    // turn until one actually moves the flow forward.
    const candidates = [...new Set([
      ...extractLinks(current, key),
      ...extractLinks(current, 'navSection-nextLink'),
    ])];
    const next = candidates[0] || null;

    // Form pages (account details) advance via a form POST, not a link GET.
    // If this page carries one, submit the whole form as the browser would.
    if (!onReview) {
      // Payment-method page: the Philippines (/ins/ph/) has nothing
      // pre-selected, so we pick INVOICE immediately (box toggle + CONTINUE,
      // both as Wicket-AJAX requests). Every other country has a method
      // pre-selected by default, so we do nothing there - zero extra time.
      // INSURANCE (added after the Tunis rehearsal): if ANY country's payment
      // page refuses to advance twice in a row (Tunis behaved like PH - no
      // pre-selection), select INVOICE there too. Never fires on a happy
      // path, saves ~15s of human clicking if it ever does.
      if (/\/coe\/psp-selection/.test(currentUrl) && !invoiceTried &&
          (/\/ins\/ph\//i.test(CONFIG.EXAM_URL) || pspStuck >= 2)) {
        invoiceTried = true; // only once per booking attempt
        try { fs.writeFileSync(path.join(__dirname, 'psp_dump.html'), current); } catch (e) {}
        const inv = pickInvoiceToggle(current);
        if (inv) {
          log(`[${el()}] payment: selecting INVOICE${pspStuck >= 2 ? ' (payment page refused to advance)' : ' (Philippines)'}...`);
          const base = './psp-selection' + (currentUrl.match(/\?\d+/) ? currentUrl.match(/\?\d+/)[0] : '');
          await fetchAjax(page, inv, base);
          const nl = extractLink(current, 'navSection-nextLink');
          if (nl) {
            const ra = await fetchAjax(page, nl, base);
            const red = (ra.body || '').match(/<redirect><!\[CDATA\[([^\]]+)\]\]><\/redirect>/);
            if (red) {
              // resolve like Wicket does: relative to the page path, not the full URL
              // ("../summary?13" + /coe/psp-selection -> /coe/summary?13)
              const target = new URL(red[1], currentUrl.replace(/\?.*$/, '')).href;
              if (/\/coe\//.test(target)) {
                const rp2 = await fetchPage(page, target);
                if (!rp2.err) {
                  current = rp2.html; currentUrl = rp2.finalUrl;
                  log(`[${el()}] payment: INVOICE selected -> ${rp2.finalUrl.substring(0, 60)}`);
                  continue;
                }
              }
            }
          }
          log(`[${el()}] payment: invoice toggle sent, continuing normally`);
        } else {
          log(`[${el()}] payment: Philippines but no invoice option found - using the default`);
        }
      }
      const postUrl = extractLink(current, 'infoSection-forwardLink');
      if (postUrl) {
        const fields = extractForm(current);
        const rp = await fetchPost(page, postUrl, fields);
        log(`[${el()}] form CONTINUE (POST, ${fields.length} fields, ${rp.ms}ms) -> ${rp.finalUrl.substring(0, 70)}`);
        if (!rp.err) {
          const prev = currentUrl;
          current = rp.html; currentUrl = rp.finalUrl;
          if (prev.replace(/\?.*$/, '') !== currentUrl.replace(/\?.*$/, '')) continue; // advanced
          // same page came back - fall through to the link candidates below
        }
      }
    }
    if (!next) {
      // No continue link: if we are off /coe/ entirely, the order already
      // went through and redirected us to the confirmation / payment page.
      if (!/\/coe\//.test(currentUrl)) {
        log(`[${el()}] Landed outside the booking app - likely booked: ${currentUrl.substring(0, 80)}`);
        await page.goto(currentUrl, { waitUntil: 'commit', timeout: 45000 });
        return 'won';
      }
      log(`[${el()}] No CONTINUE link on ${currentUrl.substring(0, 60)} - opening it in Brave, take over.`);
      log('  (the seat is already held in this browser session)');
      await page.goto(currentUrl, { waitUntil: 'commit', timeout: 45000 });
      return 'claimed';
    }

    let r = null, ci = 0;
    const pageKey = (u) => String(u).replace(/\?.*$/, '');
    for (let ci = 0; ci < (onReview ? 1 : Math.min(candidates.length, 4)); ci++) {
      const t = await fetchPage(page, candidates[ci]);
      // a bot challenge mid-chain: clear it in a real tab and retry this step
      if (!t.err && isChallenge(t.html)) {
        await clearChallenge(ctx, candidates[ci]);
        r = await fetchPage(page, candidates[ci]);
      } else {
        r = t;
      }
      if (r.err) break;                           // login wall / offsite
      r = t;
      // moved to a different page? this candidate works - done
      if (pageKey(t.finalUrl) !== pageKey(currentUrl)) break;
      // same page came back - a hidden modal's copy; try the next candidate
      log(`[${el()}] candidate ${ci + 1} did not advance - trying the next CONTINUE link`);
    }

    const r0 = r; // the chosen request result (kept for the ORDER branch below)
    if (onReview) {
      // the ORDER click - redirects to the payment provider (UAE) or the
      // confirmation page (Pakistan), both outside our background reach
      log(`[${el()}] ORDER clicked (${r0.ms}ms) - opening the result in Brave...`);
      await page.goto(candidates[0], { waitUntil: 'commit', timeout: 45000 }).catch(() => {});
      await sleep(4000);
      const nowAt = page.url();
      log(`[${el()}] Now at: ` + nowAt);
      // Verify: if the ORDER was refused (seats gone at the last moment),
      // keep hunting instead of celebrating.
      const body = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
      if (LOST_RACE_RE.test(body)) {
        log(`[${el()}] *** ORDER REFUSED (race lost at the last click) - resuming the hunt ***`);
        ev('race_lost', { at: 'order', phrase: (body.match(LOST_RACE_RE) || [])[0] });
        return 'lost';
      }
      return 'won';
    }
    log(`[${el()}] continue (${r.ms}ms) -> ${r.finalUrl.substring(0, 70)}`);
    if (r.err) {
      // The step redirected off goethe.de - almost always the login wall.
      // Fast path: background login from the login tab (~1-2s), then resume.
      const failedUrl = candidates[ci] || next;
      const ok = loginPromise ? await loginPromise : await doLogin(failedUrl);
      if (ok) {
        // reuse the login tab's landed page if the navigation login ran
        let took = false;
        try {
          const tu = loginTab ? loginTab.url() : '';
          if (loginTab && /\/coe\//.test(tu) && !/login\.goethe\.de/.test(tu)) {
            const c = await loginTab.content();
            if (c && c.length > 500) { current = c; currentUrl = tu; took = true; }
          }
        } catch (e) {}
        if (!took) {
          const r2 = await fetchPage(page, failedUrl);
          if (!r2.err) { current = r2.html; currentUrl = r2.finalUrl; continue; }
        } else { continue; }
      }
      // Fallback: type it into the visible tab (slower but sure)
      const after = await autoLogin(page, failedUrl);
      if (!after) { await page.goto(failedUrl, { waitUntil: 'commit' }); return 'claimed'; }
      current = after.html; currentUrl = after.url;
      continue;
    }
    const prevUrl = currentUrl;
    current = r.html; currentUrl = r.finalUrl;

    // Stuck detector: same page coming back again and again (e.g. the
    // account-details page refusing to continue because a required field is
    // empty). Hand over to a human rather than burning the session.
    if (/\/coe\//.test(prevUrl) && prevUrl.replace(/\?\d+$/, '') === currentUrl.replace(/\?\d+$/, '')) {
      stuckCount++;
      if (stuckCount >= 3) {
        log(`[${el()}] Page ${currentUrl.substring(0, 60)} keeps returning - it probably needs input.`);
        log('  Opening it in Brave - CHECK/FILL THE FIELDS AND CLICK CONTINUE.');
        await alarm('PAGE NEEDS YOUR INPUT - FINISH IN BRAVE NOW');
        try { if (loginTab) await loginTab.close(); } catch (e) {}
        await page.goto(currentUrl, { waitUntil: 'commit', timeout: 45000 });
        return 'claimed';
      }
    } else {
      stuckCount = 0;
    }

    // Off the booking app entirely: order already complete.
    if (!/\/coe\//.test(currentUrl) && !/login\.goethe\.de/.test(currentUrl)) {
      log(`[${el()}] Landed outside the booking app - likely booked: ${currentUrl.substring(0, 80)}`);
      await page.goto(currentUrl, { waitUntil: 'commit', timeout: 45000 });
      return 'won';
    }
  }

  log(`[${el()}] Too many pages in the chain - CHECK THE BRAVE TAB NOW.`);
  try { if (loginTab) await loginTab.close(); } catch (e) {}
  await page.goto(currentUrl, { waitUntil: 'commit', timeout: 45000 });
  return 'claimed';
}

main()
  .then(() => { log('Racer finished.'); process.exit(0); }) // the CDP connection keeps Node alive otherwise
  .catch(e => { log('FATAL: ' + e.message); console.error(e); process.exit(1); });
process.on('SIGINT', () => { console.log('\nStopped by user.'); process.exit(0); });
