import { describe, it, expect } from 'vitest';
import { Registry, REGISTRY } from '../src/registry.js';
import { SLACK, DISCORD, GITHUB, DROPBOX, LINEAR, isDatabricksUrl } from '../src/services/index.js';

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

    it('should return null for unknown URL', () => {
      expect(REGISTRY.getByUrl('https://example.com/api')).toBeNull();
      expect(REGISTRY.getByUrl('https://google.com')).toBeNull();
    });

    it('should not match partial URLs', () => {
      expect(REGISTRY.getByUrl('https://slack.com/')).toBeNull();
      expect(REGISTRY.getByUrl('https://slack.com')).toBeNull();
    });

    it('should find Databricks by workspace URL', () => {
      const service = REGISTRY.getByUrl(
        'https://dbc-12345678-abcd.cloud.databricks.com/ajax-api/2.0/clusters/list'
      );
      expect(service).not.toBeNull();
      expect(service?.name).toBe('databricks');
    });

    it('should find Databricks for different workspace URLs', () => {
      const service1 = REGISTRY.getByUrl(
        'https://adb-123456789.cloud.databricks.com/api/2.0/jobs/list'
      );
      const service2 = REGISTRY.getByUrl(
        'https://dbc-b28fe787-b68d.cloud.databricks.com/ajax-api/2.0/mlflow/experiments/list'
      );
      expect(service1?.name).toBe('databricks');
      expect(service2?.name).toBe('databricks');
    });
  });

  describe('isDatabricksUrl', () => {
    it('should match Databricks workspace URLs', () => {
      expect(isDatabricksUrl('https://dbc-12345678-abcd.cloud.databricks.com/api/2.0/clusters/list')).toBe(true);
      expect(isDatabricksUrl('https://adb-123456789.cloud.databricks.com/ajax-api/2.0/jobs/list')).toBe(true);
    });

    it('should not match non-Databricks URLs', () => {
      expect(isDatabricksUrl('https://example.com')).toBe(false);
      expect(isDatabricksUrl('https://databricks.com')).toBe(false);
      expect(isDatabricksUrl('https://cloud.databricks.com')).toBe(false);
    });

    it('should handle invalid URLs gracefully', () => {
      expect(isDatabricksUrl('not-a-url')).toBe(false);
      expect(isDatabricksUrl('')).toBe(false);
    });
  });

  describe('services', () => {
    it('should contain all services', () => {
      expect(REGISTRY.services).toHaveLength(5);
      expect(REGISTRY.services).toContain(SLACK);
      expect(REGISTRY.services).toContain(DISCORD);
      expect(REGISTRY.services).toContain(GITHUB);
      expect(REGISTRY.services).toContain(DROPBOX);
      expect(REGISTRY.services).toContain(LINEAR);
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
