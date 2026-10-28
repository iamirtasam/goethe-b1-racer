// sweep.js - check B1 availability across nearby countries in one run.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const COUNTRIES = [
  ['ae', 'UAE (Dubai/Abu Dhabi)'],
  ['om', 'Oman (Muscat)'],
  ['bd', 'Bangladesh (Dhaka)'],
  ['th', 'Thailand (Bangkok)'],
  ['my', 'Malaysia (KL)'],
  ['az', 'Azerbaijan (Baku)'],
  ['uz', 'Uzbekistan (Tashkent)'],
  ['kz', 'Kazakhstan (Almaty)'],
  ['eg', 'Egypt (Cairo/Alex)'],
  ['tr', 'Turkey'],
  ['qa', 'Qatar'],
  ['sa', 'Saudi Arabia'],
];

(async () => {
  let browser = null;
  try { browser = await chromium.connectOverCDP('http://127.0.0.1:9224', { timeout: 3000 }); }
  catch (e) {
    const child = spawn('C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', [
      '--remote-debugging-port=9224', `--user-data-dir=${path.join(__dirname, 'watcher-profile')}`,
      '--no-first-run', '--no-default-browser-check', '--window-size=800,200',
    ], { stdio: 'ignore', detached: true });
    child.unref();
    for (let i = 0; i < 30; i++) {
      try { browser = await chromium.connectOverCDP('http://127.0.0.1:9224', { timeout: 5000 }); break; }
      catch (e2) { await sleep(1000); }
    }
  }
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  for (const [cc, name] of COUNTRIES) {
    try {
      await page.goto(`https://www.goethe.de/ins/${cc}/en/spr/prf/gzb1.cfm`, { waitUntil: 'load', timeout: 45000 });
      let finders = [];
      for (let w = 0; w < 8 && !finders.length; w++) {
        finders = await page.evaluate(() => [...new Set(performance.getEntriesByType('resource').map(r => r.name).filter(u => u.includes('/rest/examfinder/')))]).catch(() => []);
        if (!finders.length) await sleep(1200);
      }
      if (!finders.length) { console.log(`${name.padEnd(22)} - no exam list on the page`); continue; }
      const rows = await page.evaluate(async (urls) => {
        const out = await Promise.all(urls.map(async (u) => {
          try {
            const r = await fetch(u + '&_=' + Date.now(), { credentials: 'include', cache: 'no-store',
              headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01' } });
            const j = await r.json(); return (j && j.DATA) || [];
          } catch (e) { return []; }
        }));
        return out.flat();
      }, finders);
      if (!rows.length) { console.log(`${name.padEnd(22)} - list empty`); continue; }
      const summary = rows.slice(0, 8).map(r =>
        `${(r.locationName || '?')}[${String(r.eventTimeSpan || '').replace(/\s+/g, '').trim()}]:${r.oid ? (r.buttonDisabled ? 'FULL' : 'OPEN') : 'locked'}`
      ).join('  ');
      const openCount = rows.filter(r => r.oid && !r.buttonDisabled).length;
      console.log(`${name.padEnd(22)} - ${rows.length} rows, ${openCount} OPEN  |  ${summary.substring(0, 150)}`);
    } catch (e) {
      console.log(`${name.padEnd(22)} - page error: ${String(e.message).substring(0, 50)}`);
    }
  }
  process.exit(0);
})();
