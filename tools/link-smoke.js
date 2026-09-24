#!/usr/bin/env node
/**
 * Smoke test for the real transport, against a real desk.
 *
 *   npm run build && ELIOT_TRACE=1 node tools/link-smoke.js <MAC>
 *
 * Connects through DeskLink, asks the four read-only questions and prints what
 * comes back. Nothing here moves the desk. `ELIOT_TRACE=1` adds every frame
 * in both directions; without it DeskLink keeps them to itself.
 */
import { DeskLink } from '../dist/eliot/link.js';
import { Cmd, Report, readHeight } from '../dist/eliot/protocol.js';

const MAC = (process.argv[2] || '').toUpperCase();
if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC)) {
  console.error('Usage: node tools/link-smoke.js <MAC>');
  process.exit(1);
}

const stamp = () => new Date().toISOString().slice(11, 23);
const log = {
  debug: (m) => console.log(`${stamp()} debug ${m}`),
  info: (m) => console.log(`${stamp()} info  ${m}`),
  warn: (m) => console.log(`${stamp()} warn  ${m}`),
  error: (m) => console.log(`${stamp()} error ${m}`),
};

const NAMES = {
  [Report.HEIGHT]: 'height',
  [Report.RANGE]: 'physical range',
  [Report.UNITS]: 'units',
  [Report.LIMIT_FLAGS]: 'limit flags',
  [Report.LIMIT_MAX]: 'soft max',
  [Report.LIMIT_MIN]: 'soft min',
  [Report.POSITION_1]: 'memory 1',
  [Report.POSITION_2]: 'memory 2',
  [Report.POSITION_3]: 'memory 3',
  [Report.POSITION_4]: 'memory 4',
};

function describe(frame) {
  const name = NAMES[frame.command] ?? `0x${frame.command.toString(16).padStart(2, '0')}`;
  const hex = frame.params.toString('hex');
  if (frame.command === Report.RANGE && frame.params.length >= 4) {
    return `${name}: ${readHeight(frame.params, 0)}-${readHeight(frame.params, 2)} mm`;
  }
  if (frame.params.length >= 2 && frame.command !== Report.LIMIT_FLAGS) {
    return `${name}: ${readHeight(frame.params)} mm  [${hex}]`;
  }
  return `${name}: [${hex}]`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `start()` resolves after the first connect attempt, successful or not — the
 * retry runs in the background. A tool that checks `connected` straight after
 * therefore reports failure whenever the first attempt misses, which it often
 * does when the dongle has just been released by something else.
 */
const waitConnected = (l, ms) =>
  l.connected
    ? Promise.resolve()
    : new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        l.once('connected', () => { clearTimeout(timer); resolve(); });
      });


const link = new DeskLink(MAC, log);
let frames = 0;
link.on('frame', (frame) => {
  frames += 1;
  console.log(`${stamp()} <-    ${describe(frame)}`);
});

await link.start();
await waitConnected(link, 60_000);

if (!link.connected) {
  console.error('\nNever connected. Is the Eliot app holding the dongle?');
  await link.close();
  process.exit(1);
}

for (const [label, command] of [
  ['WAKE', Cmd.WAKE],
  ['SETTINGS', Cmd.SETTINGS],
  ['RANGE', Cmd.RANGE],
  ['LIMITS', Cmd.LIMITS],
]) {
  console.log(`${stamp()} ->    ${label}`);
  await link.send(command);
  await sleep(1200);
}

console.log(`\n${frames} frames decoded through DeskLink.`);
await link.close();
process.exit(0);
