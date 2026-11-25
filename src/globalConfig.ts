/**
 * The configuration of the Latchkey command line.
 *
 * Kept apart from the `Config` class so that importing the class does not read
 * the environment: only the command line and the main entry point import this
 * module, and a program that embeds Latchkey builds its own `Config`.
 */

import { Config } from './config.js';
import { setCurlCommand } from './curl.js';

/**
 * Global configuration singleton, initialized from the environment at import time.
 */
export const CONFIG = new Config();

setCurlCommand(CONFIG.curlCommand);
