import { describe, it, expect } from 'vitest';
import {
  AuthorizationBearer,
  AuthorizationBare,
  SlackApiCredentials,
  RawCurlCredentials,
  deserializeCredentials,
  serializeCredentials,
  ApiCredentialsSchema,
} from '../src/apiCredentials.js';

describe('AuthorizationBearer', () => {
  it('should generate correct curl arguments', () => {
    const credentials = new AuthorizationBearer('test-token-123');
    expect(credentials.asCurlArguments()).toEqual(['-H', 'Authorization: Bearer test-token-123']);
  });

  it('should serialize to JSON', () => {
    const credentials = new AuthorizationBearer('test-token-123');
    expect(credentials.toJSON()).toEqual({
      objectType: 'authorizationBearer',
      token: 'test-token-123',
    });
  });

  it('should deserialize from JSON', () => {
    const data = {
      objectType: 'authorizationBearer' as const,
      token: 'test-token-123',
    };
    const credentials = AuthorizationBearer.fromJSON(data);
    expect(credentials.token).toBe('test-token-123');
  });
});

describe('AuthorizationBare', () => {
  it('should generate correct curl arguments', () => {
    const credentials = new AuthorizationBare('raw-token-456');
    expect(credentials.asCurlArguments()).toEqual(['-H', 'Authorization: raw-token-456']);
  });

  it('should serialize to JSON', () => {
    const credentials = new AuthorizationBare('raw-token-456');
    expect(credentials.toJSON()).toEqual({
      objectType: 'authorizationBare',
      token: 'raw-token-456',
    });
  });

  it('should deserialize from JSON', () => {
    const data = {
      objectType: 'authorizationBare' as const,
      token: 'raw-token-456',
    };
    const credentials = AuthorizationBare.fromJSON(data);
    expect(credentials.token).toBe('raw-token-456');
  });
});

describe('SlackApiCredentials', () => {
  it('should generate correct curl arguments with token and cookie', () => {
    const credentials = new SlackApiCredentials('xoxc-token', 'd-cookie-value');
    expect(credentials.asCurlArguments()).toEqual([
      '-H',
      'Authorization: Bearer xoxc-token',
      '-H',
      'Cookie: d=d-cookie-value',
    ]);
  });

  it('should serialize to JSON', () => {
    const credentials = new SlackApiCredentials('xoxc-token', 'd-cookie-value');
    expect(credentials.toJSON()).toEqual({
      objectType: 'slack',
      token: 'xoxc-token',
      dCookie: 'd-cookie-value',
    });
  });

  it('should deserialize from JSON', () => {
    const data = {
      objectType: 'slack' as const,
      token: 'xoxc-token',
      dCookie: 'd-cookie-value',
    };
    const credentials = SlackApiCredentials.fromJSON(data);
    expect(credentials.token).toBe('xoxc-token');
    expect(credentials.dCookie).toBe('d-cookie-value');
  });
});

describe('RawCurlCredentials', () => {
  it('should generate correct curl arguments', () => {
    const credentials = new RawCurlCredentials(['-H', 'X-Token: secret', '-H', 'X-Other: value']);
    expect(credentials.asCurlArguments()).toEqual([
      '-H',
      'X-Token: secret',
      '-H',
      'X-Other: value',
    ]);
  });

  it('should handle empty curl arguments', () => {
    const credentials = new RawCurlCredentials([]);
    expect(credentials.asCurlArguments()).toEqual([]);
  });

  it('should serialize to JSON', () => {
    const credentials = new RawCurlCredentials(['-H', 'X-Token: secret']);
    expect(credentials.toJSON()).toEqual({
      objectType: 'rawCurl',
      curlArguments: ['-H', 'X-Token: secret'],
    });
  });

  it('should deserialize from JSON', () => {
    const data = {
      objectType: 'rawCurl' as const,
      curlArguments: ['-H', 'X-Token: secret'],
    };
    const credentials = RawCurlCredentials.fromJSON(data);
    expect(credentials.curlArguments).toEqual(['-H', 'X-Token: secret']);
  });

  it('should return undefined for isExpired', () => {
    const credentials = new RawCurlCredentials(['-H', 'X-Token: secret']);
    expect(credentials.isExpired()).toBeUndefined();
  });
});

describe('deserializeCredentials', () => {
  it('should deserialize AuthorizationBearer', () => {
    const data = {
      objectType: 'authorizationBearer' as const,
      token: 'bearer-token',
    };
    const credentials = deserializeCredentials(data);
    expect(credentials).toBeInstanceOf(AuthorizationBearer);
    expect((credentials as AuthorizationBearer).token).toBe('bearer-token');
  });

  it('should deserialize AuthorizationBare', () => {
    const data = {
      objectType: 'authorizationBare' as const,
      token: 'bare-token',
    };
    const credentials = deserializeCredentials(data);
    expect(credentials).toBeInstanceOf(AuthorizationBare);
    expect((credentials as AuthorizationBare).token).toBe('bare-token');
  });

  it('should deserialize SlackApiCredentials', () => {
    const data = {
      objectType: 'slack' as const,
      token: 'slack-token',
      dCookie: 'slack-cookie',
    };
    const credentials = deserializeCredentials(data);
    expect(credentials).toBeInstanceOf(SlackApiCredentials);
    expect((credentials as SlackApiCredentials).token).toBe('slack-token');
    expect((credentials as SlackApiCredentials).dCookie).toBe('slack-cookie');
  });

  it('should deserialize RawCurlCredentials', () => {
    const data = {
      objectType: 'rawCurl' as const,
      curlArguments: ['-H', 'X-Token: test'],
    };
    const credentials = deserializeCredentials(data);
    expect(credentials).toBeInstanceOf(RawCurlCredentials);
    expect((credentials as RawCurlCredentials).curlArguments).toEqual(['-H', 'X-Token: test']);
  });
});

describe('serializeCredentials', () => {
  it('should serialize AuthorizationBearer', () => {
    const credentials = new AuthorizationBearer('test-token');
    const data = serializeCredentials(credentials);
    expect(data).toEqual({
      objectType: 'authorizationBearer',
      token: 'test-token',
    });
  });

  it('should serialize AuthorizationBare', () => {
    const credentials = new AuthorizationBare('test-token');
    const data = serializeCredentials(credentials);
    expect(data).toEqual({
      objectType: 'authorizationBare',
      token: 'test-token',
    });
  });

  it('should serialize SlackApiCredentials', () => {
    const credentials = new SlackApiCredentials('token', 'cookie');
    const data = serializeCredentials(credentials);
    expect(data).toEqual({
      objectType: 'slack',
      token: 'token',
      dCookie: 'cookie',
    });
  });

  it('should serialize RawCurlCredentials', () => {
    const credentials = new RawCurlCredentials(['-H', 'X-Token: test']);
    const data = serializeCredentials(credentials);
    expect(data).toEqual({
      objectType: 'rawCurl',
      curlArguments: ['-H', 'X-Token: test'],
    });
  });
});

describe('ApiCredentialsSchema', () => {
  it('should validate AuthorizationBearer', () => {
    const result = ApiCredentialsSchema.safeParse({
      objectType: 'authorizationBearer',
      token: 'test',
    });
    expect(result.success).toBe(true);
  });

  it('should validate AuthorizationBare', () => {
    const result = ApiCredentialsSchema.safeParse({
      objectType: 'authorizationBare',
      token: 'test',
    });
    expect(result.success).toBe(true);
  });

  it('should validate SlackApiCredentials', () => {
    const result = ApiCredentialsSchema.safeParse({
      objectType: 'slack',
      token: 'test',
      dCookie: 'cookie',
    });
    expect(result.success).toBe(true);
  });

  it('should validate RawCurlCredentials', () => {
    const result = ApiCredentialsSchema.safeParse({
      objectType: 'rawCurl',
      curlArguments: ['-H', 'X-Token: test'],
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid object type', () => {
    const result = ApiCredentialsSchema.safeParse({
      objectType: 'invalid',
      token: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing token', () => {
    const result = ApiCredentialsSchema.safeParse({
      objectType: 'authorizationBearer',
    });
    expect(result.success).toBe(false);
  });
});
