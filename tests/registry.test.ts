import { describe, it, expect } from 'vitest';
import { DuplicateServiceNameError, Registry, REGISTRY } from '../src/registry.js';
import { RegisteredService } from '../src/registeredService.js';
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
} from '../src/services/index.js';

describe('Registry', () => {
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
    ] as const;

    for (const [name, service] of namedServices) {
      it(`should find ${name} by name`, () => {
        expect(REGISTRY.getByName(name)).toBe(service);
      });
    }

    it('should return null for unknown service', () => {
      expect(REGISTRY.getByName('unknown')).toBeNull();
    });

    it('should be case-sensitive', () => {
      expect(REGISTRY.getByName('Slack')).toBeNull();
    });
  });

  describe('getByUrl', () => {
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
    ] as const;

    for (const [url, service] of urlMappings) {
      it(`should find ${service.name} by URL ${url}`, () => {
        expect(REGISTRY.getByUrl(url)).toBe(service);
      });
    }

    it('should return null for unknown URL', () => {
      expect(REGISTRY.getByUrl('https://example.com/api')).toBeNull();
    });

    it('should not match partial URLs', () => {
      expect(REGISTRY.getByUrl('https://slack.com/')).toBeNull();
    });
  });

  describe('services', () => {
    it('should contain all registered services', () => {
      expect(REGISTRY.services.length).toBeGreaterThan(0);
      expect(REGISTRY.services).toContain(SLACK);
      expect(REGISTRY.services).toContain(GITHUB);
      expect(REGISTRY.services).toContain(AWS);
    });
  });

  describe('custom registry', () => {
    it('should work with custom service list', () => {
      const customRegistry = new Registry([SLACK, GITHUB]);
      expect(customRegistry.services).toHaveLength(2);
      expect(customRegistry.getByName('slack')).toBe(SLACK);
      expect(customRegistry.getByName('github')).toBe(GITHUB);
      expect(customRegistry.getByName('discord')).toBeNull();
    });
  });

  describe('addService', () => {
    it('should add a service to the registry', () => {
      const registry = new Registry([SLACK]);
      const registered = new RegisteredService(
        'my-gitlab',
        'https://gitlab.mycompany.com/api/',
        GITLAB
      );
      registry.addService(registered);

      expect(registry.getByName('my-gitlab')).toBe(registered);
      expect(registry.getByUrl('https://gitlab.mycompany.com/api/v4/user')).toBe(registered);
    });

    it('should throw DuplicateServiceNameError for existing built-in name', () => {
      const registry = new Registry([SLACK]);
      const duplicate = new RegisteredService('slack', 'https://slack.mycompany.com/api/', SLACK);

      expect(() => {
        registry.addService(duplicate);
      }).toThrow(DuplicateServiceNameError);
    });

    it('should throw DuplicateServiceNameError for existing registered name', () => {
      const registry = new Registry([GITLAB]);
      const first = new RegisteredService('my-gitlab', 'https://gitlab.mycompany.com/api/', GITLAB);
      const second = new RegisteredService('my-gitlab', 'https://gitlab.other.com/api/', GITLAB);

      registry.addService(first);
      expect(() => {
        registry.addService(second);
      }).toThrow(DuplicateServiceNameError);
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
