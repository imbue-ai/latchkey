/**
 * Service registry for looking up services by name or URL.
 */

import { Service, SLACK, DISCORD, DROPBOX, GITHUB, LINEAR, NOTION } from './services/index.js';

export class Registry {
  readonly services: readonly Service[];

  constructor(services: readonly Service[]) {
    this.services = services;
  }

  getByName(name: string): Service | null {
    for (const service of this.services) {
      if (service.name === name) {
        return service;
      }
    }
    return null;
  }

  getByUrl(url: string): Service | null {
    for (const service of this.services) {
      for (const baseApiUrl of service.baseApiUrls) {
        if (url.startsWith(baseApiUrl)) {
          return service;
        }
      }
    }
    return null;
  }
}

export const REGISTRY = new Registry([SLACK, DISCORD, DROPBOX, GITHUB, LINEAR, NOTION]);
