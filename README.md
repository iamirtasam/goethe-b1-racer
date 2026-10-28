# Goethe B1 Racer - Lahore

Grabs the B1 seat at **Lahore** the second registration opens on
**04.09.2026 at 11:12 (PKT)**, and drives the whole booking to the end:
entry -> modules -> BOOK FOR MYSELF -> login -> payment method ->
ORDER, SUBJECT TO CHARGE.

Because Pakistan pays by **invoice** (not card), that last click *completes the
registration*. You pay the invoice afterwards.

Run it on the **AWS Frankfurt RDP** (Brave goes through the German residential
proxy automatically - the RDP's own IP is blocked by the site).

## Race schedule

- **Wed 02.09.2026, 13:00 PKT (Tunis)** - live rehearsal (test account):

  ```
  node racer.js --url="https://www.goethe.de/ins/tn/de/spr/prf/gzb1.cfm" --city="Tunis" --tz=1 --creds=creds-test.json
  ```

- **Wed 02.09.2026, 21:00 PKT (Cebu City)** - live rehearsal incl. the
  Philippines invoice payment page (test account):

  ```
  node racer.js --url="https://www.goethe.de/ins/ph/en/spr/prf/gzb1.cfm" --city="Cebu City" --tz=8 --creds=creds-test.json
  ```

  Start each ~15 min early. After each run, save `racer.log` and
  `race-events.jsonl` for autopsy before Friday.

- **Fri 04.09.2026, 11:12 PKT** - the real run (main account):

  ```
  node racer.js --creds=creds-main.json
  ```

  Or double-click `start-bot.bat`. Start it ~30 min early.

## How it wins

- Polls the exam-finder **JSON API** from inside a parked tab (no page
  reloading, no caching) with the exact XHR headers the site demands.
- Auto-arms **TURBO** 180s before the row's own advertised opening, and
  **ULTRA** (0.12s polling) for the last 60s.
- The instant the booking token (`oid`) appears in the API, fires the entry
  request; the login runs in parallel in a second tab and is submitted as a
  real navigation, so the tab lands directly on the page after the login
  wall (no re-fetch).
- Typical timings on the RDP: flip detected < 0.4s, entry ~1.5s,
  ORDER ready ~13-14s (was ~18s before the navigation login).

## Files

| File | What it is |
|---|---|
| `racer.js` | the racer |
| `start-bot.bat` | double-click launcher for the Lahore run |
| `proxyauth.js` | local relay that adds proxy auth for Brave |
| `proxy.json` | German residential proxy credentials |
| `creds-main.json` / `creds-test.json` | main / test Mein Goethe.de accounts |
| `speedtest.js` | latency check (seat API / booking step / login) |
| `recorder.js` | records a manual booking flow to recorder.json |
| `racer.log` | readable log of every run |
| `race-events.jsonl` | forensic log: every request with millisecond timestamps |

## Options

```
node racer.js                      # live, Lahore, default creds.json
node racer.js --dry                # everything except the final ORDER click
node racer.js --city="Bangladesh"  # different location
node racer.js --date=19.09         # only book a row whose date contains this
node racer.js --url=<exam page>    # different exam page
node racer.js --tz=6               # advertised times are in UTC+6 (Bangladesh)
node racer.js --creds=creds-main.json
node racer.js --prehammer          # experimental: hammer prod-URLs just before the opening
```

## Safety rails built in

- `--dry` stops at the review page and **cancels the half-made booking**
  (clicks X, then CANCEL BOOKING) so the account stays clean.
- Discards a leftover unconfirmed booking automatically if one blocks the flow.
- Never clicks "BOOK FOR MY CHILD" - only "BOOK FOR MYSELF".
- Stuck detection: if a page refuses to advance, it alarms and opens the page
  in Brave for a human instead of clicking blindly.
- Auto-recovery: crashed tabs and dead browsers are restarted mid-race.

## Notes

- The racer drives **real Brave** on a separate profile (`brave-profile/`).
  Plain automated Chromium gets blocked by the site's bot protection.
- The proxy has ~1 GB of data; the racer uses ~15-20 MB per run hour. Avoid
  manual browsing through it.
- After every run, grab `racer.log` and `race-events.jsonl` - they record
  every request with millisecond timestamps for post-race analysis.
