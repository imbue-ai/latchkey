/**
 * Service registry for looking up services by name or URL.
 */

import { loadRegisteredServices } from './configDataStore.js';
import { RegisteredService } from './services/core/registered.js';
import {
  Service,
  SLACK,
  DISCORD,
  DROPBOX,
  GITHUB,
  LINEAR,
  NOTION,
  NOTION_MCP,
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
  COOLIFY,
  UMAMI,
  RAMP,
  TODOIST,
} from './services/index.js';

export class DuplicateServiceNameError extends Error {
  constructor(name: string) {
    super(`A service with the name '${name}' already exists.`);
    this.name = 'DuplicateServiceNameError';
  }
}

export class InvalidServiceNameError extends Error {
  constructor(name: string) {
    super(
      `Invalid service name '${name}'. Names must contain only lowercase letters, digits, hyphens, and underscores.`
    );
    this.name = 'InvalidServiceNameError';
  }
}

const SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function canonicalizeServiceName(name: string): string {
  const canonicalized = name.toLowerCase().replace(/\s+/g, '-');
  if (!SERVICE_NAME_PATTERN.test(canonicalized)) {
    throw new InvalidServiceNameError(name);
  }
  return canonicalized;
}

export class ServiceRegistry {
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

  private matchesUrl(service: Service, url: string): boolean {
    for (const baseApiUrl of service.baseApiUrls) {
      if (typeof baseApiUrl === 'string') {
        if (url.startsWith(baseApiUrl)) {
          return true;
        }
      } else {
        if (baseApiUrl.test(url)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Return every service whose base API URLs match the given URL, in
   * registration order.
   *
   * Some APIs are shared across services (e.g. the Google Drive files API is
   * used by Drive, Docs, and Sheets), so a single URL can legitimately match
   * more than one service. Callers disambiguate by picking the candidate that
   * actually has usable credentials.
   */
  getCandidatesByUrl(url: string): readonly Service[] {
    return this._services.filter((service) => this.matchesUrl(service, url));
  }

  /**
   * The primary (first-registered) service matching a URL, or null if none do.
   *
   * The injection pipeline uses {@link getCandidatesByUrl} to consider every
   * match and disambiguate by credential availability; this remains as a
   * convenience for SDK consumers that just want the canonical owner.
   */
  getByUrl(url: string): Service | null {
    return this.getCandidatesByUrl(url)[0] ?? null;
  }
}

export function loadRegisteredServicesIntoServiceRegistry(
  configPath: string,
  registry: ServiceRegistry
): void {
  const entries = loadRegisteredServices(configPath);
  for (const [name, entry] of entries) {
    let familyService: Service | undefined;
    if (entry.serviceFamily !== undefined) {
      familyService = registry.getByName(entry.serviceFamily) ?? undefined;
      if (familyService === undefined) {
        continue;
      }
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

export const SERVICE_REGISTRY = new ServiceRegistry([
  SLACK,
  DISCORD,
  DROPBOX,
  GITHUB,
  LINEAR,
  NOTION,
  NOTION_MCP,
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
  COOLIFY,
  UMAMI,
  RAMP,
  TODOIST,
]);
