#!/usr/bin/env node
/**
 * List the desk dongles within range.
 *
 *   npm run build && node tools/find-desks.js [seconds]
 *
 * The same discovery the settings page uses, so what it prints here is what a
 * person picking from a list would see.
 */
import { discoverDesks } from '../dist/eliot/discover.js';

const seconds = Number(process.argv[2] || 12);
console.log(`Scanning for ${seconds}s …\n`);

const found = await discoverDesks({ scanMs: seconds * 1000, includeUnknown: true });
if (!found.length) {
  console.log('Nothing found at all — is the adapter up?');
  process.exit(1);
}

console.log(`${'address'.padEnd(18)} ${'rssi'.padStart(6)}  ${'desk?'.padEnd(6)} ${'in use'.padEnd(7)} name`);
for (const d of found) {
  console.log(
    `${d.address.padEnd(18)} ${String(d.rssi ?? '?').padStart(4)}dBm  ` +
      `${(d.confirmed ? 'yes' : '-').padEnd(6)} ${(d.connected ? 'yes' : '-').padEnd(7)} ${d.name ?? ''}`,
  );
}
const desks = found.filter((d) => d.confirmed);
console.log(`\n${desks.length} desk(s) confirmed by service UUID, ${found.length} devices seen.`);
process.exit(0);
