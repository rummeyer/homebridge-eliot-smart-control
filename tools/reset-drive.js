#!/usr/bin/env node
/**
 * Drive the desk to its bottom so the control box finds its zero again.
 * THIS MOVES THE DESK, ALL THE WAY DOWN.
 *
 *   npm run build && node tools/reset-drive.js <MAC>
 *
 * This is the app's *Automatischer Reset*, without the app. That function is
 * not a protocol command — its own warning says what it does: *"Der Tisch wird
 * selbstständig auf eine Höhe von ca. 64 cm fahren"*, 64 cm being this desk's
 * physical minimum of 642 mm. It drives to the bottom until the box runs out
 * of travel, and that is where the zero comes from. Repeated `LOWER` reaches
 * the same stop. `0x91 CALIBRATE` from the Jarvis notes is not sent: it appears
 * nowhere in the Eliot app, nothing here has ever seen it answered, and the
 * bottom stop is what does the work in either case.
 *
 * Why it is worth having: a box that has lost its zero streams `0x04` where the
 * height belongs and will not take a position command, so every tool here is
 * blind until it is reset. The alternative was the phone.
 *
 * Driving down is the safe direction — the desk ends at its own stop rather
 * than against one — but it is still the direction where things get trapped
 * underneath. Clear the desk's path first. `LOWER` moves the desk only while
 * the pulses keep coming, so killing this stops it inside a second, and there
 * is a wall clock besides.
 *
 * It stops on its own when the box starts reporting a height again and that
 * height stops changing, which is the bottom: that is exactly the signal that
 * the reset worked.
 */
import { DeskLink } from '../dist/eliot/link.js';
import { Cmd, Report, readHeight } from '../dist/eliot/protocol.js';

const MAC = (process.argv[2] || '').toUpperCase();
if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC)) {
  console.error('usage: node tools/reset-drive.js <MAC>');
  process.exit(1);
}

/** The handset's own cadence; the box coasts to a stop ~3 s after the last one. */
const PULSE_MS = 500;
/** The box does not stream its height — every one here comes from a poll. */
const POLL_MS = 400;
/**
 * Full travel is 1280 → 642 mm, about 29 s at the 22 mm/s every run has
 * measured. This is generous enough for a slower desk and far short of the
 * time it would take to do any harm by pushing against the bottom stop, which
 * the box handles by itself anyway.
 */
const DRIVE_LIMIT_MS = 90_000;
/** Height unchanged this long, once it is being reported at all, is the floor. */
const STILL_MS = 5_000;

const t0 = Date.now();
const say = (m) => console.log(`${String((Date.now() - t0) / 1000).padStart(7)}s ${m}`);
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: (m) => say(`ERR ${m}`) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let height = null;
let heightFrames = 0;
let blindFrames = 0;

const link = new DeskLink(MAC, log);
link.on('frame', (f) => {
  if (f.command === Report.HEIGHT) {
    height = readHeight(f.params);
    heightFrames += 1;
  } else if (f.command === 0x04) {
    // What the box sends in place of a height once it has lost its zero.
    blindFrames += 1;
  }
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

async function tell(command, params = []) {
  if (!link.connected) return false;
  try {
    await link.send(command, params);
    return true;
  } catch (err) {
    say(`    (senden fehlgeschlagen: ${err.message})`);
    return false;
  }
}

await tell(Cmd.WAKE);
await sleep(700);
await tell(Cmd.SETTINGS);
await sleep(1200);

const poller = setInterval(() => {
  void tell(Cmd.SETTINGS);
}, POLL_MS);

say(
  `start: hoehe ${height === null ? 'unbekannt' : `${height} mm`}` +
    `  (${heightFrames} hoehen-frames, ${blindFrames}x 0x04)`,
);
say('fahre nach unten bis zum anschlag — abbruch mit ctrl-c haelt sofort an');

const deadline = Date.now() + DRIVE_LIMIT_MS;
let lastHeight = height;
let lastChange = Date.now();
let reason = 'zeitlimit';

while (Date.now() < deadline) {
  if (!(await tell(Cmd.LOWER))) {
    reason = 'verbindung verloren';
    break;
  }
  await sleep(PULSE_MS);

  if (height !== lastHeight) {
    lastHeight = height;
    lastChange = Date.now();
  }

  // Only once the box is reporting at all does a still height mean the floor;
  // before that, "unchanged" is just the silence of a box without a zero.
  if (height !== null && Date.now() - lastChange > STILL_MS) {
    reason = 'unten angekommen';
    break;
  }

  const secs = Math.round((Date.now() - t0) / 1000);
  if (secs % 5 === 0) {
    say(`  ${height === null ? 'hoehe unbekannt' : `${height} mm`}  (${blindFrames}x 0x04)`);
  }
}

say(`stop: ${reason}`);

// Let it coast, then ask again from a standstill.
await sleep(3500);
const framesBefore = heightFrames;
const blindBefore = blindFrames;
await tell(Cmd.WAKE);
await sleep(700);
await tell(Cmd.SETTINGS);
await sleep(1500);
clearInterval(poller);

say('');
say('=== danach ===');
say(`hoehe: ${height === null ? 'immer noch unbekannt' : `${height} mm`}`);
say(`hoehen-frames seit dem halt: ${heightFrames - framesBefore}`);
say(`0x04 seit dem halt: ${blindFrames - blindBefore}`);
say('');
if (height !== null && heightFrames > framesBefore) {
  say('die box meldet wieder eine hoehe — der reset hat gegriffen.');
} else {
  say('die box meldet weiterhin keine hoehe. der anschlag allein hat nicht gereicht;');
  say('dann bleibt nur der reset ueber app oder handset.');
}

await link.close();
process.exit(0);
