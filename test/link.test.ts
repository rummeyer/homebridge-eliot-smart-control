import assert from 'node:assert/strict';
import test from 'node:test';

import { describeSignal, openAdapter } from '../src/eliot/link.ts';

/** Just the part of a node-ble session that picking an adapter touches. */
function session(present: string[]) {
  const bluetooth = {
    adapters: async () => present,
    defaultAdapter: async () => `default:${present[0]}`,
    getAdapter: async (name: string) => `named:${name}`,
  };
  return { bluetooth } as unknown as Parameters<typeof openAdapter>[0];
}

test('no adapter configured takes the default', async () => {
  assert.equal(await openAdapter(session(['hci0', 'hci1'])), 'default:hci0');
  assert.equal(await openAdapter(session(['hci0', 'hci1']), '  '), 'default:hci0');
});

test('a configured adapter is used by name', async () => {
  assert.equal(await openAdapter(session(['hci0', 'hci1']), ' hci1 '), 'named:hci1');
});

test('a missing adapter says what there is instead', async () => {
  await assert.rejects(openAdapter(session(['hci0']), 'hci2'), /hci2 not found .* hci0$/);
  await assert.rejects(openAdapter(session([]), 'hci0'), /has none$/);
});

test('the signal reads as a suffix, marked when weak', () => {
  assert.equal(describeSignal(null), '');
  assert.equal(describeSignal(-66), ', -66 dBm');
  assert.equal(describeSignal(-85), ', -85 dBm');
  assert.equal(describeSignal(-86), ', -86 dBm (weak)');
});
