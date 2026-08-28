import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createServiceRegistry,
  DuplicateServiceNameError,
  InvalidServiceNameError,
  ServiceRegistry,
  canonicalizeServiceName,
  hideServicesFromRegistry,
} from '../src/serviceRegistry.js';
import { RegisteredService } from '../src/services/core/registered.js';
import { BUILTIN_SERVICE_REGISTRY } from './builtinServiceRegistry.js';
import {
  SLACK,
  DISCORD,
  GITHUB,
  DROPBOX,
  LINEAR,
  NOTION,
  GOOGLE_GMAIL,
  GOOGLE_CALENDAR,
  GOOGLE_DRIVE,
  GOOGLE_SHEETS,
  GOOGLE_DOCS,
  GOOGLE_SLIDES,
  GOOGLE_PEOPLE,
  MAILCHIMP,
  FASTMAIL,
  FASTMAIL_DAV,
  GITLAB,
  AWS,
  TELEGRAM,
  RAMP,
  TODOIST,
} from '../src/services/index.js';
import type { Service } from '../src/services/core/base.js';

/**
 * The primary (first-registered) service that matches a URL. Mirrors how the
 * injection pipeline treats registration order as the tie-breaker.
 */
function primaryServiceForUrl(registry: ServiceRegistry, url: string): Service | null {
  return registry.getByUrl(url);
}

describe('ServiceRegistry', () => {
  describe('getByName', () => {
    const namedServices = [
      ['slack', SLACK],
      ['discord', DISCORD],
      ['github', GITHUB],
      ['dropbox', DROPBOX],
      ['linear', LINEAR],
      ['notion', NOTION],
      ['google-gmail', GOOGLE_GMAIL],
      ['google-calendar', GOOGLE_CALENDAR],
      ['google-drive', GOOGLE_DRIVE],
      ['google-sheets', GOOGLE_SHEETS],
      ['google-docs', GOOGLE_DOCS],
      ['google-slides', GOOGLE_SLIDES],
      ['google-people', GOOGLE_PEOPLE],
      ['mailchimp', MAILCHIMP],
      ['fastmail', FASTMAIL],
      ['fastmail-dav', FASTMAIL_DAV],
      ['aws', AWS],
      ['telegram', TELEGRAM],
      ['ramp', RAMP],
      ['todoist', TODOIST],
    ] as const;

    for (const [name, service] of namedServices) {
      it(`should find ${name} by name`, () => {
        expect(BUILTIN_SERVICE_REGISTRY.getByName(name)).toBe(service);
      });
    }

    it('should return null for unknown service', () => {
      expect(BUILTIN_SERVICE_REGISTRY.getByName('unknown')).toBeNull();
    });

    it('should be case-sensitive', () => {
      expect(BUILTIN_SERVICE_REGISTRY.getByName('Slack')).toBeNull();
    });
  });

  describe('primary service resolution', () => {
    const urlMappings = [
      ['https://slack.com/api/auth.test', SLACK],
      ['https://discord.com/api/v9/users/@me', DISCORD],
      ['https://api.github.com/user', GITHUB],
      ['https://api.dropboxapi.com/2/users/get_current_account', DROPBOX],
      ['https://api.linear.app/graphql', LINEAR],
      ['https://gmail.googleapis.com/gmail/v1/users/me/profile', GOOGLE_GMAIL],
      ['https://www.googleapis.com/calendar/v3/calendars/primary', GOOGLE_CALENDAR],
      ['https://www.googleapis.com/drive/v3/files', GOOGLE_DRIVE],
      ['https://sheets.googleapis.com/v4/spreadsheets', GOOGLE_SHEETS],
      ['https://docs.googleapis.com/v1/documents/abc', GOOGLE_DOCS],
      ['https://slides.googleapis.com/v1/presentations/abc', GOOGLE_SLIDES],
      ['https://people.googleapis.com/v1/people/me', GOOGLE_PEOPLE],
      ['https://api.notion.com/v1/users/me', NOTION],
      ['https://api.mailchimp.com/3.0/ping', MAILCHIMP],
      ['https://us1.api.mailchimp.com/3.0/lists', MAILCHIMP],
      // All four host shapes one Fastmail account can span: session discovery,
      // the region-homed JMAP api the session points at, and the blob CDN in
      // both its plain and region-homed forms.
      ['https://api.fastmail.com/jmap/session', FASTMAIL],
      ['https://phl.api.fastmail.com/jmap/api/', FASTMAIL],
      ['https://www.fastmailusercontent.com/jmap/download/u1/G1/x?type=x', FASTMAIL],
      ['https://phl-www.fastmailusercontent.com/jmap/download/u1/G1/x?type=x', FASTMAIL],
      ['https://carddav.fastmail.com/dav/addressbooks', FASTMAIL_DAV],
      ['https://caldav.fastmail.com/dav/calendars', FASTMAIL_DAV],
      ['https://sts.amazonaws.com/?Action=GetCallerIdentity', AWS],
      ['https://s3.us-east-1.amazonaws.com/my-bucket', AWS],
      ['https://api.ramp.com/developer/v1/transactions', RAMP],
      ['https://api.todoist.com/api/v1/projects', TODOIST],
    ] as const;

    for (const [url, service] of urlMappings) {
      it(`should find ${service.name} by URL ${url}`, () => {
        expect(primaryServiceForUrl(BUILTIN_SERVICE_REGISTRY, url)).toBe(service);
      });
    }

    it('never lets the two Fastmail services claim the same URL', () => {
      // `latchkey curl` picks among services matching a URL by registration
      // order and offers no way to name one, so overlap here would silently
      // route a request with whichever credential was registered first — e.g. a
      // JMAP OAuth token sent to CardDAV, which rejects it. The services are
      // split by host precisely so this can't happen.
      const urls = [
        'https://api.fastmail.com/jmap/session',
        'https://phl.api.fastmail.com/jmap/api/',
        'https://www.fastmailusercontent.com/jmap/download/u1/G1/x?type=x',
        'https://phl-www.fastmailusercontent.com/jmap/download/u1/G1/x?type=x',
        'https://carddav.fastmail.com/dav/addressbooks',
        'https://caldav.fastmail.com/dav/calendars',
        'https://carddav.fastmail.com/dav/principals/',
      ];
      for (const url of urls) {
        const claimants = BUILTIN_SERVICE_REGISTRY.getCandidatesByUrl(url).filter(
          (service) => service === FASTMAIL || service === FASTMAIL_DAV
        );
        expect(claimants).toHaveLength(1);
      }
    });

    it('should return null for unknown URL', () => {
      expect(primaryServiceForUrl(BUILTIN_SERVICE_REGISTRY, 'https://example.com/api')).toBeNull();
    });

    it('should not match partial URLs', () => {
      expect(primaryServiceForUrl(BUILTIN_SERVICE_REGISTRY, 'https://slack.com/')).toBeNull();
    });

    it('should match GitHub git smart-HTTP operation URLs', () => {
      expect(
        primaryServiceForUrl(
          BUILTIN_SERVICE_REGISTRY,
          'https://github.com/owner/repo.git/info/refs?service=git-upload-pack'
        )
      ).toBe(GITHUB);
      expect(
        primaryServiceForUrl(
          BUILTIN_SERVICE_REGISTRY,
          'https://github.com/owner/repo/git-upload-pack'
        )
      ).toBe(GITHUB);
    });

    it('should not match GitHub web pages as git operations', () => {
      expect(
        primaryServiceForUrl(BUILTIN_SERVICE_REGISTRY, 'https://github.com/owner/repo')
      ).toBeNull();
      expect(
        primaryServiceForUrl(BUILTIN_SERVICE_REGISTRY, 'https://github.com/settings/tokens')
      ).toBeNull();
    });
  });

  describe('getCandidatesByUrl', () => {
    it('should return every service matching a shared Drive files URL', () => {
      const candidates = BUILTIN_SERVICE_REGISTRY.getCandidatesByUrl(
        'https://www.googleapis.com/drive/v3/files?pageSize=1'
      );
      expect(candidates).toContain(GOOGLE_DRIVE);
      expect(candidates).toContain(GOOGLE_DOCS);
      expect(candidates).toContain(GOOGLE_SHEETS);
      expect(candidates).toContain(GOOGLE_SLIDES);
      // Drive is the canonical owner and is registered first, so it wins ties.
      expect(candidates[0]).toBe(GOOGLE_DRIVE);
    });

    it('should only match Drive itself for non-files Drive URLs', () => {
      const candidates = BUILTIN_SERVICE_REGISTRY.getCandidatesByUrl(
        'https://www.googleapis.com/drive/v3/about?fields=user'
      );
      expect(candidates).toEqual([GOOGLE_DRIVE]);
    });

    it('should return an empty list for unknown URLs', () => {
      expect(BUILTIN_SERVICE_REGISTRY.getCandidatesByUrl('https://example.com/api')).toEqual([]);
    });
  });

  describe('services', () => {
    it('should contain all registered services', () => {
      expect(BUILTIN_SERVICE_REGISTRY.services.length).toBeGreaterThan(0);
      expect(BUILTIN_SERVICE_REGISTRY.services).toContain(SLACK);
      expect(BUILTIN_SERVICE_REGISTRY.services).toContain(GITHUB);
      expect(BUILTIN_SERVICE_REGISTRY.services).toContain(AWS);
    });
  });

  describe('custom registry', () => {
    it('should work with custom service list', () => {
      const customRegistry = new ServiceRegistry([SLACK, GITHUB]);
      expect(customRegistry.services).toHaveLength(2);
      expect(customRegistry.getByName('slack')).toBe(SLACK);
      expect(customRegistry.getByName('github')).toBe(GITHUB);
      expect(customRegistry.getByName('discord')).toBeNull();
    });
  });

  describe('addService', () => {
    it('should add a service to the registry', () => {
      const registry = new ServiceRegistry([SLACK]);
      const registered = new RegisteredService('my-gitlab', 'https://gitlab.mycompany.com/api/', {
        familyService: GITLAB,
      });
      registry.addService(registered);

      expect(registry.getByName('my-gitlab')).toBe(registered);
      expect(primaryServiceForUrl(registry, 'https://gitlab.mycompany.com/api/v4/user')).toBe(
        registered
      );
    });

    it('should throw DuplicateServiceNameError for existing built-in name', () => {
      const registry = new ServiceRegistry([SLACK]);
      const duplicate = new RegisteredService('slack', 'https://slack.mycompany.com/api/', {
        familyService: SLACK,
      });

      expect(() => {
        registry.addService(duplicate);
      }).toThrow(DuplicateServiceNameError);
    });

    it('should throw DuplicateServiceNameError for existing registered name', () => {
      const registry = new ServiceRegistry([GITLAB]);
      const first = new RegisteredService('my-gitlab', 'https://gitlab.mycompany.com/api/', {
        familyService: GITLAB,
      });
      const second = new RegisteredService('my-gitlab', 'https://gitlab.other.com/api/', {
        familyService: GITLAB,
      });

      registry.addService(first);
      expect(() => {
        registry.addService(second);
      }).toThrow(DuplicateServiceNameError);
    });
  });

  describe('canonicalizeServiceName', () => {
    it('should accept lowercase alphanumeric names', () => {
      expect(canonicalizeServiceName('myservice')).toBe('myservice');
    });

    it('should accept names with hyphens', () => {
      expect(canonicalizeServiceName('my-service')).toBe('my-service');
    });

    it('should accept names with underscores', () => {
      expect(canonicalizeServiceName('my_service')).toBe('my_service');
    });

    it('should accept names with digits', () => {
      expect(canonicalizeServiceName('service2')).toBe('service2');
    });

    it('should convert uppercase to lowercase', () => {
      expect(canonicalizeServiceName('MyService')).toBe('myservice');
    });

    it('should convert mixed case to lowercase', () => {
      expect(canonicalizeServiceName('My-GitLab')).toBe('my-gitlab');
    });

    it('should convert spaces to hyphens', () => {
      expect(canonicalizeServiceName('my service')).toBe('my-service');
    });

    it('should collapse multiple spaces into a single hyphen', () => {
      expect(canonicalizeServiceName('my   service')).toBe('my-service');
    });

    it('should reject names with special characters', () => {
      expect(() => canonicalizeServiceName('my@service')).toThrow(InvalidServiceNameError);
    });

    it('should reject names with dots', () => {
      expect(() => canonicalizeServiceName('my.service')).toThrow(InvalidServiceNameError);
    });

    it('should reject empty names', () => {
      expect(() => canonicalizeServiceName('')).toThrow(InvalidServiceNameError);
    });

    it('should reject names starting with a hyphen', () => {
      expect(() => canonicalizeServiceName('-myservice')).toThrow(InvalidServiceNameError);
    });

    it('should reject names starting with an underscore', () => {
      expect(() => canonicalizeServiceName('_myservice')).toThrow(InvalidServiceNameError);
    });

    it('should reject names that are only spaces', () => {
      expect(() => canonicalizeServiceName('   ')).toThrow(InvalidServiceNameError);
    });
  });

  describe('RegisteredService', () => {
    it('should not expose getSession when no loginUrl is provided', () => {
      const registered = new RegisteredService('my-gitlab', 'https://gitlab.mycompany.com/api/', {
        familyService: GITLAB,
      });
      expect(registered.getSession).toBeUndefined(); // eslint-disable-line @typescript-eslint/unbound-method
      expect(registered.loginUrl).toBe('');
    });

    it('should expose getSession when loginUrl is provided and family supports it', () => {
      const registered = new RegisteredService('my-slack', 'https://slack.mycompany.com/api/', {
        familyService: SLACK,
        loginUrl: 'https://slack.mycompany.com/signin',
      });
      expect(registered.getSession).toBeDefined(); // eslint-disable-line @typescript-eslint/unbound-method
      expect(registered.loginUrl).toBe('https://slack.mycompany.com/signin');
    });

    it('should work without a family service', () => {
      const registered = new RegisteredService('my-api', 'https://api.example.com/');
      expect(registered.getSession).toBeUndefined(); // eslint-disable-line @typescript-eslint/unbound-method
      expect(registered.loginUrl).toBe('');
      expect(registered.info).toContain('Generic service');
      expect(registered.setCredentialsExample('my-api')).toContain('latchkey auth set my-api');
    });

    it('should not expose getSession when loginUrl is provided but no family', () => {
      // A login URL on its own is not a login: the options type requires it to
      // come with either a family service or a login flow.
      // @ts-expect-error -- loginUrl alone is not a valid option
      const registered = new RegisteredService('my-api', 'https://api.example.com/', {
        loginUrl: 'https://api.example.com/login',
      });
      expect(registered.getSession).toBeUndefined(); // eslint-disable-line @typescript-eslint/unbound-method
    });

    it('should not expose getSession when loginUrl is provided but family lacks it', () => {
      // TELEGRAM has no getSession
      const registered = new RegisteredService(
        'my-telegram',
        'https://telegram.mycompany.com/bot',
        {
          familyService: TELEGRAM,
          loginUrl: 'https://telegram.mycompany.com/login',
        }
      );
      expect(registered.getSession).toBeUndefined(); // eslint-disable-line @typescript-eslint/unbound-method
    });
  });

  describe('removeService', () => {
    it('removes a service so it can no longer be looked up', () => {
      const registry = new ServiceRegistry([SLACK, GITHUB]);
      registry.removeService('slack');
      expect(registry.getByName('slack')).toBeNull();
      expect(registry.getByName('github')).toBe(GITHUB);
      expect(registry.services).toHaveLength(1);
    });

    it('does nothing when the service is not present', () => {
      const registry = new ServiceRegistry([SLACK]);
      registry.removeService('does-not-exist');
      expect(registry.services).toHaveLength(1);
    });
  });

  describe('hideServicesFromRegistry', () => {
    it('removes the named services', () => {
      const registry = new ServiceRegistry([SLACK, GITHUB, DISCORD]);
      hideServicesFromRegistry(registry, ['slack', 'discord']);
      expect(registry.getByName('slack')).toBeNull();
      expect(registry.getByName('discord')).toBeNull();
      expect(registry.getByName('github')).toBe(GITHUB);
    });

    it('does nothing for an empty list', () => {
      const registry = new ServiceRegistry([SLACK, GITHUB]);
      hideServicesFromRegistry(registry, []);
      expect(registry.services).toHaveLength(2);
    });

    it('silently ignores unknown service names', () => {
      const registry = new ServiceRegistry([SLACK]);
      hideServicesFromRegistry(registry, ['nope', 'slack']);
      expect(registry.getByName('slack')).toBeNull();
      expect(registry.services).toHaveLength(0);
    });
  });

  describe('createServiceRegistry', () => {
    let temporaryDirectory: string;
    let configPath: string;

    beforeEach(() => {
      temporaryDirectory = mkdtempSync(join(tmpdir(), 'latchkey-registry-'));
      configPath = join(temporaryDirectory, 'config.json');
    });

    afterEach(() => {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    });

    function writeRegisteredServices(registeredServices: Record<string, unknown>): void {
      writeFileSync(configPath, JSON.stringify({ registeredServices }));
    }

    it('combines the base services with the ones registered in config.json', () => {
      writeRegisteredServices({
        'self-hosted-gitlab': {
          baseApiUrl: 'https://gitlab.example.com/api/',
          serviceFamily: 'gitlab',
        },
      });

      const registry = createServiceRegistry([SLACK, GITLAB], configPath, []);

      expect(registry.getByName('slack')).toBe(SLACK);
      expect(registry.getByName('gitlab')).toBe(GITLAB);
      expect(registry.getByName('self-hosted-gitlab')).toBeInstanceOf(RegisteredService);
    });

    it('works when config.json does not exist', () => {
      const registry = createServiceRegistry([SLACK], configPath, []);

      expect(registry.services).toHaveLength(1);
      expect(registry.getByName('slack')).toBe(SLACK);
    });

    it('picks up a service registered between two calls', () => {
      writeRegisteredServices({});
      expect(createServiceRegistry([SLACK], configPath, []).getByName('added-later')).toBeNull();

      writeRegisteredServices({ 'added-later': { baseApiUrl: 'https://api.example.com/' } });

      const refreshed = createServiceRegistry([SLACK], configPath, []);
      expect(refreshed.getByName('added-later')).toBeInstanceOf(RegisteredService);
      expect(refreshed.getByUrl('https://api.example.com/things')?.name).toBe('added-later');
    });

    it('drops a service deregistered between two calls', () => {
      writeRegisteredServices({ 'going-away': { baseApiUrl: 'https://api.example.com/' } });
      expect(createServiceRegistry([SLACK], configPath, []).getByName('going-away')).not.toBeNull();

      writeRegisteredServices({});

      const refreshed = createServiceRegistry([SLACK], configPath, []);
      expect(refreshed.getByName('going-away')).toBeNull();
      expect(refreshed.getByUrl('https://api.example.com/things')).toBeNull();
    });

    it('returns an independent registry on every call', () => {
      writeRegisteredServices({});
      const first = createServiceRegistry([SLACK], configPath, []);
      const second = createServiceRegistry([SLACK], configPath, []);

      first.removeService('slack');

      expect(first.getByName('slack')).toBeNull();
      expect(second.getByName('slack')).toBe(SLACK);
    });

    it('skips config.json entirely when given no path', () => {
      writeRegisteredServices({ 'from-the-file': { baseApiUrl: 'https://api.example.com/' } });

      const registry = createServiceRegistry([SLACK, GITHUB], null, ['github']);

      expect(registry.getByName('from-the-file')).toBeNull();
      expect(registry.getByName('slack')).toBe(SLACK);
      // Hiding still applies, as it does for a CLI pointed at a gateway.
      expect(registry.getByName('github')).toBeNull();
    });

    it('hides the named services', () => {
      writeRegisteredServices({});

      const registry = createServiceRegistry([SLACK, GITHUB], configPath, ['slack']);

      expect(registry.getByName('slack')).toBeNull();
      expect(registry.getByName('github')).toBe(GITHUB);
    });

    it('lets a registered service use a hidden built-in as its family', () => {
      writeRegisteredServices({
        'self-hosted-gitlab': {
          baseApiUrl: 'https://gitlab.example.com/api/',
          serviceFamily: 'gitlab',
        },
      });

      const registry = createServiceRegistry([GITLAB], configPath, ['gitlab']);

      expect(registry.getByName('gitlab')).toBeNull();
      expect(registry.getByName('self-hosted-gitlab')).toBeInstanceOf(RegisteredService);
    });
  });
});
