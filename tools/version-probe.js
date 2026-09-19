#!/usr/bin/env node
/**
 * What does VERSION (0x1C) actually answer? THIS DOES NOT MOVE THE DESK.
 *
 *   npm run build && node tools/version-probe.js <MAC>
 *
 * docs/PROTOCOL.md notes that `1C` comes back as an answer to a request but
 * has never been decoded — so the plugin reports a hardcoded model and no
 * firmware revision at all. If the payload turns out to hold a version, it
 * belongs in the accessory's information service.
 *
 * Everything the control box says in the window after each request is dumped
 * raw, because the interesting frame may not be the one that was asked for.
 */
import { DeskLink } from '../dist/eliot/link.js';
import { Cmd, Report } from '../dist/eliot/protocol.js';

const MAC = (process.argv[2] || '').toUpperCase();
if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC)) {
  console.error('usage: node tools/version-probe.js <MAC>');
  process.exit(1);
}

const t0 = Date.now();
const say = (m) => console.log(`${String((Date.now() - t0) / 1000).padStart(7)}s ${m}`);
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: (m) => say(`ERR ${m}`) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hex = (b) => Buffer.from(b).toString('hex').replace(/(..)/g, '$1 ').trim();
/** A payload that is printable ASCII is worth seeing as text. */
const ascii = (b) =>
  Buffer.from(b).every((c) => c >= 0x20 && c < 0x7f) ? ` "${Buffer.from(b).toString('ascii')}"` : '';

const link = new DeskLink(MAC, log);

/**
 * Wait until the link is up again.
 *
 * The plugin's child bridge is restarted by Homebridge within seconds of being
 * killed, and it wants the same single connection this does. Losing the dongle
 * mid-probe is therefore normal rather than exceptional: DeskLink reconnects on
 * its own, so the only thing needed here is the patience to let it.
 */
async function ready(ms = 45_000) {
  if (link.connected) return true;
  say('    (verbindung weg — warte auf reconnect)');
  return new Promise((res) => {
    const t = setTimeout(() => res(false), ms);
    link.once('connected', () => {
      clearTimeout(t);
      res(true);
    });
  });
}

/** Collect every frame for `ms`, ignoring the height chatter. */
async function collect(label, send, ms = 1500) {
  const seen = [];
  const on = (f) => {
    if (f.command !== Report.HEIGHT) seen.push(f);
  };
  link.on('frame', on);
  if (!(await ready())) {
    link.off('frame', on);
    say(`${label}: uebersprungen, keine verbindung`);
    return seen;
  }
  try {
    await send();
    await sleep(ms);
  } catch (err) {
    say(`    (senden fehlgeschlagen: ${err.message})`);
  }
  link.off('frame', on);

  say(`${label}:`);
  if (seen.length === 0) say('    (keine antwort)');
  for (const f of seen) {
    const p = Buffer.from(f.params);
    say(`    cmd 0x${f.command.toString(16).padStart(2, '0')}  ${p.length}B  ${hex(p)}${ascii(p)}`);
  }
  return seen;
}

await link.start();
await (link.connected
  ? Promise.resolve()
  : new Promise((res) => {
      const t = setTimeout(res, 60_000);
      link.once('connected', () => {
        clearTimeout(t);
        res();
      });
    }));
if (!link.connected) {
  console.error('nicht verbunden — laeuft das Plugin noch?');
  process.exit(1);
}

await collect('WAKE', () => link.send(Cmd.WAKE), 800);
await collect('SETTINGS (referenz: was sonst so kommt)', () => link.send(Cmd.SETTINGS));

// The app brackets configuration commands with CONNECT. VERSION is a request
// rather than a setting, but if the bracket matters anywhere it matters here.
const plain = await collect('VERSION 0x1C, blank', () => link.send(Cmd.VERSION));
await collect('VERSION 0x1C, CONNECT-geklammert', async () => {
  await link.send(Cmd.CONNECT);
  await sleep(150);
  await link.send(Cmd.VERSION);
  await sleep(150);
  await link.send(Cmd.CONNECT);
});

// MOTION_MODE and SENSITIVITY are deliberately not probed here. Both take a
// parameter that is a value, not a query — there is no "ask" param the way
// LOCK has one — so any attempt to read them writes them instead. Getting
// MOTION_MODE wrong would cost the plugin GOTO_HEIGHT, which is the one
// command everything else is built on.

say('');
const version = plain.find((f) => f.command === 0x1c);
say(
  version
    ? `0x1C antwortet mit ${version.params.length} byte — siehe oben, das ist der kandidat.`
    : '0x1C hat nicht geantwortet; ohne antwort keine firmware-version.',
);

await link.close();
process.exit(0);
