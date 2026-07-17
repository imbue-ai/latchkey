/**
 * Shared Service test double.
 *
 * Service has protected members (the credential-check hooks), so plain object
 * literals can no longer satisfy the Service type; fakes must subclass it.
 * MockService exposes every configurable member as a public, writable field
 * with Slack-flavored defaults matching the historical inline fakes.
 */

import { vi } from 'vitest';
import { ApiCredentialStatus, type ApiCredentials } from '../src/apiCredentials/base.js';
import { SlackApiCredentials } from '../src/services/slack.js';
import { NoCurlCredentialsNotSupportedError, Service } from '../src/services/core/base.js';

export class MockService extends Service {
  name = 'slack';
  displayName = 'Slack';
  baseApiUrls: readonly (string | RegExp)[] = ['https://slack.com/api/'];
  loginUrl = 'https://slack.com/signin';
  info = 'Test info for Slack service.';
  credentialCheckCurlArguments: readonly string[] = ['https://slack.com/api/auth.test'];

  override checkApiCredentials: Service['checkApiCredentials'] = vi
    .fn()
    .mockResolvedValue({ status: ApiCredentialStatus.Valid, account: null });

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer xoxb-your-token"`;
  }

  override getCredentialsNoCurl(_arguments: readonly string[]): ApiCredentials {
    throw new NoCurlCredentialsNotSupportedError(this.name);
  }

  override getSession: Service['getSession'] = vi.fn().mockReturnValue({
    login: vi.fn().mockResolvedValue({
      credentials: new SlackApiCredentials('xoxc-test-token', 'test-cookie'),
      account: '',
    }),
  });
}

export function createMockService(overrides: Partial<MockService> = {}): MockService {
  return Object.assign(new MockService(), overrides);
}
