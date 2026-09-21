/**
 * The settings page is shipped as data and never type-checked.
 *
 * A regex in config.schema.json is written as a JSON string, so every
 * backslash has to survive one level of escaping on the way in. Get that wrong
 * and the pattern asks for a literal backslash, matches nothing anyone could
 * type, and the only symptom is a field the Homebridge UI refuses to accept —
 * which is what happened, and which nothing in this suite would have caught.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { DEFAULT_AUTO_MOVE } from '../src/config.ts';
import { parseWindow } from '../src/auto-move.ts';

const schema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8'));
const desk = schema.schema.properties.desks.items.properties;

test('every pattern in the schema is a regex, not an escaped one', () => {
  const patterns: [string, string][] = [];
  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') {
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'pattern' && typeof value === 'string') {
        patterns.push([path, value]);
      }
      walk(value, `${path}.${key}`);
    }
  };
  walk(schema, 'schema');

  assert.ok(patterns.length > 0, 'there are patterns to check');
  for (const [path, pattern] of patterns) {
    assert.ok(
      !pattern.includes('\\\\'),
      `${path} contains an escaped backslash, so it matches nothing: ${pattern}`,
    );
    // And it has to compile.
    new RegExp(pattern);
  }
});

test('the placeholder address is accepted by the address field', () => {
  const { pattern, placeholder } = desk.mac;
  assert.match(placeholder, new RegExp(pattern));
});

test('the default working hours are accepted by the field that holds them', () => {
  const windows = desk.autoMove.properties.windows;
  const pattern = new RegExp(windows.items.pattern);

  for (const window of windows.default) {
    assert.match(window, pattern, 'the UI would refuse its own default');
    assert.notEqual(parseWindow(window), null, 'and the plugin can read it');
  }
});

test('what the settings page offers is what the plugin falls back to', () => {
  const auto = desk.autoMove.properties;
  assert.equal(auto.sittingMm.default, DEFAULT_AUTO_MOVE.sittingMm);
  assert.equal(auto.standingMm.default, DEFAULT_AUTO_MOVE.standingMm);
  assert.equal(auto.intervalMinutes.default, DEFAULT_AUTO_MOVE.intervalMinutes);
  assert.equal(auto.warnMinutes.default, DEFAULT_AUTO_MOVE.warnMinutes);
  assert.deepEqual(auto.windows.default, DEFAULT_AUTO_MOVE.windows);
  assert.deepEqual(auto.days.default, DEFAULT_AUTO_MOVE.days);
});

test('the weekday choices are the ones the plugin understands', () => {
  const offered = desk.autoMove.properties.days.items.enum;
  assert.deepEqual([...offered].sort(), ['fri', 'mon', 'sat', 'sun', 'thu', 'tue', 'wed']);
});
