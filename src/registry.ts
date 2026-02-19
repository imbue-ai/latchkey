/**
 * Service registry for looking up services by name or URL.
 */

import {
  Service,
  SLACK,
  DISCORD,
  DROPBOX,
  GITHUB,
  LINEAR,
  NOTION,
  GOOGLE,
  MAILCHIMP,
  GITLAB,
  ZOOM,
  SENTRY,
  STRIPE,
  FIGMA,
  GOOGLE_ANALYTICS,
  CALENDLY,
  YELP,
} from './services/index.js';

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

export const REGISTRY = new Registry([
  SLACK,
  DISCORD,
  DROPBOX,
  GITHUB,
  LINEAR,
  NOTION,
  GOOGLE,
  MAILCHIMP,
  GITLAB,
  ZOOM,
  SENTRY,
  STRIPE,
  FIGMA,
  GOOGLE_ANALYTICS,
  CALENDLY,
  YELP,
]);
