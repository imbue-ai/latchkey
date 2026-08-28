/**
 * A registry over the services latchkey ships with.
 *
 * The CLI and the gateway each build their own registry with
 * `createServiceRegistry`, since theirs also carry whatever config.json holds.
 * Tests that only care about the built-in services share this one.
 */

import { BUILTIN_SERVICES, ServiceRegistry } from '../src/serviceRegistry.js';

export const BUILTIN_SERVICE_REGISTRY = new ServiceRegistry(BUILTIN_SERVICES);
