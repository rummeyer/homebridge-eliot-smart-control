#!/usr/bin/env node
/**
 * Does VELOCITY (0x13) change anything when the *handset* drives?
 * THIS MOVES THE DESK.
 *
 *   npm run build && node tools/velocity-steps-test.js <MAC>
 *
 * tools/velocity-test.js and tools/eco-test.js both measured VELOCITY and
 * LOW_POWER over GOTO_HEIGHT, where the control box runs its own ramp, and
 * found no difference. Two things have since changed what that result means.
 *
 * First, CONNECT (0xFE) turned out to be a read command: the box answers it
 * with its whole settings block, so settings-write-test.js could confirm that
 * a bare VELOCITY write really is stored. The earlier runs were not writing
 * into the void. The control box's own ramp simply ignores the setting.
 *
 * Second, that same read showed the rig sitting at VELOCITY 21 with LOW_POWER
 * on — below the 28..40 the app offers. So the untested question is not "does
 * velocity do anything" but "does it do anything once eco is out of the way",
 * and the two have to be varied together:
 *
 *   - every climb here is driven by repeated RAISE, which is what the app's
 *     speed slider is for, rather than by GOTO_HEIGHT;
 *   - each run sets eco and velocity as a pair and reads the settings back
 *     before moving, so a run can never be scored on a setting the box did
 *     not take.
 *
 * Method, unchanged from the earlier tools because that is the point: same
 * direction, same distance, and only the middle 60% of the climb is timed, so
 * neither ramp can flatter one setting over another. Descent is by
 * GOTO_HEIGHT — it is only there to reset the rig.
 *
 * Brakes: the desk stops when the pulses stop, so dying is safe. On top of
 * that a wall clock per run and a height ceiling that ends the climb.
 */
import { DeskLink } from '../dist/eliot/link.js';
import { Cmd, Report, heightParams, readHeight } from '../dist/eliot/protocol.js';

const MAC = (process.argv[2] || '').toUpperCase();
if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(MAC)) {
  console.error('usage: node tools/velocity-steps-test.js <MAC>');
  process.exit(1);
}

/** The same 220 mm the earlier runs used, so the numbers can be compared. */
const LOW = 780;
const HIGH = 1000;
/** Stop pulsing this far below HIGH; the desk coasts ~17 mm going up. */
const APPROACH_MM = 20;
/** The handset's own cadence. */
const PULSE_MS = 500;
/** No climb can legitimately take this long: 220 mm at 22 mm/s is 10 s. */
const CLIMB_LIMIT_MS = 45_000;

const t0 = Date.now();
const say = (m) => console.log(`${String((Date.now() - t0) / 1000).padStart(7)}s ${m}`);
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: (m) => say(`ERR ${m}`) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let height = null;
const link = new DeskLink(MAC, log);
link.on('frame', (f) => {
  if (f.command === Report.HEIGHT) height = readHeight(f.params);
});

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

await link.send(Cmd.WAKE);
await sleep(700);
await link.send(Cmd.SETTINGS);
await sleep(1200);

/**
 * Wait until the link is up again.
 *
 * Homebridge restarts the plugin's child bridge within seconds of it being
 * killed, and it wants the same single connection this does. Losing the dongle
 * mid-run is therefore normal rather than exceptional: DeskLink reconnects on
 * its own. A climb that loses the link simply stops being pulsed, and the desk
 * stops with it — which is the behaviour we want anyway.
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

/** Send, and report a lost link as false rather than throwing. */
async function tell(command, params = []) {
  if (!(await ready())) return false;
  try {
    await link.send(command, params);
    return true;
  } catch (err) {
    say(`    (senden fehlgeschlagen: ${err.message})`);
    return false;
  }
}

/** Wait until the height has not changed for `stillMs`. */
async function settle(stillMs) {
  let still = 0;
  let prev = height;
  while (still < stillMs) {
    await sleep(200);
    if (height !== prev) {
      prev = height;
      still = 0;
    } else {
      still += 200;
    }
  }
}

/**
 * Ask for the settings block, which is what CONNECT answers with.
 *
 * Returns a map of field code to value. Height reports and the CONNECT echo
 * carry nothing useful and are dropped.
 */
async function readSettings() {
  const got = new Map();
  const on = (f) => {
    if (f.command === Report.HEIGHT || f.command === Cmd.CONNECT) return;
    if (f.params.length === 1) got.set(f.command, f.params[0]);
  };
  link.on('frame', on);
  await tell(Cmd.CONNECT);
  await sleep(1500);
  link.off('frame', on);
  return got;
}

/**
 * Put the box on a given eco/velocity pair, and confirm it took both.
 *
 * Returns the values actually read back, so the caller can label a run with
 * what the desk was really set to rather than what it was asked for.
 */
async function apply(lowPower, velocity) {
  await tell(Cmd.LOW_POWER, [lowPower]);
  await sleep(300);
  await tell(Cmd.VELOCITY, [velocity]);
  await sleep(1200);

  const now = await readSettings();
  return { lowPower: now.get(0x18), velocity: now.get(0x13) };
}

/**
 * Climb from LOW to HIGH on repeated RAISE, and report cruise speed.
 *
 * Returns null if the desk never got moving, which is a result too — it means
 * the step path itself is broken, not that the setting did nothing.
 */
async function climb() {
  const samples = [];
  const on = (f) => {
    if (f.command === Report.HEIGHT) samples.push([Date.now(), readHeight(f.params)]);
  };
  link.on('frame', on);

  const deadline = Date.now() + CLIMB_LIMIT_MS;
  let lost = false;
  while (Date.now() < deadline && (height === null || height < HIGH - APPROACH_MM)) {
    // A failed pulse ends the climb rather than pausing it: after a reconnect
    // the desk has already coasted to a stop, so what follows is a second,
    // shorter climb whose cruise phase would be measured as if it were one.
    if (!link.connected || !(await tell(Cmd.RAISE))) {
      lost = true;
      break;
    }
    await sleep(PULSE_MS);
  }
  link.off('frame', on);
  const stoppedAt = height;
  await settle(1500);

  // Three different failures look alike from here and must not be averaged
  // into one reassuring number. A desk that reports nothing has lost its
  // position — after a reset it streams 0x04 in place of the height, and no
  // command will move it. A desk that reports and stays put is blocked, by the
  // child lock or a limit. Only the third case is a measurement.
  const heights = samples.map(([, h]) => h);
  if (heights.length === 0) {
    return { speed: null, stoppedAt, coast: null, lost, silent: true };
  }
  const travelled = Math.max(...heights) - Math.min(...heights);
  if (travelled < 20) {
    return { speed: null, stoppedAt, coast: height - stoppedAt, lost, stuck: true };
  }

  // Middle 60% only: that is cruise, without either ramp.
  const moving = samples.filter(([, h]) => h > LOW + 10 && h < HIGH - APPROACH_MM - 10);
  if (lost || moving.length < 6) {
    return { speed: null, stoppedAt, coast: height - stoppedAt, lost };
  }
  const a = moving[Math.floor(moving.length * 0.2)];
  const b = moving[Math.floor(moving.length * 0.8)];
  const secs = (b[0] - a[0]) / 1000;
  return {
    speed: secs > 0 ? Math.abs(b[1] - a[1]) / secs : null,
    stoppedAt,
    coast: height - stoppedAt,
    lost,
  };
}

/**
 * The four corners of eco x velocity, plus a repeat of the one that matters.
 *
 * Grouping by eco would let a drift in the rig masquerade as an eco effect, so
 * the pairs alternate; the repeat at the end is the drift check. Velocity 21 is
 * what the desk was found on, 40 the fastest the app offers.
 */
const CONDITIONS = [
  { lowPower: 1, velocity: 21 },
  { lowPower: 0, velocity: 40 },
  { lowPower: 1, velocity: 40 },
  { lowPower: 0, velocity: 21 },
  { lowPower: 0, velocity: 40 },
];

const found = await readSettings();
const wasLowPower = found.get(0x18);
const wasVelocity = found.get(0x13);
say(`start ${height} mm, vorgefunden: LOW_POWER ${wasLowPower}, VELOCITY ${wasVelocity}`);
say(`${CONDITIONS.length} laeufe a ${HIGH - LOW} mm`);

const results = [];
for (const { lowPower, velocity } of CONDITIONS) {
  const label = `eco ${lowPower ? 'an ' : 'aus'}, VELOCITY ${String(velocity).padStart(2)}`;
  if (!(await tell(Cmd.GOTO_HEIGHT, heightParams(LOW)))) {
    say(`${label}  uebersprungen, keine verbindung`);
    continue;
  }
  await settle(2000);

  const got = await apply(lowPower, velocity);
  if (got.lowPower !== lowPower || got.velocity !== velocity) {
    say(
      `${label}  uebersprungen: box steht auf LOW_POWER ${got.lowPower}, VELOCITY ${got.velocity}`,
    );
    continue;
  }

  const { speed, stoppedAt, coast, lost, stuck, silent } = await climb();
  if (silent) {
    say(`${label}  ABBRUCH: keine hoehenmeldungen — die box kennt ihre position nicht`);
    break;
  }
  if (stuck) {
    say(`${label}  ABBRUCH: gemeldet, aber nicht bewegt (kindersicherung? limit?)`);
    break;
  }
  if (!lost && speed != null) results.push({ lowPower, velocity, speed });
  say(
    `${label}  ${speed != null ? speed.toFixed(1).padStart(5) : '    ?'} mm/s` +
      `  (pulse-ende ${stoppedAt} mm, nachlauf ${coast} mm)` +
      (lost ? '  VERWORFEN: verbindung waehrend der fahrt verloren' : ''),
  );
}

// Leave the desk as it was found, not on whatever ran last.
await apply(wasLowPower, wasVelocity);
say(`zurueckgesetzt auf LOW_POWER ${wasLowPower}, VELOCITY ${wasVelocity}`);

const measured = results.filter((r) => r.speed !== null);
if (measured.length >= 2) {
  const speeds = measured.map((r) => r.speed);
  const spread = Math.max(...speeds) - Math.min(...speeds);
  say('');
  say(`spanne ueber alle laeufe: ${spread.toFixed(1)} mm/s`);
  if (spread < 1) {
    say('kein unterschied — weder eco noch velocity, auch ueber step-kommandos nicht.');
  } else {
    // Which of the two varies with speed is the whole question, so say it
    // rather than leaving it to be eyeballed off the rows above.
    const mean = (rs) => rs.reduce((s, r) => s + r.speed, 0) / rs.length;
    const byEco = [0, 1].map((v) => measured.filter((r) => r.lowPower === v));
    const byVel = [21, 40].map((v) => measured.filter((r) => r.velocity === v));
    if (byEco.every((g) => g.length)) {
      say(`eco aus ${mean(byEco[0]).toFixed(1)} mm/s gegen eco an ${mean(byEco[1]).toFixed(1)}`);
    }
    if (byVel.every((g) => g.length)) {
      say(`VELOCITY 21 ${mean(byVel[0]).toFixed(1)} mm/s gegen 40 ${mean(byVel[1]).toFixed(1)}`);
    }
  }
}

await link.close();
process.exit(0);
