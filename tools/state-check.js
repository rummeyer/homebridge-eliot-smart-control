#!/usr/bin/env node
/**
 * Why will this desk not move? THIS DOES NOT MOVE THE DESK.
 *
 *   npm run build && node tools/state-check.js <MAC>
 *
 * A control box that accepts every command and stays put looks the same from
 * the outside whether it is locked, fenced in by a soft limit, or simply not
 * listening. This asks it the three questions that tell those apart, and sends
 * nothing that could change anything.
 *
 * LOCK is queried with param 0, which is the read: param 1 would toggle it.
 */
import { DeskLink } from '../dist/eliot/link.js';
import { Cmd, Report, readHeight } from '../dist/eliot/protocol.js';

const MAC = (process.argv[2] || '').toUpperCase();
if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC)) {
  console.error('usage: node tools/state-check.js <MAC>');
  process.exit(1);
}

const t0 = Date.now();
const say = (m) => console.log(`${String((Date.now() - t0) / 1000).padStart(7)}s ${m}`);
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: (m) => say(`ERR ${m}`) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString('hex').replace(/(..)/g, '$1 ').trim();

let height = null;
let heightFrames = 0;
const link = new DeskLink(MAC, log);
link.on('frame', (f) => {
  if (f.command === Report.HEIGHT) {
    height = readHeight(f.params);
    heightFrames += 1;
  }
});

async function ready(ms = 60_000) {
  if (link.connected) return true;
  return new Promise((res) => {
    const t = setTimeout(() => res(false), ms);
    link.once('connected', () => {
      clearTimeout(t);
      res(true);
    });
  });
}

async function ask(label, command, params = [], ms = 1500) {
  const seen = [];
  const on = (f) => {
    if (f.command !== Report.HEIGHT) seen.push(f);
  };
  link.on('frame', on);
  try {
    await link.send(command, params);
  } catch (err) {
    say(`${label}: senden fehlgeschlagen (${err.message})`);
    link.off('frame', on);
    return seen;
  }
  await sleep(ms);
  link.off('frame', on);
  say(`${label}:`);
  if (seen.length === 0) say('    (keine antwort)');
  for (const f of seen) {
    say(
      `    cmd 0x${f.command.toString(16).padStart(2, '0')}  ${hex(f.params)}` +
        (f.params.length === 2 ? `  = ${f.params.readUInt16BE(0)}` : ''),
    );
  }
  return seen;
}

await link.start();
if (!(await ready())) {
  console.error('nicht verbunden — laeuft das Plugin noch?');
  process.exit(1);
}

await ask('WAKE', Cmd.WAKE, [], 800);
say(`hoehe jetzt: ${height} mm (${heightFrames} hoehen-frames bisher)`);

const lock = await ask('LOCK abfrage (1f 01 00)', Cmd.LOCK, [0x00]);
await ask('LIMITS (20)', Cmd.LIMITS);
await ask('RANGE (0c)', Cmd.RANGE);

// Is the desk reporting at all, or is the height frozen because nothing is
// listening? Ten seconds of silence answers that without sending anything —
// and counting every code, not just height, separates a status the box emits
// on its own from a mere acknowledgement of what we sent.
const before = heightFrames;
const tally = new Map();
const count = (f) => tally.set(f.command, (tally.get(f.command) ?? 0) + 1);
link.on('frame', count);
say('zehn sekunden zuhoeren, ohne zu senden…');
await sleep(10_000);
link.off('frame', count);
say(`    ${heightFrames - before} hoehen-frames, hoehe ${height} mm`);
if (tally.size === 0) {
  say('    (der tisch sagt von sich aus gar nichts)');
}
for (const [code, n] of [...tally].sort((a, b) => a[0] - b[0])) {
  say(`    cmd 0x${code.toString(16).padStart(2, '0')}  ${n}x unaufgefordert`);
}

const locked = lock.find((f) => f.command === Report.LOCK)?.params[0];
say('');
say(
  locked === undefined
    ? 'kindersicherung: keine antwort — das allein waere schon verdaechtig.'
    : locked
      ? 'KINDERSICHERUNG IST AN. Das erklaert einen tisch, der jeden befehl annimmt und steht.'
      : 'kindersicherung ist aus; die blockade liegt woanders.',
);

await link.close();
process.exit(0);
