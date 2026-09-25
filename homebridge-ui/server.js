/**
 * Backend for the plugin's settings page in the Homebridge UI.
 *
 * Does the one thing that cannot be done from a form: find the dongle. It
 * advertises under whatever name the desk was given in the Eliot app, with no
 * manufacturer name and no address on most stickers, so picking it out of a
 * scan list by eye means guessing. This confirms candidates by the service they
 * expose instead, which does not depend on what anybody called it.
 */
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';

import { discoverDesks } from '../dist/eliot/discover.js';
import { describeError } from '../dist/errors.js';
import { readStats, shownSpans, statsPath, totalsFor } from '../dist/stats.js';

class EliotUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/scan', (r) => this.scan(r));
    this.onRequest('/stats', () => this.stats());
    this.onRequest('/stats/reset', (r) => this.resetStats(r));
    this.ready();
  }

  /**
   * Sitting and standing time per desk, from the files the plugin writes.
   *
   * Read from disk rather than asked of the running plugin, which is a
   * separate process this page has no line to. The plugin writes every few
   * minutes, so the numbers can trail the desk by that much.
   */
  async stats() {
    const dir = this.homebridgeStoragePath;
    if (!dir) {
      return { desks: [] };
    }
    const now = new Date();
    let names = [];
    try {
      names = readdirSync(dir).filter((n) => /^eliot-stats-[0-9A-F]{12}\.json$/.test(n));
    } catch {
      return { desks: [] };
    }
    const desks = [];
    for (const file of names.sort()) {
      const data = readStats(join(dir, file));
      if (!data) {
        continue;
      }
      desks.push({
        name: data.name,
        mac: data.mac,
        thresholdMm: data.thresholdMm,
        savedAt: data.savedAt,
        spans: shownSpans(data.days, now)
          .map((days) => ({ days, ...totalsFor(data.days, days, now) })),
      });
    }
    return { desks };
  }

  /**
   * Delete one desk's statistics.
   *
   * The plugin notices the file is gone the next time it saves and starts
   * again from nothing, rather than writing back what it holds in memory.
   */
  async resetStats(request) {
    const mac = String(request?.mac ?? '');
    const dir = this.homebridgeStoragePath;
    if (!dir || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(mac)) {
      throw new RequestError('No such desk', { status: 400 });
    }
    rmSync(statsPath(dir, mac), { force: true });
    return { ok: true };
  }

  async scan(request) {
    const seconds = Math.min(Math.max(Number(request?.seconds) || 12, 4), 30);
    try {
      const desks = await discoverDesks({
        scanMs: seconds * 1000,
        // Everything, not only confirmed desks: a dongle whose services BlueZ
        // has not cached yet would otherwise be invisible, and a list with the
        // right answer missing is worse than a longer one.
        includeUnknown: true,
        adapter: typeof request?.adapter === 'string' ? request.adapter : undefined,
      });
      return {
        desks: desks.filter((d) => d.confirmed || d.name),
        others: desks.filter((d) => !d.confirmed && !d.name).length,
      };
    } catch (error) {
      throw new RequestError(`Bluetooth scan failed: ${describeError(error)}`, { status: 500 });
    }
  }
}

void new EliotUiServer();
