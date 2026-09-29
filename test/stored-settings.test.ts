import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { DeskSettings } from '../src/eliot/desk.ts';
import {
  readStoredSettings,
  storedFrom,
  storedSettingsPath,
  writeStoredSettings,
} from '../src/stored-settings.ts';

const MAC = 'E5:02:4F:BF:74:A2';

const settings = (over: Partial<DeskSettings>): DeskSettings => ({
  firmware: null,
  velocity: null,
  lowPower: null,
  motionMode: null,
  sensitivity: null,
  units: null,
  ...over,
});

test('nothing is written down before the eco pair has arrived', () => {
  assert.equal(storedFrom(settings({ sensitivity: 1 })), null);
  assert.equal(storedFrom(settings({ lowPower: true })), null);
});

test('the box numbers are written in the config words', () => {
  assert.deepEqual(storedFrom(settings({ lowPower: false, velocity: 40, sensitivity: 1 })), {
    ecoMode: 'off',
    velocity: 40,
    sensitivity: 'high',
  });
  assert.deepEqual(storedFrom(settings({ lowPower: true, velocity: 20, sensitivity: 3 })), {
    ecoMode: 'on',
    velocity: 20,
    sensitivity: 'low',
  });
  assert.equal(storedFrom(settings({ lowPower: true, velocity: 20 }))?.sensitivity, null);
});

test('a written file reads back, and anything else reads as nothing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'eliot-desk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = storedSettingsPath(dir, MAC);
  assert.equal(path, join(dir, 'eliot-desk-E5024FBF74A2.json'));

  assert.equal(readStoredSettings(path), null, 'no file yet');

  const data = {
    version: 1 as const,
    name: 'Schreibtisch',
    mac: MAC,
    readAt: '2026-09-29T12:00:00.000Z',
    ecoMode: 'off' as const,
    velocity: 40,
    sensitivity: 'medium' as const,
  };
  writeStoredSettings(path, data);
  assert.deepEqual(readStoredSettings(path), data);

  writeFileSync(path, '{"version":2}');
  assert.equal(readStoredSettings(path), null, 'a version this does not know');
  writeFileSync(path, 'not json');
  assert.equal(readStoredSettings(path), null);
});
