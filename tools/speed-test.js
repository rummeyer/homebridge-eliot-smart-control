#!/usr/bin/env node
/**
 * Measure travel speed with one GOTO_HEIGHT. THIS MOVES THE DESK.
 *
 *   npm run build && node tools/speed-test.js <MAC> [--up=220]
 *
 * Reads the settings block once at rest, drives `--up` mm upwards and reports
 * the speed over the middle of the move, where the box's ramp is done.
 *
 * Nothing is polled while the desk moves. `SETTINGS` (`0x07`) is a command and
 * cancels a move in progress; the box reports its height on its own while
 * driving, which is all this needs.
 *
 * Meant to be run right after `set-setting.js --code=0x13 --value=N --reset`
 * and a reset at the handset, which leaves the desk at its soft minimum — so
 * every run starts in the same place and goes the same way.
 */
import { DeskLink } from '../dist/eliot/link.js';
import { Cmd, Report, heightParams, readHeight } from '../dist/eliot/protocol.js';

const MAC = (process.argv[2] || '').toUpperCase();
const args = process.argv.slice(3);
const arg = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const UP = Number(arg('up') ?? 220);

if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC) || !(UP > 50 && UP <= 500)) {
  console.error('usage: node tools/speed-test.js <MAC> [--up=220]');
  process.exit(1);
}

/** The desk's physical top; nothing here drives closer than this. */
const TOP_MM = 1280;
/** A move that has not finished in this long is stopped. */
const WALL_MS = 40_000;
/** No height change for this long counts as arrived. */
const SETTLE_MS = 3000;

const t0 = Date.now();
const say = (m) => console.log(`${String((Date.now() - t0) / 1000).padStart(7)}s ${m}`);
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: (m) => say(`ERR ${m}`) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let height = null;
/** [ms, mm] for every height report during the move. */
const trace = [];
let recording = false;

const link = new DeskLink(MAC, log);
link.on('frame', (f) => {
  if (f.command !== Report.HEIGHT) return;
  height = readHeight(f.params);
  if (recording) trace.push([Date.now(), height]);
});

await link.start();
if (!link.connected) {
  await new Promise((res) => {
    const t = setTimeout(res, 60_000);
    link.once('connected', () => {
      clearTimeout(t);
      res();
    });
  });
}
if (!link.connected) {
  console.error('nicht verbunden — ist das plugin wirklich deaktiviert?');
  process.exit(1);
}

const stop = async () => {
  await link.send(Cmd.STOP).catch(() => {});
};
process.on('SIGINT', async () => {
  say('abbruch — STOP');
  await stop();
  await link.close();
  process.exit(130);
});

await link.send(Cmd.WAKE);
await sleep(700);
await link.send(Cmd.SETTINGS);
await sleep(1200);

// The settings block, once, at rest: which velocity the box has *stored*.
const settings = new Map();
const onSetting = (f) => {
  if (f.params.length === 1) settings.set(f.command, f.params[0]);
};
link.on('frame', onSetting);
await link.send(Cmd.CONNECT);
await sleep(1500);
link.off('frame', onSetting);

if (height === null) {
  console.error('keine hoehe — hat die box ihre null verloren?');
  await link.close();
  process.exit(1);
}

const start = height;
const target = Math.min(start + UP, TOP_MM - 30);
say(`gespeichert: velocity ${settings.get(0x13)}, low power ${settings.get(0x18)}`);
say(`start ${start} mm, ziel ${target} mm`);

recording = true;
trace.push([Date.now(), start]);
await link.send(Cmd.GOTO_HEIGHT, heightParams(target));

const until = Date.now() + WALL_MS;
while (Date.now() < until) {
  await sleep(200);
  const last = trace[trace.length - 1];
  if (trace.length > 1 && Date.now() - last[0] > SETTLE_MS) break;
}
recording = false;
if (Date.now() >= until) {
  say('wanduhr abgelaufen — STOP');
  await stop();
}

const end = trace[trace.length - 1][1];
say(`ende ${end} mm (${end - target >= 0 ? '+' : ''}${end - target} zum ziel), ${trace.length} meldungen`);

// Middle 60 % of the distance actually travelled: the ramp at either end out.
const lo = start + (end - start) * 0.2;
const hi = start + (end - start) * 0.8;
const a = trace.find(([, mm]) => mm >= lo);
const b = [...trace].reverse().find(([, mm]) => mm <= hi);
if (a && b && b[0] > a[0]) {
  const speed = (b[1] - a[1]) / ((b[0] - a[0]) / 1000);
  say(`speed ${speed.toFixed(1)} mm/s  (${a[1]}→${b[1]} mm in ${((b[0] - a[0]) / 1000).toFixed(2)} s)`);
} else {
  say('zu wenig meldungen fuer eine geschwindigkeit');
}
// Up to the first report of the final height: the box keeps reporting it for
// a while after it stops, and those reports are not travel.
const arrived = trace.find(([, mm]) => mm === end)[0];
const whole = (end - start) / ((arrived - trace[0][0]) / 1000);
say(`gesamt inkl. rampe ${whole.toFixed(1)} mm/s`);

await link.close();
process.exit(0);
