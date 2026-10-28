// uz.js - Uzbekistan B1 page: fees, dates, locations, availability.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  const reqs = [];
  page.on('request', r => { if (/examfinder/i.test(r.url())) reqs.push(r.url()); });

  await page.goto('https://www.goethe.de/ins/uz/de/spr/prf/gzb1.cfm', { waitUntil: 'load', timeout: 60000 });
  await sleep(6000);
  console.log('page title:', await page.title());
  const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  console.log('--- page text around dates/prices ---');
  const i = txt.search(/PRÜFUNGSTERMINE|TERMIN|DATUM/i);
  console.log(txt.substring(Math.max(0, i - 50), i + 1200));
  console.log('--- finder API requests fired ---');
  console.log(reqs.length ? reqs.join('\n') : '(none seen)');

  // any money mentions
  const money = txt.match(/[^.]{0,60}(?:UZS|USD|EUR|SUM|So.?m)[^.]{0,80}/gi) || [];
  console.log('--- money mentions ---');
  [...new Set(money.map(m => m.trim().substring(0, 140)))].slice(0, 10).forEach(m => console.log('   ' + m));

  // replay finder if present
  if (reqs.length) {
    const j = await page.evaluate(async (u) => {
      const resp = await fetch(u + (u.includes('?') ? '&' : '?') + '_=' + Date.now(), { credentials: 'include', cache: 'no-store',
        headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01' } });
      const jj = await resp.json();
      return (jj.DATA || []).map(d => ({
        loc: d.locationName, span: String(d.eventTimeSpan || '').trim(),
        oid: d.oid ? 'YES' : 'null', disabled: d.buttonDisabled, avail: d.availability,
        bookFrom: d.bookFrom, time: d.bookFromTime,
        price: (d.price || d.priceExternal || ''), link: (d.buttonLink || '').substring(0, 60),
      }));
    }, reqs[0]);
    console.log('--- rows from API ---');
    j.forEach(r => console.log(JSON.stringify(r)));
    if (!j.length) console.log('(API returned no rows)');
  }
  process.exit(0);
})().catch(e => { console.log('ERR ' + e.message); process.exit(1); });
