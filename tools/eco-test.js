#!/usr/bin/env node
/**
 * Does LOW_POWER (0x18) change the travel speed? THIS MOVES THE DESK.
 *
 * If it does, the setting can be read back by timing a move — which matters,
 * because the control box will not report it on this connection.
 *
 * Same direction, same distance, three times over, so the ramp cannot
 * flatter one setting over another.
 */
import { DeskLink } from '../dist/eliot/link.js';
import { Cmd, Report, heightParams, readHeight } from '../dist/eliot/protocol.js';

const MAC = (process.argv[2] || '').toUpperCase();
const LOW = 780, HIGH = 1000;

const t0 = Date.now();
const say = (m) => console.log(`${String((Date.now() - t0) / 1000).padStart(6)}s ${m}`);
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: (m) => say(`ERR ${m}`) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let height = null;
const link = new DeskLink(MAC, log);
link.on('frame', (f) => { if (f.command === Report.HEIGHT) height = readHeight(f.params); });

await link.start();
await (link.connected ? Promise.resolve() : new Promise((res) => {
  const t = setTimeout(res, 60000); link.once('connected', () => { clearTimeout(t); res(); });
}));
if (!link.connected) { console.error('nicht verbunden'); process.exit(1); }

await link.send(Cmd.WAKE); await sleep(700);
await link.send(Cmd.SETTINGS); await sleep(1200);

async function driveTo(target) {
  const samples = [];
  const on = (f) => { if (f.command === Report.HEIGHT) samples.push([Date.now(), readHeight(f.params)]); };
  link.on('frame', on);
  await link.send(Cmd.GOTO_HEIGHT, heightParams(target));
  let still = 0, prev = height;
  while (still < 2500) {
    await sleep(200);
    if (height !== prev) { prev = height; still = 0; } else still += 200;
  }
  link.off('frame', on);
  // Middle 60% only: that is cruise, without either ramp.
  const moving = samples.filter(([, h]) => Math.abs(h - target) > 4);
  if (moving.length < 6) return null;
  const a = moving[Math.floor(moving.length * 0.2)];
  const b = moving[Math.floor(moving.length * 0.8)];
  const secs = (b[0] - a[0]) / 1000;
  return secs > 0 ? Math.abs(b[1] - a[1]) / secs : null;
}

say(`start ${height} mm`);
for (const value of [0, 1, 0]) {
  await link.send(Cmd.GOTO_HEIGHT, heightParams(LOW));
  let still = 0, prev = height;
  while (still < 2000) { await sleep(200); if (height !== prev) { prev = height; still = 0; } else still += 200; }

  await link.send(Cmd.LOW_POWER, [value]);
  await sleep(1500);
  const speed = await driveTo(HIGH);
  say(`LOW_POWER ${value} (${value ? 'eco an' : 'eco aus'}): marschgeschwindigkeit ${speed ? speed.toFixed(1) : '?'} mm/s`);
}

await link.close();
process.exit(0);
