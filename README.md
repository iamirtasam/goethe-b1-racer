# 🏁 Goethe B1 Racer

**Grabs a Goethe-Institut B1 exam seat the second it opens — any country, any city — and drives the entire booking to the end.**

A Playwright-driven seat watcher + booking bot that polls the public exam-finder API at racing speed, fires the booking the instant an `oid` (booking token) appears, and walks the whole reservation chain with background requests instead of page reloads:

```
entry → modules → BOOK FOR MYSELF → login → payment method → ORDER
```

Tested on Goethe exam pages in **🇵🇰 Pakistan · 🇦🇪 UAE · 🇧🇩 Bangladesh · 🇴🇲 Oman · 🇹🇳 Tunisia · 🇵🇭 Philippines** — and any other country works too, because the exam API URL is discovered automatically from whatever exam page you point it at.

## How it wins

| Trick | What it buys |
|---|---|
| One parked tab, tiny in-page `fetch`es from `robots.txt` | No page reloading at all; requests carry the browser's real cookies + fingerprint |
| Auto-armed **TURBO** (4/s, from −180 s) and **ULTRA** (12/s, last 60 s) | Catches the flip within ~0.4 s of the advertised opening time |
| Instant entry the moment the `oid` appears + parallel CAS login in a pre-warmed 2nd tab | Login never blocks the chain (single slowest step done before it's needed) |
| Navigation-form login | Tab lands *directly* on the page after the login wall — no re-fetch |
| Whole booking chain as background requests (Wicket link/form scraping) | Typical run: flip detected < 0.4 s · entry ~1 s · ORDER-ready in ~10–14 s |
| Calm mode (default) vs `--fast` | Gentle 1/s rate-keeping avoids Akamai IP lockouts at mass openings |
| Human takeover fallbacks | A page that needs human input opens in the live Brave window instead of failing |

## Architecture

```
┌──────────────────────────── Machine running the bot ────────────────────────────┐
│                                                                                 │
│   watcher.js (CDP :9224)                       racer.js (CDP :9222)             │
│   ┌────────────────────────────────┐   spawn   ┌──────────────────────────────┐  │
│   │ polls exam list every 30s      │ ────────► │ polls API 1/s → TURBO → ULTRA│  │
│   │ read-only, never logs in       │  on OPEN  │ oid appears → fire entry     │  │
│   │ loud alarm (beeps + banner)    │           │ parallel login → chain walk  │  │
│   └───────────────┬────────────────┘           │ ORDER → 'WON - CHECK EMAIL'  │  │
│                   │                            └──────────────┬───────────┬───┘  │
│                   ▼ all requests in-page                      │           │      │
│          goethe.de /rest/examfinder/…        proxyauth.js :3128   login.goethe.de
│                    ▲                      ┌────────────────┐   ▲   DIRECT      │
│                    └──────────────────────│ real Brave only│───┘  (not IP-     │
│             (Chromium stealth fails; the   └────────────────┘   blocked there)   │
│             site's bot protection knows)         │ optional                       │
│                                                  ▼                                │
│                                     German/any residential proxy                  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## Quick start

**Prereqs:** Node.js 18+ and a real **Brave** browser. Code is written for Windows (beep alarms, `taskkill` recovery, Brave exe path), but Linux/macOS work with those three spots tweaked per script.

```bash
git clone https://github.com/iamirtasam/goethe-b1-racer
cd goethe-b1-racer
npm install

# your account(s) — one file per identity
cp creds.example.json  creds.json

# optional but recommended: a residential proxy matching where the exam page expects you
cp proxy.example.json  proxy.json
```

> **Why the proxy?** Datacenter IPs (cloud VMs, RDPs) are commonly blocked by the
> Goethe site's bot protection. Plain automated Chromium gets blocked too — that's
> why the bot drives a *real* Brave browser. The login server
> (`login.goethe.de`) is never IP-blocked, and bypasses the proxy automatically
> to shave latency off the login hop.

### 1. Dry-run the booking flow (no real booking happens)

```bash
node racer.js --dry --city=Dubai --url=https://www.goethe.de/ins/ae/en/spr/prf/gzb1.cfm --tz=4
```

`--dry` stops at the review page and cancels the half-made booking so the account stays clean.

### 2. Watch for an opening 24/7 (alarm + optional auto-launch)

```bash
node watcher.js                     # default city "Lahore" (PK page)
node watcher.js --city="Cebu City" --url=https://www.goethe.de/ins/ph/en/spr/prf/gzb1.cfm
node watcher.js --city=any          # alarm on ANY city's open row
node watcher.js --city=Tokyo --nolaunch    # alarm only — you start the racer yourself
```

### 3. Race for real

```bash
node racer.js --city=Tokyo --url=https://www.goethe.de/ins/jp/en/spr/prf/gzb1.cfm --tz=9 --creds=creds-main.json
```

Or double-click `start-bot.bat` (edit its variables at the top first).

### 4. Timezone cheat-sheet (`--tz`)

The `--tz` offset is the **UTC offset of the city whose page advertises the
opening time** — the bot converts `"04.09.2026 11:12"` into a real instant on
any machine.

| City/page | `--tz` | | City/page | `--tz` |
|---|---|---|---|---|
| Tunisia | 1 | | Thailand | 7 |
| Turkey | 3 | | Pakistan (default) | 5 |
| UAE | 4 | | Bangladesh | 6 |
| Philippines | 8 | | Japan | 9 |

## Scripts

| Script | What it does |
|---|---|
| `watcher.js` | 24/7 seat watcher: read-only polling, loud alarms, optionally spawns the racer on OPEN |
| `racer.js` | The racer: polling phases + gate hammering + full booking chain |
| `speedtest.js` | Latency benchmark (seat API / booking step / login server); compare machines, run pre-race |
| `recorder.js` | Records a manual booking walkthrough (`recorder.json`) — for reverse-engineering the flow |
| `check-pk.js` | One-shot "is the city still open?" check (rename/adjust the URL inside for other cities) |
| `sweep.js` | One-shot availability sweep across 12 nearby countries |
| `uz.js` | One-shot scraper example for a new country's fees/dates (Uzbekistan here) |
| `proxyauth.js` | Local HTTP relay (port 3128) that injects proxy auth for Brave (started automatically) |

## Racer options

```
node racer.js                          # live, Lahore, default creds.json (direct internet)
node racer.js --dry                    # everything except the final ORDER click
node racer.js --city="Bangkok"         # any city substring of the exam list
node racer.js --date=19.09             # only book rows whose date contains this
node racer.js --url=<exam page>        # any country's Goethe B1 page
node racer.js --tz=6                   # UTC offset the page's advertised times are in
node racer.js --creds=creds-main.json
node racer.js --fast | --calm=0        # switch back to aggressive mode (calm is the default)
node racer.js --lead=99999             # force TURBO right now (testing)
node racer.js --prehammer              # experimental: fire proto-booking URLs seconds before opening
node racer.js --port=9222 --profile=... # custom CDP port / Brave profile (normal usage: leave defaults)
```

<details>
<summary><b>Running a second racer for a friend on the same machine</b></summary>

```bash
node racer.js --port=9223 --profile=brave-profile-friend \
  --proxy=proxy-friend.json --relay=3129 --creds=creds-friend.json --city=<their city> ...
```
Restarts a fully independent browser, proxy exit and relay. Only one racer per account at a time (a second login kills the session).

</details>

## Watcher options

```
node watcher.js --city=<city>           # filter watched rows (substring)
node watcher.js --city=any              # any location
node watcher.js --interval=30           # poll period in seconds (default 30)
node watcher.js --nolaunch              # alarm only, never auto-start the racer
node watcher.js --url=<exam page>       # country page to watch (default: PK B1 page)
node watcher.js --port=9224 --profile=watcher-profile
node watcher.js --tag=w1 --logfile=watcher-1
node watcher.js --racer-args="--port=9223 --profile=brave-profile-friend --relay=3129"
                                        # verbatim extra flags handed to the spawned racer
```

## Safety rails

- **`--dry`** stops at the review page and cleans up (clicks ✕ → CANCEL BOOKING) so no half-booking lingers.
- Leftover unconfirmed bookings on the account are detected and **discarded automatically** instead of blocking the flow.
- Never clicks **BOOK FOR MY CHILD** — only **BOOK FOR MYSELF**.
- Race-lost wording ("slot full", "keine Plätze", "max participants", …) is detected mid-chain and it instantly returns to seat-hunting instead of wasting the session.
- Stuck pages (needing manual form input) raise a loud alarm and open the page in Brave for a human instead of guessing.
- Crashed tabs / dead browsers are restarted automatically mid-race; failed polls back off exponentially instead of hammering. Calm mode exists because of a measured lesson: at one mass opening, the aggressive mode got the exit IP 429-blocked 11 s after the flip — and the IP sat blind for ~28 minutes while the seats drained.
- 429 blocks are answered by **backing off**, never hammering — the block either clears or calm mode prevents them.

## Setup notes

- The bot needs **Windows** as-is (`[console]::beep` alarms, `taskkill` recovery, Brave paths). On Linux/macOS, swap PowerShell beeps for e.g. `paplay`/`afplay`, `taskkill` for `pkill`, and the Brave path constant in the scripts.
- The bot drives a **real Brave browser** over the Chrome DevTools Protocol (`--remote-debugging-port`, default 9222). Don't close the Brave window it opens while a race is on.
- Logs: `racer.log` / `watcher.log` are human-readable; the `-events.jsonl` files record **every poll/fetch/flip/login** with millisecond timestamps for post-race debugging — diff two runs side by side after a loss.
- For countries outside the pre-mapped institute IDs in `racer.js` (`pk/ae/bd/om`), the fallback URLs just need extending — the primary discovery path (reading the API URL off the page itself) works for every country already.
- Stack: plain Node.js + Playwright (headless-eyes-free CDP driving) + a raw `http`/`net` relay — no frameworks, no ML. PRs with new-country scout reports welcome.

## Legal & ethics notice

This tool automates interaction with goethe.de, whose systems may not welcome
that. It was built on the author's own accounts, for the author's own exam —
to beat the "the seat was gone in 40 seconds" problem, not to outbid humans at
scale. Use it for **your own seat**, one race at a time, at sane polling rates
(the code's conservative defaults). Check the ToS of whatever service you
automate and the clock on your exam opening — and please don't run 50 of these.

## License

ISC — see `package.json`.
