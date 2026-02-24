/**
 * Service registry for looking up services by name or URL.
 */

import { loadRegisteredServices } from './configDataStore.js';
import { RegisteredService } from './registeredService.js';
import {
  Service,
  SLACK,
  DISCORD,
  DROPBOX,
  GITHUB,
  LINEAR,
  NOTION,
  GOOGLE_GMAIL,
  GOOGLE_CALENDAR,
  GOOGLE_DRIVE,
  GOOGLE_SHEETS,
  GOOGLE_DOCS,
  GOOGLE_PEOPLE,
  MAILCHIMP,
  GITLAB,
  ZOOM,
  SENTRY,
  STRIPE,
  FIGMA,
  GOOGLE_ANALYTICS,
  CALENDLY,
  YELP,
  TELEGRAM,
  AWS,
  GOOGLE_DIRECTIONS,
} from './services/index.js';

export class DuplicateServiceNameError extends Error {
  constructor(name: string) {
    super(`A service with the name '${name}' already exists.`);
    this.name = 'DuplicateServiceNameError';
  }
}

export class Registry {
  private readonly _services: Service[];

  constructor(services: readonly Service[]) {
    this._services = [...services];
  }

  get services(): readonly Service[] {
    return this._services;
  }

  addService(service: Service): void {
    if (this.getByName(service.name) !== null) {
      throw new DuplicateServiceNameError(service.name);
    }
    this._services.push(service);
  }

  getByName(name: string): Service | null {
    for (const service of this._services) {
      if (service.name === name) {
        return service;
      }
    }
    return null;
  }

  getByUrl(url: string): Service | null {
    for (const service of this._services) {
      for (const baseApiUrl of service.baseApiUrls) {
        if (typeof baseApiUrl === 'string') {
          if (url.startsWith(baseApiUrl)) {
            return service;
          }
        } else {
          if (baseApiUrl.test(url)) {
            return service;
          }
        }
      }
    }
    return null;
  }
}

export function loadRegisteredServicesIntoRegistry(configPath: string, registry: Registry): void {
  const entries = loadRegisteredServices(configPath);
  for (const [name, entry] of entries) {
    const familyService = registry.getByName(entry.serviceFamily);
    if (familyService === null) {
      continue;
    }
    if (registry.getByName(name) !== null) {
      continue;
    }
    const registeredService = new RegisteredService(
      name,
      entry.baseApiUrl,
      familyService,
      entry.loginUrl
    );
    registry.addService(registeredService);
  }
}

export const REGISTRY = new Registry([
  SLACK,
  DISCORD,
  DROPBOX,
  GITHUB,
  LINEAR,
  NOTION,
  GOOGLE_GMAIL,
  GOOGLE_CALENDAR,
  GOOGLE_DRIVE,
  GOOGLE_SHEETS,
  GOOGLE_DOCS,
  GOOGLE_PEOPLE,
  MAILCHIMP,
  GITLAB,
  ZOOM,
  SENTRY,
  STRIPE,
  FIGMA,
  GOOGLE_ANALYTICS,
  CALENDLY,
  YELP,
  TELEGRAM,
  AWS,
  GOOGLE_DIRECTIONS,
]);
