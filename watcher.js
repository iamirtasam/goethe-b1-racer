// watcher.js - 24/7 released-seat watcher. COMPLETELY SEPARATE from the racer:
//   - its own browser profile (watcher-profile/) and port (9224)
//   - its own log files (watcher.log, watcher-events.jsonl)
//   - never logs in, never books anything - only READS the public exam list
//     API, so it can safely run at the same time as the racer on race day.
//
// What it does: polls the exam-finder API every 30s (gentle - no rate-limit
// risk). The moment ANY row for the watched city flips to OPEN (oid present,
// button enabled) - a fresh opening OR a released seat - it alarms LOUDLY
// (repeating beeps + console banner) and keeps alarming every 30s until the
// row goes full again. It also logs every availability change (seats
// draining) and every lastUpdated change.
//
// Run it on YOUR PC (normal internet - no proxy needed, home IP works):
//   node watcher.js                     # watches Lahore
//   node watcher.js --city=Islamabad    # any city
//   node watcher.js --city=any          # alarm on ANY open row
//
// When it alarms, it LAUNCHES THE RACER ITSELF as a separate process
// (node racer.js ...), with the racer's own Brave (port 9222) - the watcher
// only reads the public exam list (port 9224), so they never collide. The
// racer then races for the seat exactly like a manual run.
//
//   node watcher.js                     # watches Lahore, launches racer on OPEN
//   node watcher.js --city=Islamabad    # any city
//   node watcher.js --city=any          # alarm on ANY open row
//   node watcher.js --nolaunch          # alarm only - YOU run the racer
//   node watcher.js --creds=creds-main.json --date=12.09
//                                         # extra flags passed to the racer

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = {};
process.argv.slice(2).forEach(a => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args[m[1]] = m[2] !== undefined ? m[2] : true;
});

const CITY = String(args.city || 'Lahore').toLowerCase();
const POLL_SEC = Number(args.interval || 30);
const NO_LAUNCH = !!args.nolaunch;   // --nolaunch: alarm only, never start the racer
// extra racer flags: --creds, --date, --dry pass straight through
const RACER_EXTRA = ['creds', 'date', 'dry', 'url', 'tz'].filter(k => args[k])
  .map(k => `--${k}=${args[k]}`).join(' ');
// verbatim extra flags for the racer launch, e.g.
//   --racer-args="--port=9223 --profile=brave-profile-friend --relay=3129"
// (a second racer on the SAME machine needs its own port/profile/relay)
const RACER_ARGS = String(args['racer-args'] || '');
const EXAM_URL = args.url || 'https://www.goethe.de/ins/pk/en/spr/prf/gzb1.cfm';
const BRAVE = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
// this watcher's OWN browser - two watchers on one PC need different ports+profiles
const PORT = Number(args.port || 9224);
const PROFILE = args.profile ? path.resolve(String(args.profile)) : path.join(__dirname, 'watcher-profile');
const TAG = args.tag ? String(args.tag) + ':' : ''; // log prefix for multi-watcher setups
const LOG_FILE = path.join(__dirname, (args.logfile || 'watcher') + '.log');
const EV_FILE = path.join(__dirname, (args.logfile || 'watcher') + '-events.jsonl');

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch (e) {}
}
function ev(type, data) {
  try { fs.appendFileSync(EV_FILE, JSON.stringify(Object.assign({ t: Date.now(), type }, data || {})) + '\n', 'utf8'); } catch (e) {}
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function beep(times = 1) {
  const one = '[console]::beep(1000,250);[console]::beep(1400,350);';
  try { spawn('powershell.exe', ['-NoProfile', '-Command', one.repeat(Math.max(1, times))], { stdio: 'ignore' }); } catch (e) {}
}

async function ensureBrowser() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) return await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 10000 });
  } catch (e) {}
  try { spawn('taskkill', ['/IM', 'brave.exe', '/F'], { stdio: 'ignore' }); } catch (e) {}
  await sleep(2500);
  const child = spawn(BRAVE, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=800,200',
  ], { stdio: 'ignore', detached: true });
  child.unref();
  for (let i = 0; i < 30; i++) {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 10000 }); }
    catch (e) { await sleep(1000); }
  }
  throw new Error('watcher browser did not come up');
}

(async () => {
  console.log('\nGOETHE SEAT WATCHER (runs forever - Ctrl+C to stop)');
  console.log(`Watching : ${CITY === 'any' ? 'ANY city' : CITY + ' (Pakistan B1)'}`);
  console.log(`On OPEN  : ${NO_LAUNCH ? 'alarm only (--nolaunch)' : 'LAUNCHES THE RACER automatically'}`);
  console.log(`Poll     : every ${POLL_SEC}s | Log: watcher.log + watcher-events.jsonl`);
  console.log('Safe to run alongside the racer - it never books anything itself.\n');

  let browser = null, ctx = null, page = null;
  let finderUrls = [];
  let lastOpen = {};   // rowKey -> true while we are alarming (re-arms when it goes full)
  let rowState = {};   // rowKey -> signature (for change logging)
  let errStreak = 0;
  let racerRunning = false; // one racer at a time (concurrent = session death)

  while (true) {
    try {
      if (!browser || !page) {
        browser = await ensureBrowser();
        ctx = browser.contexts()[0];
        page = await ctx.newPage();
        await page.goto(EXAM_URL, { waitUntil: 'load', timeout: 60000 }).catch(() => {});
        try { await page.getByText('Accept All', { exact: true }).first().click({ timeout: 3000 }); } catch (e) {}
        for (let w = 0; w < 12 && !finderUrls.length; w++) {
          finderUrls = await page.evaluate(() => [...new Set(performance.getEntriesByType('resource').map(r => r.name).filter(u => u.includes('/rest/examfinder')))]).catch(() => []);
          if (!finderUrls.length) await sleep(1500);
        }
        if (!finderUrls.length) { log('!! no finder API - reloading in a minute'); await sleep(60000); continue; }
        await page.goto('https://www.goethe.de/robots.txt', { waitUntil: 'load', timeout: 30000 }).catch(() => {});
        log(`watching ${finderUrls.length} finder(s)`);
      }

      const res = await page.evaluate(async (urls) => {
        const out = await Promise.all(urls.map(async (u) => {
          try {
            const r = await fetch(u + (u.includes('?') ? '&' : '?') + '_=' + Date.now(), { credentials: 'include', cache: 'no-store',
              headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json, text/javascript, */*; q=0.01' } });
            if (!r.ok) return [];
            const j = await r.json(); return (j && j.DATA) || [];
          } catch (e) { return []; }
        }));
        return out.flat();
      }, finderUrls).catch(() => null);

      if (!res) {
        errStreak++;
        if (errStreak % 5 === 1) log(`poll failed (streak ${errStreak}) - retrying; browser restart at 5`);
        if (errStreak >= 5) { try { await browser.close(); } catch (e) {} browser = null; page = null; finderUrls = []; errStreak = 0; }
        await sleep(POLL_SEC * 1000);
        continue;
      }
      errStreak = 0;

      const seen = {};
      for (const raw of res) {
        const loc = String(raw.locationName || '');
        const key = loc + '|' + String(raw.eventTimeSpan || '').trim();
        seen[key] = true;
        if (CITY !== 'any' && !loc.toLowerCase().includes(CITY)) continue;

        // log every state change of the watched rows
        const sig = [raw.oid, raw.buttonDisabled, raw.availability, raw.availabilityText, raw.lastUpdated].join('|');
        if (rowState[key] !== sig) {
          rowState[key] = sig;
          const open = !!(raw.oid && !(raw.buttonDisabled && String(raw.buttonDisabled).trim()));
          ev('row_change', {
            location: loc, span: String(raw.eventTimeSpan || '').trim(),
            open, oid: raw.oid ? String(raw.oid).substring(0, 16) + '...' : null,
            availability: raw.availability,
            availabilityText: String(raw.availabilityText || '').replace(/<br\s*\/?>/gi, ' ').trim().substring(0, 50),
            lastUpdated: raw.lastUpdated, bookFrom: raw.bookFrom, bookFromTime: raw.bookFromTime,
          });
          log(`${loc} [${String(raw.eventTimeSpan || '').trim()}] ${open ? 'OPEN' : 'closed'} avail=${raw.availability} lastUpd=${raw.lastUpdated || '-'}`);

          // THE ALARM: row just became bookable and we were not already alarming
          if (open && !lastOpen[key]) {
            lastOpen[key] = true;
            const banner =
              '\n' + '='.repeat(60) +
              `\n  *** SEAT OPEN: ${loc} [${String(raw.eventTimeSpan || '').trim()}] avail=${raw.availability} ***` +
              (NO_LAUNCH ? '\n  RUN THE RACER NOW (on the RDP or here - not both):' : '\n  LAUNCHING THE RACER AUTOMATICALLY...') +
              `\n  node racer.js --city="${loc}" ${RACER_EXTRA || '--creds=creds-main.json'}` +
              '\n' + '='.repeat(60);
            console.log(banner);
            fs.appendFileSync(LOG_FILE, banner + '\n', 'utf8');
            ev('alarm', { location: loc, span: String(raw.eventTimeSpan || '').trim(), availability: raw.availability });
            beep(4);

            // launch the racer as a SEPARATE process. One racer at a time:
            // if an earlier one is still running, let it finish (a second
            // concurrent racer on the same account would kill both sessions
            // - the same account-pairing error we proved on 01.09).
            if (!NO_LAUNCH && !racerRunning) {
              const racerArgs = ['racer.js', `--city=${loc}`];
              if (RACER_EXTRA) racerArgs.push(RACER_EXTRA.split(' '));
              else racerArgs.push('--creds=creds-main.json');
              if (RACER_ARGS) racerArgs.push(RACER_ARGS.split(' '));
              const cmd = racerArgs.flat().join(' ');
              log(`watcher launching racer: node ${cmd}`);
              ev('racer_launch', { cmd });
              const child = spawn('node', racerArgs.flat(), {
                cwd: __dirname, stdio: 'inherit', detached: true,
              });
              child.unref();
              child.on('exit', (code) => {
                racerRunning = false;
                log(`racer exited (code ${code}) - watcher can trigger again`);
                ev('racer_exit', { code });
              });
              racerRunning = true;
            } else if (!NO_LAUNCH) {
              log('racer already running - NOT launching a second one.');
            }
          }
          if (!open && lastOpen[key]) {
            lastOpen[key] = false; // gone again - re-arm the alarm
            log(`${loc} [${String(raw.eventTimeSpan || '').trim()}] no longer open (avail=${raw.availability}) - alarm re-armed`);
          }
        }
      }
      // rows that disappeared from the API entirely
      for (const k of Object.keys(rowState)) {
        if (!seen[k] && !k.toLowerCase().includes(CITY) || CITY === 'any' && !seen[k]) {
          if (!rowState[k + '_gone']) {
            rowState[k + '_gone'] = true;
            log(`row disappeared from the list: ${k}`);
            ev('row_gone', { key: k });
          }
        }
      }
    } catch (e) {
      log('watcher error: ' + String(e.message || e).substring(0, 80));
      try { await browser.close(); } catch (e2) {}
      browser = null; page = null; finderUrls = [];
    }
    await sleep(POLL_SEC * 1000);
  }
})();
