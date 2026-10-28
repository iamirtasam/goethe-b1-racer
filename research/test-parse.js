// research/test-parse.js - offline validation of the ACTUAL parseRows /
// parseOpenAt code in racer.js against v2 + v3 row fixtures.
// No network, no booking - pure logic test.
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(pathOf('racer.js'), 'utf8');
const grab = (name) => {
  const at = src.indexOf('function ' + name);
  if (at < 0) throw new Error(name + ' not found');
  let depth = 0, i = src.indexOf('{', at);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.substring(at, j + 1); }
  }
};
function pathOf(f) { return require('path').join(__dirname, '..', f); }

const CONFIG = { TZ_OFFSET_HOURS: 5 };
const ctx = vm.createContext({ CONFIG, encodeURIComponent });
vm.runInContext(grab('parseRows') + '\n' + grab('parseOpenAt') + '\n'
  + '({ parseRows, parseOpenAt })', ctx);
const { parseRows, parseOpenAt } = ctx.exports || ctx;
// vm.runInContext returns the completion value - re-grab:
const api = vm.runInContext(grab('parseRows') + '\n' + grab('parseOpenAt') + '\n'
  + '({ parseRows: parseRows, parseOpenAt: parseOpenAt })', ctx);

let fails = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log('FAIL ' + label + '\n   got:  ' + JSON.stringify(got) + '\n   want: ' + JSON.stringify(want)); }
  else console.log('ok   ' + label);
};

// ---- v3 LOCKED row (Lahore today: bookFrom 30.10.2026 14:17 PKT) ----
const v3locked = {
  locationName: ' Lahore ', eventTimeSpan: '14.11. - 15.11.2026',
  bookFrom: '30.10.2026', bookFromTime: '14:17:00.000',
  bookFromStamp: '2026-10-30T09:17:00.000Z',
  buttonDisabled: 'disabled', buttonLink: '', oid: null, availability: 11,
  encOID: '5B0AC9DF', moduleId: 'SM05004426', acadYear: '2026', acadPeriod: '026',
};
const lr = api.parseRows([v3locked])[0];
check('v3 locked: disabled', lr.disabled, true);
check('v3 locked: no link', lr.link, '');
check('v3 locked: encOID kept', lr.encOID, '5B0AC9DF');
check('v3 locked: openAt = UTC stamp', api.parseOpenAt(lr).toISOString(), '2026-10-30T09:17:00.000Z');

// ---- v3 OPEN row (Dubai 04.11 today: oid present, empty buttonLink) ----
const v3open = {
  locationName: 'Dubai', eventTimeSpan: ' 04.11.2026 ',
  bookFrom: '01.10.2026', bookFromTime: '10:00:00.000',
  bookFromStamp: '2026-10-01T05:00:00.000Z',
  buttonDisabled: '', buttonLink: '', oid: '836fdbd4757be30d70ba867da0969497bb02c717dd62ae5a3b32189aa4185299',
  availability: 1, encOID: '050ACC8C', moduleId: 'SM05002412', acadYear: '2026', acadPeriod: '203',
};
const or = api.parseRows([v3open])[0];
check('v3 open: not disabled', or.disabled, false);
check('v3 open: oid-entry link synthesized', or.link, 'https://www.goethe.de/coe?lang=en&oid=' + encodeURIComponent('836fdbd4757be30d70ba867da0969497bb02c717dd62ae5a3b32189aa4185299'));
check('v3 open: openAt = UTC stamp', api.parseOpenAt(or).toISOString(), '2026-10-01T05:00:00.000Z');

// ---- v2 OPEN row (Sep-era shape: buttonLink prod-form + oid) ----
const v2open = {
  locationName: 'Cebu City', eventTimeSpan: '05.09.2026',
  bookFrom: '03.09.2026', bookFromTime: '00:00:00.000',
  buttonDisabled: '', buttonLink: 'https://www.goethe.de/coe?lang=en&prod=O%2010000259SM05002412',
  oid: '3066678b6a6808e78de301', availability: 1,
  moduleId: 'SM05002412', acadYear: '2026', acadPeriod: '203',
};
const vr = api.parseRows([v2open])[0];
check('v2 open: keeps its own buttonLink', vr.link, 'https://www.goethe.de/coe?lang=en&prod=O%2010000259SM05002412');
check('v2 open: not disabled', vr.disabled, false);
check('v2 open: openAt falls back to text PK math', api.parseOpenAt(vr).toISOString(), '2026-09-02T19:00:00.000Z');

// ---- v2 FULLY BOOKED ----
const v2full = { locationName: 'Islamabad', eventTimeSpan: '12.09.2026', bookFrom: '01.09.2026',
  bookFromTime: '11:12:00.000', buttonDisabled: 'disabled', buttonLink: '', oid: null, availability: 2 };
check('v2 full: disabled', api.parseRows([v2full])[0].disabled, true);

// ---- essential: a target is found on a v3 open row but NOT a locked one ----
const all = api.parseRows([v3locked, v3open, v2full]);
const target = all.find(r => !r.disabled && r.link);
check('target picks the open row', target && target.location, 'Dubai');

console.log(fails ? '\n' + fails + ' FAILURE(S)' : '\nALL PASS');
process.exit(fails ? 1 : 0);
