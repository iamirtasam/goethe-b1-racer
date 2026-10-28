// Records the Goethe booking flow while you click through it by hand.
// Drives real Brave over CDP and logs every relevant request/response to
// recorder.json. Run: node recorder.js  ... then browse & book in that window.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  try { await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(1500) }); }
  catch (e) {
    spawn('C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      ['--remote-debugging-port=9222', '--user-data-dir=H:\\goethe\\brave-profile',
       '--no-first-run', '--no-default-browser-check'],
      { detached: true, stdio: 'ignore' }).unref();
    await sleep(7000);
  }
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const entries = [];

  const record = (page, tag) => {
    page.on('request', r => {
      const u = r.url();
      if (/goethe\.de/.test(u) && !/resource|\.css|\.js|\.png|\.jpg|\.svg|\.woff|\.gif|favicon|analytics|akamai|\.json.*wicket/i.test(u)) {
        entries.push({ t: Date.now(), tag, kind: 'req', method: r.method(), url: u.substring(0, 200),
          post: r.method() !== 'GET' ? (r.postData() || '').substring(0, 800) : undefined });
      }
    });
    page.on('response', async r => {
      const u = r.url();
      if (/goethe\.de/.test(u) && (/\/coe\/|login\.goethe\.de/.test(u)) && r.status() < 400) {
        let body = '';
        try { body = (await r.text()).substring(0, 3000); } catch (e) {}
        entries.push({ t: Date.now(), tag, kind: 'res', status: r.status(), url: u.substring(0, 200), body });
      }
    });
  };

  for (const p of b.contexts()[0].pages()) record(p, 'existing');
  b.contexts()[0].on('page', p => record(p, 'new'));

  console.log('RECORDER ON - do your booking in the Brave window (review page -> X -> Cancel booking).');
  console.log('recorder.json is written continuously; Ctrl+C when done.');

  setInterval(() => fs.writeFileSync('recorder.json', JSON.stringify(entries, null, 1)), 2000);
  setInterval(() => console.log(`  ... ${entries.length} entries`), 30000);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
