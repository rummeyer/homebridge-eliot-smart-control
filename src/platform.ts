import type { API, DynamicPlatformPlugin, Logger, PlatformAccessory } from 'homebridge';

import { EliotAccessory } from './accessory.ts';
import { validateDeskConfig } from './config.ts';
import type { DeskConfig, EliotPlatformConfig } from './config.ts';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.ts';

/** Registers one HomeKit accessory per configured desk and owns their lifecycle. */
export class EliotPlatform implements DynamicPlatformPlugin {
  /** Accessories restored from Homebridge's cache, keyed by UUID. */
  readonly #cached = new Map<string, PlatformAccessory>();
  readonly #desks: EliotAccessory[] = [];

  constructor(
    public readonly log: Logger,
    public readonly config: EliotPlatformConfig,
    public readonly api: API,
  ) {
    this.api.on('didFinishLaunching', () => this.#discover());
    this.api.on('shutdown', () => {
      void Promise.all(this.#desks.map((desk) => desk.stop()));
    });
  }

  /** Homebridge replays cached accessories here before `didFinishLaunching`. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.#cached.set(accessory.UUID, accessory);
  }

  #discover(): void {
    const desks = this.config.desks ?? [];
    if (desks.length === 0) {
      this.log.warn('No desks configured — nothing to do. Add a "desks" entry to config.json.');
      return;
    }

    const configured = new Set<string>();

    for (const [index, desk] of desks.entries()) {
      const problems = validateDeskConfig(desk, index);
      if (problems.length > 0) {
        for (const problem of problems) {
          this.log.error(`Ignoring invalid desk config: ${problem}`);
        }
        continue;
      }

      // Keyed on the dongle's address, so renaming a desk in the config does
      // not orphan its accessory and lose its room and automations.
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${desk.mac.toUpperCase()}`);
      configured.add(uuid);

      let accessory = this.#cached.get(uuid);
      if (accessory) {
        accessory.displayName = desk.name;
        accessory.context.desk = desk satisfies DeskConfig;
        this.api.updatePlatformAccessories([accessory]);
        this.log.info(`Restoring ${desk.name} (${desk.mac})`);
      } else {
        accessory = new this.api.platformAccessory(desk.name, uuid);
        accessory.context.desk = desk satisfies DeskConfig;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Adding ${desk.name} (${desk.mac})`);
      }

      const handle = new EliotAccessory(this, accessory, desk);
      this.#desks.push(handle);
      void handle.start();
    }

    this.#prune(configured);
  }

  /** Drop accessories whose desk was removed from config.json. */
  #prune(configured: Set<string>): void {
    const stale = [...this.#cached.entries()].filter(([uuid]) => !configured.has(uuid));
    if (stale.length === 0) {
      return;
    }
    this.log.info(`Removing ${stale.length} accessory/accessories no longer in config`);
    this.api.unregisterPlatformAccessories(
      PLUGIN_NAME,
      PLATFORM_NAME,
      stale.map(([, accessory]) => accessory),
    );
  }
}
