// LATENCY TEST - measures real request speed to the Goethe booking servers.
// Run this on YOUR PC and on the RDP to compare. Higher score = faster
// booking. What matters most is the "full request" numbers, because that is
// exactly what the racer pays on every booking step.
//
//   node speedtest.js

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const BRAVE_PATH = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const CDP_PORT = 9222;
const PROFILE_DIR = path.join(__dirname, 'brave-profile');
const N = 10; // requests per test

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function ensureBrave() {
  const check = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch (e) { return false; }
  };
  if (await check()) return;
  try { spawn('taskkill', ['/IM', 'brave.exe', '/F'], { stdio: 'ignore' }); } catch (e) {}
  await sleep(3000);

  const braveArgs = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1100,800',
  ];

  // proxy support (same as the racer): start the local relay, route Brave
  let PROXY = null;
  try { PROXY = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'proxy.json'), 'utf8')); } catch (e) {}
  if (PROXY && PROXY.host) {
    const relayOk = () => new Promise((resolve) => {
      const net = require('net');
      const s = net.connect(3128, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
      setTimeout(() => { s.destroy(); resolve(false); }, 1000);
    });
    if (!(await relayOk())) {
      console.log('Starting local proxy relay...');
      const relay = spawn('node', [path.join(__dirname, 'proxyauth.js')], { detached: true, stdio: 'ignore' });
      relay.unref();
      for (let i = 0; i < 10; i++) { await sleep(500); if (await relayOk()) break; }
    }
    braveArgs.push('--proxy-server=http://127.0.0.1:3128');
    console.log(`Using proxy ${PROXY.host}:${PROXY.port} (Germany exit)`);
  }

  spawn(BRAVE_PATH, braveArgs, { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 30; i++) { await sleep(1000); if (await check()) return; }
  throw new Error('Could not start Brave.');
}

function stats(a) {
  const s = [...a].sort((x, y) => x - y);
  return {
    min: Math.round(s[0]),
    avg: Math.round(s.reduce((x, y) => x + y, 0) / s.length),
    max: Math.round(s[s.length - 1]),
  };
}

(async () => {
  console.log('GOETHE SPEED TEST');
  console.log('=================');
  console.log('Machine:', require('os').hostname(), '| Time:', new Date().toString());
  console.log('Requests per test:', N, '\n');

  await ensureBrave();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: 15000 });
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();

  // Warm up: load the exam page once so DNS/TLS/cookies are established,
  // exactly like the racer does before the race starts.
  console.log('Opening the exam page (warm-up)...');
  await page.goto('https://www.goethe.de/ins/pk/en/spr/prf/gzb1.cfm', { waitUntil: 'load', timeout: 60000 });
  try { await page.getByText('Accept All', { exact: true }).first().click({ timeout: 3000 }); } catch (e) {}
  let finderUrl = await page.evaluate(() => {
    const urls = performance.getEntriesByType('resource').map(r => r.name).filter(u => u.includes('/rest/examfinder'));
    return urls[urls.length - 1] || null;
  });
  // Fallback: the Pakistan B1 finder URL (known from earlier captures). Works
  // even when the warm-up page was slow or partially blocked.
  if (!finderUrl) {
    finderUrl = 'https://www.goethe.de/rest/examfinder/exams/institute/O%2010000366?category=E006&type=ER&countryIsoCode=pk&count=50';
    console.log('(exam API not seen on page - using the known Pakistan B1 URL)');
  }
  await page.goto('https://www.goethe.de/robots.txt', { waitUntil: 'load', timeout: 30000 }).catch(() => {});

  // ---- Test 1: exam-list API (the "is the seat open?" check)
  let apiAvg = 0;
  if (finderUrl) {
    const api = await page.evaluate(async ({ u, n }) => {
      const times = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        try {
          const r = await fetch(u + (u.includes('?') ? '&' : '?') + '_=' + Date.now(), { credentials: 'include', cache: 'no-store' });
          await r.json();
        } catch (e) {}
        times.push(performance.now() - t0);
        await new Promise(res => setTimeout(res, 300));
      }
      return times;
    }, { u: finderUrl, n: N });
    const s = stats(api); apiAvg = s.avg;
    console.log(`\n1) SEAT CHECK (exam list API), ${N} tries:`);
    console.log(`   min ${s.min}ms | avg ${s.avg}ms | max ${s.max}ms`);
  } else {
    console.log('\n1) SEAT CHECK: could not find the exam API URL on the page');
  }

  // ---- Test 2: booking app response (what every booking step pays)
  const coe = await page.evaluate(async (n) => {
    const times = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      try {
        // a harmless booking-app URL; it will answer with a redirect/error
        // page, but the round trip is the same as a real step
        const r = await fetch('/coe?lang=en&_=' + Date.now(), { credentials: 'include', cache: 'no-store', redirect: 'follow' });
        await r.text();
      } catch (e) {}
      times.push(performance.now() - t0);
      await new Promise(res => setTimeout(res, 300));
    }
    return times;
  }, N);
  const s2 = stats(coe);
  console.log(`\n2) BOOKING STEP (booking app request), ${N} tries:`);
  console.log(`   min ${s2.min}ms | avg ${s2.avg}ms | max ${s2.max}ms`);

  // ---- Test 3: login server response (the login wall step)
  const cas = await page.evaluate(async (n) => {
    const times = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      try {
        const r = await fetch('https://login.goethe.de/robots.txt?_=' + Date.now(), { cache: 'no-store' });
        await r.text();
      } catch (e) {}
      times.push(performance.now() - t0);
      await new Promise(res => setTimeout(res, 300));
    }
    return times;
  }, N);
  const s3 = stats(cas);
  console.log(`\n3) LOGIN SERVER, ${N} tries:`);
  console.log(`   min ${s3.min}ms | avg ${s3.avg}ms | max ${s3.max}ms`);

  console.log('\n=================');
  console.log('SCORE (avg seat check + avg booking step):', s2.avg + apiAvg, 'ms');
  console.log('The lower, the faster the racer books from this machine.');
  console.log('\nLeaving Brave open - close it yourself if you want.');
  process.exit(0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
