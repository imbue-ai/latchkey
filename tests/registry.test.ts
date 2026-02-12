import { describe, it, expect } from 'vitest';
import { Registry, REGISTRY } from '../src/registry.js';
import {
  SLACK,
  DISCORD,
  GITHUB,
  DROPBOX,
  LINEAR,
  NOTION,
  GOOGLE,
  WORDPRESSCOM,
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

    it('should find Google by name', () => {
      expect(REGISTRY.getByName('google')).toBe(GOOGLE);
    });

    it('should find Notion by name', () => {
      expect(REGISTRY.getByName('notion')).toBe(NOTION);
    });

    it('should find WordPressCom by name', () => {
      expect(REGISTRY.getByName('wordpressCom')).toBe(WORDPRESSCOM);
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

    it('should find Google by API URL', () => {
      expect(REGISTRY.getByUrl('https://www.googleapis.com/gmail/v1/users/me/profile')).toBe(
        GOOGLE
      );
    });

    it('should find Notion by API URL', () => {
      expect(REGISTRY.getByUrl('https://api.notion.com/v1/users/me')).toBe(NOTION);
    });

    it('should find WordPressCom by API URL', () => {
      expect(REGISTRY.getByUrl('https://public-api.wordpress.com/rest/v1.1/me')).toBe(WORDPRESSCOM);
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
      expect(REGISTRY.services).toHaveLength(8);
      expect(REGISTRY.services).toContain(SLACK);
      expect(REGISTRY.services).toContain(DISCORD);
      expect(REGISTRY.services).toContain(GITHUB);
      expect(REGISTRY.services).toContain(DROPBOX);
      expect(REGISTRY.services).toContain(LINEAR);
      expect(REGISTRY.services).toContain(NOTION);
      expect(REGISTRY.services).toContain(GOOGLE);
      expect(REGISTRY.services).toContain(WORDPRESSCOM);
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
