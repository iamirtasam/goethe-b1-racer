// check-pk.js - one-shot: is Lahore still open? Reads the public exam list.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const BRAVE = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const PORT = 9224;
const PROFILE = path.join(__dirname, 'watcher-profile');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // reuse the watcher's browser if it is running (port 9224)
  let browser = null;
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 3000 }); }
  catch (e) {
    const child = spawn(BRAVE, [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run', '--no-default-browser-check', '--window-size=800,200',
    ], { stdio: 'ignore', detached: true });
    child.unref();
    for (let i = 0; i < 30; i++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 5000 }); break; }
      catch (e2) { await sleep(1000); }
    }
  }
  if (!browser) { console.log('!! no browser'); process.exit(1); }
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.goto('https://www.goethe.de/ins/pk/en/spr/prf/gzb1.cfm', { waitUntil: 'load', timeout: 60000 });
  try { await page.getByText('Accept All', { exact: true }).first().click({ timeout: 3000 }); } catch (e) {}
  let finderUrls = [];
  for (let w = 0; w < 12 && !finderUrls.length; w++) {
    finderUrls = await page.evaluate(() => [...new Set(performance.getEntriesByType('resource').map(r => r.name).filter(u => u.includes('/rest/examfinder/')))]).catch(() => []);
    if (!finderUrls.length) await sleep(1500);
  }
  const rows = await page.evaluate(async (urls) => {
    const out = await Promise.all(urls.map(async (u) => {
      const r = await fetch(u + '&_=' + Date.now(), { credentials: 'include', cache: 'no-store',
        headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01' } });
      const j = await r.json(); return (j && j.DATA) || [];
    }));
    return out.flat();
  }, finderUrls);
  const now = new Date().toLocaleTimeString('en-GB', { hour12: false });
  for (const r of rows) {
    console.log(`[${now}] ${(r.locationName || '?').padEnd(12)} [${String(r.eventTimeSpan || '').replace(/\s+/g, ' ').trim().padEnd(20)}] ` +
      `${r.oid ? (r.buttonDisabled ? 'FULL' : '** OPEN **') : 'closed'} avail=${r.availability} lastUpd=${r.lastUpdated || '-'}`);
  }
  try { await page.close(); } catch (e) {}
  process.exit(0);
})().catch(e => { console.log('CRASHED: ' + (e.stack || e)); process.exit(1); });
