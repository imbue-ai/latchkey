import { describe, it, expect } from 'vitest';
import { Registry, REGISTRY } from '../src/registry.js';
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
} from '../src/services/index.js';

describe('Registry', () => {
  describe('getByName', () => {
    it('should find Slack by name', () => {
      expect(REGISTRY.getByName('slack')).toBe(SLACK);
    });

    it('should find Discord by name', () => {
      expect(REGISTRY.getByName('discord')).toBe(DISCORD);
    });

    it('should find GitHub by name', () => {
      expect(REGISTRY.getByName('github')).toBe(GITHUB);
    });

    it('should find Dropbox by name', () => {
      expect(REGISTRY.getByName('dropbox')).toBe(DROPBOX);
    });

    it('should find Linear by name', () => {
      expect(REGISTRY.getByName('linear')).toBe(LINEAR);
    });

    it('should find Google services by name', () => {
      expect(REGISTRY.getByName('google-gmail')).toBe(GOOGLE_GMAIL);
      expect(REGISTRY.getByName('google-calendar')).toBe(GOOGLE_CALENDAR);
      expect(REGISTRY.getByName('google-drive')).toBe(GOOGLE_DRIVE);
      expect(REGISTRY.getByName('google-sheets')).toBe(GOOGLE_SHEETS);
      expect(REGISTRY.getByName('google-docs')).toBe(GOOGLE_DOCS);
      expect(REGISTRY.getByName('google-people')).toBe(GOOGLE_PEOPLE);
    });

    it('should find Notion by name', () => {
      expect(REGISTRY.getByName('notion')).toBe(NOTION);
    });

    it('should find Mailchimp by name', () => {
      expect(REGISTRY.getByName('mailchimp')).toBe(MAILCHIMP);
    });

    it('should find AWS by name', () => {
      expect(REGISTRY.getByName('aws')).toBe(AWS);
    });

    it('should return null for unknown service', () => {
      expect(REGISTRY.getByName('unknown')).toBeNull();
    });

    it('should be case-sensitive', () => {
      expect(REGISTRY.getByName('Slack')).toBeNull();
      expect(REGISTRY.getByName('SLACK')).toBeNull();
    });
  });

  describe('getByUrl', () => {
    it('should find Slack by API URL', () => {
      expect(REGISTRY.getByUrl('https://slack.com/api/auth.test')).toBe(SLACK);
      expect(REGISTRY.getByUrl('https://slack.com/api/users.list')).toBe(SLACK);
    });

    it('should find Discord by API URL', () => {
      expect(REGISTRY.getByUrl('https://discord.com/api/v9/users/@me')).toBe(DISCORD);
      expect(REGISTRY.getByUrl('https://discord.com/api/guilds')).toBe(DISCORD);
    });

    it('should find GitHub by API URL', () => {
      expect(REGISTRY.getByUrl('https://api.github.com/user')).toBe(GITHUB);
      expect(REGISTRY.getByUrl('https://api.github.com/repos')).toBe(GITHUB);
    });

    it('should find Dropbox by API URL', () => {
      expect(REGISTRY.getByUrl('https://api.dropboxapi.com/2/users/get_current_account')).toBe(
        DROPBOX
      );
      expect(REGISTRY.getByUrl('https://content.dropboxapi.com/upload')).toBe(DROPBOX);
      expect(REGISTRY.getByUrl('https://notify.dropboxapi.com/subscribe')).toBe(DROPBOX);
    });

    it('should find Linear by API URL', () => {
      expect(REGISTRY.getByUrl('https://api.linear.app/graphql')).toBe(LINEAR);
    });

    it('should find Google services by API URL', () => {
      expect(REGISTRY.getByUrl('https://gmail.googleapis.com/gmail/v1/users/me/profile')).toBe(
        GOOGLE_GMAIL
      );
      expect(REGISTRY.getByUrl('https://www.googleapis.com/calendar/v3/calendars/primary')).toBe(
        GOOGLE_CALENDAR
      );
      expect(REGISTRY.getByUrl('https://www.googleapis.com/drive/v3/files')).toBe(GOOGLE_DRIVE);
      expect(REGISTRY.getByUrl('https://sheets.googleapis.com/v4/spreadsheets')).toBe(
        GOOGLE_SHEETS
      );
      expect(REGISTRY.getByUrl('https://docs.googleapis.com/v1/documents/abc')).toBe(GOOGLE_DOCS);
      expect(REGISTRY.getByUrl('https://people.googleapis.com/v1/people/me')).toBe(GOOGLE_PEOPLE);
    });

    it('should find Notion by API URL', () => {
      expect(REGISTRY.getByUrl('https://api.notion.com/v1/users/me')).toBe(NOTION);
    });

    it('should find Mailchimp by API URL', () => {
      expect(REGISTRY.getByUrl('https://api.mailchimp.com/3.0/ping')).toBe(MAILCHIMP);
    });

    it('should find Mailchimp by regex pattern for datacenter-specific URLs', () => {
      expect(REGISTRY.getByUrl('https://us1.api.mailchimp.com/3.0/lists')).toBe(MAILCHIMP);
      expect(REGISTRY.getByUrl('https://us19.api.mailchimp.com/3.0/campaigns')).toBe(MAILCHIMP);
      expect(REGISTRY.getByUrl('https://eu-west-1.api.mailchimp.com/3.0/automations')).toBe(
        MAILCHIMP
      );
    });

    it('should find AWS by API URL', () => {
      expect(REGISTRY.getByUrl('https://sts.amazonaws.com/?Action=GetCallerIdentity')).toBe(AWS);
      expect(REGISTRY.getByUrl('https://s3.us-east-1.amazonaws.com/my-bucket')).toBe(AWS);
      expect(
        REGISTRY.getByUrl('https://bedrock-runtime.us-west-2.amazonaws.com/model/invoke')
      ).toBe(AWS);
    });

    it('should return null for unknown URL', () => {
      expect(REGISTRY.getByUrl('https://example.com/api')).toBeNull();
    });

    it('should not match partial URLs', () => {
      expect(REGISTRY.getByUrl('https://slack.com/')).toBeNull();
      expect(REGISTRY.getByUrl('https://slack.com')).toBeNull();
    });
  });

  describe('services', () => {
    it('should contain all services', () => {
      expect(REGISTRY.services).toHaveLength(24);
      expect(REGISTRY.services).toContain(SLACK);
      expect(REGISTRY.services).toContain(DISCORD);
      expect(REGISTRY.services).toContain(GITHUB);
      expect(REGISTRY.services).toContain(DROPBOX);
      expect(REGISTRY.services).toContain(LINEAR);
      expect(REGISTRY.services).toContain(NOTION);
      expect(REGISTRY.services).toContain(GOOGLE_GMAIL);
      expect(REGISTRY.services).toContain(GOOGLE_CALENDAR);
      expect(REGISTRY.services).toContain(GOOGLE_DRIVE);
      expect(REGISTRY.services).toContain(GOOGLE_SHEETS);
      expect(REGISTRY.services).toContain(GOOGLE_DOCS);
      expect(REGISTRY.services).toContain(GOOGLE_PEOPLE);
      expect(REGISTRY.services).toContain(MAILCHIMP);
      expect(REGISTRY.services).toContain(GITLAB);
      expect(REGISTRY.services).toContain(ZOOM);
      expect(REGISTRY.services).toContain(SENTRY);
      expect(REGISTRY.services).toContain(STRIPE);
      expect(REGISTRY.services).toContain(FIGMA);
      expect(REGISTRY.services).toContain(GOOGLE_ANALYTICS);
      expect(REGISTRY.services).toContain(CALENDLY);
      expect(REGISTRY.services).toContain(YELP);
      expect(REGISTRY.services).toContain(TELEGRAM);
      expect(REGISTRY.services).toContain(AWS);
      expect(REGISTRY.services).toContain(GOOGLE_DIRECTIONS);
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

    it('should work with empty service list', () => {
      const emptyRegistry = new Registry([]);
      expect(emptyRegistry.services).toHaveLength(0);
      expect(emptyRegistry.getByName('slack')).toBeNull();
      expect(emptyRegistry.getByUrl('https://slack.com/api/test')).toBeNull();
    });
  });
});
