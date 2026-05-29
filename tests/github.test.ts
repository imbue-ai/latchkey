import { describe, it, expect } from 'vitest';
import {
  GITHUB,
  GithubTokenBasicAuth,
  UnexpectedGithubCredentialsError,
} from '../src/services/github.js';
import { AuthorizationBearer, RawCurlCredentials } from '../src/apiCredentials/base.js';
import { SERVICE_REGISTRY } from '../src/serviceRegistry.js';

describe('Github URL matching', () => {
  it('matches the REST API host', () => {
    expect(SERVICE_REGISTRY.getByUrl('https://api.github.com/user')).toBe(GITHUB);
    expect(SERVICE_REGISTRY.getByUrl('https://uploads.github.com/anything')).toBe(GITHUB);
  });

  it('matches repository URLs', () => {
    expect(SERVICE_REGISTRY.getByUrl('https://github.com/owner/repo')).toBe(GITHUB);
    expect(
      SERVICE_REGISTRY.getByUrl(
        'https://github.com/owner/repo.git/info/refs?service=git-upload-pack'
      )
    ).toBe(GITHUB);
  });

  it('does not match website routes or single-segment paths', () => {
    expect(SERVICE_REGISTRY.getByUrl('https://github.com/settings/tokens')).toBeNull();
    expect(SERVICE_REGISTRY.getByUrl('https://github.com/orgs/some-org')).toBeNull();
    expect(SERVICE_REGISTRY.getByUrl('https://github.com/owner')).toBeNull();
    expect(SERVICE_REGISTRY.getByUrl('https://example.com/owner/repo')).toBeNull();
  });
});

describe('Github.adjustCredentials', () => {
  it('leaves API credentials untouched', () => {
    const bearer = new AuthorizationBearer('token-123');
    const adjusted = GITHUB.adjustCredentials(bearer, 'https://api.github.com/user');
    expect(adjusted).toBe(bearer);
  });

  it('converts bearer credentials to basic auth for repository URLs', async () => {
    const bearer = new AuthorizationBearer('token-123');
    const adjusted = GITHUB.adjustCredentials(bearer, 'https://github.com/owner/repo.git/info/refs');
    expect(adjusted).toBeInstanceOf(GithubTokenBasicAuth);

    const args = await adjusted.injectIntoCurlCall(['https://github.com/owner/repo.git']);
    expect(args).toEqual(['-u', 'x-access-token:token-123', 'https://github.com/owner/repo.git']);
  });

  it('throws when repository credentials are not bearer credentials', () => {
    const raw = new RawCurlCredentials(['-H', 'X-Custom: 1']);
    expect(() => GITHUB.adjustCredentials(raw, 'https://github.com/owner/repo')).toThrow(
      UnexpectedGithubCredentialsError
    );
  });
});
