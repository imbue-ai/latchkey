import { describe, it, expect } from 'vitest';
import {
  DuplicateServiceNameError,
  InvalidServiceNameError,
  ServiceRegistry,
  SERVICE_REGISTRY,
  canonicalizeServiceName,
} from '../src/serviceRegistry.js';
import { RegisteredService } from '../src/services/core/registered.js';
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
  GOOGLE_PEOPLE,
  MAILCHIMP,
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
      ['google-people', GOOGLE_PEOPLE],
      ['mailchimp', MAILCHIMP],
      ['aws', AWS],
      ['telegram', TELEGRAM],
      ['ramp', RAMP],
      ['todoist', TODOIST],
    ] as const;

    for (const [name, service] of namedServices) {
      it(`should find ${name} by name`, () => {
        expect(SERVICE_REGISTRY.getByName(name)).toBe(service);
      });
    }

    it('should return null for unknown service', () => {
      expect(SERVICE_REGISTRY.getByName('unknown')).toBeNull();
    });

    it('should be case-sensitive', () => {
      expect(SERVICE_REGISTRY.getByName('Slack')).toBeNull();
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
      ['https://people.googleapis.com/v1/people/me', GOOGLE_PEOPLE],
      ['https://api.notion.com/v1/users/me', NOTION],
      ['https://api.mailchimp.com/3.0/ping', MAILCHIMP],
      ['https://us1.api.mailchimp.com/3.0/lists', MAILCHIMP],
      ['https://sts.amazonaws.com/?Action=GetCallerIdentity', AWS],
      ['https://s3.us-east-1.amazonaws.com/my-bucket', AWS],
      ['https://api.ramp.com/developer/v1/transactions', RAMP],
      ['https://api.todoist.com/api/v1/projects', TODOIST],
    ] as const;

    for (const [url, service] of urlMappings) {
      it(`should find ${service.name} by URL ${url}`, () => {
        expect(primaryServiceForUrl(SERVICE_REGISTRY, url)).toBe(service);
      });
    }

    it('should return null for unknown URL', () => {
      expect(primaryServiceForUrl(SERVICE_REGISTRY, 'https://example.com/api')).toBeNull();
    });

    it('should not match partial URLs', () => {
      expect(primaryServiceForUrl(SERVICE_REGISTRY, 'https://slack.com/')).toBeNull();
    });

    it('should match GitHub git smart-HTTP operation URLs', () => {
      expect(
        primaryServiceForUrl(
          SERVICE_REGISTRY,
          'https://github.com/owner/repo.git/info/refs?service=git-upload-pack'
        )
      ).toBe(GITHUB);
      expect(
        primaryServiceForUrl(SERVICE_REGISTRY, 'https://github.com/owner/repo/git-upload-pack')
      ).toBe(GITHUB);
    });

    it('should not match GitHub web pages as git operations', () => {
      expect(primaryServiceForUrl(SERVICE_REGISTRY, 'https://github.com/owner/repo')).toBeNull();
      expect(
        primaryServiceForUrl(SERVICE_REGISTRY, 'https://github.com/settings/tokens')
      ).toBeNull();
    });
  });

  describe('getCandidatesByUrl', () => {
    it('should return every service matching a shared Drive files URL', () => {
      const candidates = SERVICE_REGISTRY.getCandidatesByUrl(
        'https://www.googleapis.com/drive/v3/files?pageSize=1'
      );
      expect(candidates).toContain(GOOGLE_DRIVE);
      expect(candidates).toContain(GOOGLE_DOCS);
      expect(candidates).toContain(GOOGLE_SHEETS);
      // Drive is the canonical owner and is registered first, so it wins ties.
      expect(candidates[0]).toBe(GOOGLE_DRIVE);
    });

    it('should only match Drive itself for non-files Drive URLs', () => {
      const candidates = SERVICE_REGISTRY.getCandidatesByUrl(
        'https://www.googleapis.com/drive/v3/about?fields=user'
      );
      expect(candidates).toEqual([GOOGLE_DRIVE]);
    });

    it('should return an empty list for unknown URLs', () => {
      expect(SERVICE_REGISTRY.getCandidatesByUrl('https://example.com/api')).toEqual([]);
    });
  });

  describe('services', () => {
    it('should contain all registered services', () => {
      expect(SERVICE_REGISTRY.services.length).toBeGreaterThan(0);
      expect(SERVICE_REGISTRY.services).toContain(SLACK);
      expect(SERVICE_REGISTRY.services).toContain(GITHUB);
      expect(SERVICE_REGISTRY.services).toContain(AWS);
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
      const registered = new RegisteredService(
        'my-gitlab',
        'https://gitlab.mycompany.com/api/',
        GITLAB
      );
      registry.addService(registered);

      expect(registry.getByName('my-gitlab')).toBe(registered);
      expect(primaryServiceForUrl(registry, 'https://gitlab.mycompany.com/api/v4/user')).toBe(
        registered
      );
    });

    it('should throw DuplicateServiceNameError for existing built-in name', () => {
      const registry = new ServiceRegistry([SLACK]);
      const duplicate = new RegisteredService('slack', 'https://slack.mycompany.com/api/', SLACK);

      expect(() => {
        registry.addService(duplicate);
      }).toThrow(DuplicateServiceNameError);
    });

    it('should throw DuplicateServiceNameError for existing registered name', () => {
      const registry = new ServiceRegistry([GITLAB]);
      const first = new RegisteredService('my-gitlab', 'https://gitlab.mycompany.com/api/', GITLAB);
      const second = new RegisteredService('my-gitlab', 'https://gitlab.other.com/api/', GITLAB);

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
      const registered = new RegisteredService(
        'my-gitlab',
        'https://gitlab.mycompany.com/api/',
        GITLAB
      );
      expect(registered.getSession).toBeUndefined(); // eslint-disable-line @typescript-eslint/unbound-method
      expect(registered.loginUrl).toBe('');
    });

    it('should expose getSession when loginUrl is provided and family supports it', () => {
      const registered = new RegisteredService(
        'my-slack',
        'https://slack.mycompany.com/api/',
        SLACK,
        'https://slack.mycompany.com/signin'
      );
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
      const registered = new RegisteredService(
        'my-api',
        'https://api.example.com/',
        undefined,
        'https://api.example.com/login'
      );
      expect(registered.getSession).toBeUndefined(); // eslint-disable-line @typescript-eslint/unbound-method
    });

    it('should not expose getSession when loginUrl is provided but family lacks it', () => {
      // TELEGRAM has no getSession
      const registered = new RegisteredService(
        'my-telegram',
        'https://telegram.mycompany.com/bot',
        TELEGRAM,
        'https://telegram.mycompany.com/login'
      );
      expect(registered.getSession).toBeUndefined(); // eslint-disable-line @typescript-eslint/unbound-method
    });
  });
});
