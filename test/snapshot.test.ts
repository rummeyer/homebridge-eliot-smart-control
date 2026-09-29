import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import type { DeskState } from '../src/eliot/desk.ts';
import { DeskSnapshot, readSnapshot, snapshotPath } from '../src/snapshot.ts';

const MAC = 'E5:02:4F:BF:74:A2';

function fresh(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'eliot-desk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return snapshotPath(dir, MAC);
}

const state = (over: Partial<DeskState> = {}): DeskState => ({
  connected: true,
  ready: true,
  heightMm: 1000,
  minMm: 650,
  maxMm: 1250,
  physicalMinMm: 620,
  physicalMaxMm: 1280,
  position: 58,
  target: 58,
  moving: null,
  locked: false,
  settings: {
    firmware: 10,
    velocity: 40,
    lowPower: false,
    motionMode: 0,
    sensitivity: 1,
    units: 'cm',
  },
  memories: [801, 1204, null, null],
  ...over,
});

test('what the desk reports is written down in the config words', (t) => {
  const path = fresh(t);
  assert.equal(path.endsWith('eliot-desk-E5024FBF74A2.json'), true);
  const snapshot = new DeskSnapshot(path, 'Schreibtisch', MAC);

  assert.equal(snapshot.update(state()), true);
  snapshot.save(new Date('2026-09-29T12:00:00Z'));

  assert.deepEqual(readSnapshot(path), {
    version: 1,
    name: 'Schreibtisch',
    mac: MAC,
    changedAt: '2026-09-29T12:00:00.000Z',
    connected: true,
    heightMm: 1000,
    minMm: 650,
    maxMm: 1250,
    physicalMinMm: 620,
    physicalMaxMm: 1280,
    memories: [801, 1204, null, null],
    locked: false,
    ecoMode: 'off',
    velocity: 40,
    sensitivity: 'high',
    units: 'cm',
    firmware: 10,
  });
});

test('only a real change counts, and a resting desk wandering is not one', (t) => {
  const snapshot = new DeskSnapshot(fresh(t), 'Desk', MAC);
  snapshot.update(state());
  assert.equal(snapshot.update(state()), false);
  assert.equal(snapshot.update(state({ heightMm: 1003 })), false);
  assert.equal(snapshot.update(state({ heightMm: 1100, moving: 'up' })), false, 'not mid-move');
  assert.equal(snapshot.update(state({ heightMm: 1200 })), true);
  assert.equal(snapshot.update(state({ heightMm: 1200, locked: true })), true);
});

test('out of reach keeps what was last seen, across a restart too', (t) => {
  const path = fresh(t);
  const first = new DeskSnapshot(path, 'Desk', MAC);
  first.update(state());
  first.save();

  const unknown = state().settings;
  for (const key of Object.keys(unknown) as (keyof typeof unknown)[]) {
    (unknown as Record<string, unknown>)[key] = null;
  }
  const gone = state({ connected: false, ready: false, locked: null, settings: unknown });
  const second = new DeskSnapshot(path, 'Desk', MAC);
  assert.equal(second.update(gone), true, 'connected went false');
  assert.equal(second.values.connected, false);
  assert.equal(second.values.ecoMode, 'off');
  assert.equal(second.values.sensitivity, 'high');
  assert.deepEqual(second.values.memories, [801, 1204, null, null]);
  assert.equal(second.disconnect(), false, 'already');
});

test('anything else on disk reads as nothing', (t) => {
  const path = fresh(t);
  assert.equal(readSnapshot(path), null);
  writeFileSync(path, '{"version":2}');
  assert.equal(readSnapshot(path), null);
  writeFileSync(path, 'not json');
  assert.equal(readSnapshot(path), null);
});
