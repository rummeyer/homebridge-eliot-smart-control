import type { API } from 'homebridge';

import { EliotPlatform } from './platform.ts';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.ts';

/** Homebridge entry point. */
export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, EliotPlatform);
};
