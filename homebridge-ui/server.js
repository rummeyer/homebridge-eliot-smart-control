/**
 * Backend for the plugin's settings page in the Homebridge UI.
 *
 * Does the one thing that cannot be done from a form: find the dongle. It
 * advertises under whatever name the desk was given in the Eliot app, with no
 * manufacturer name and no address on most stickers, so picking it out of a
 * scan list by eye means guessing. This confirms candidates by the service they
 * expose instead, which does not depend on what anybody called it.
 */
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';

import { discoverDesks } from '../dist/eliot/discover.js';
import { describeError } from '../dist/errors.js';

class EliotUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/scan', (r) => this.scan(r));
    this.ready();
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
