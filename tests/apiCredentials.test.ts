import { describe, it, expect } from 'vitest';
import {
  AuthorizationBearer,
  AuthorizationBare,
  SlackApiCredentials,
  RawCurlCredentials,
  TelegramBotCredentials,
  AwsCredentials,
  deserializeCredentials,
  serializeCredentials,
  ApiCredentialsSchema,
} from '../src/apiCredentials.js';

describe('AuthorizationBearer', () => {
  it('should inject correct curl arguments', () => {
    const credentials = new AuthorizationBearer('test-token-123');
    expect(credentials.injectIntoCurlCall([])).toEqual([
      '-H',
      'Authorization: Bearer test-token-123',
    ]);
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
  it('should inject correct curl arguments', () => {
    const credentials = new AuthorizationBare('raw-token-456');
    expect(credentials.injectIntoCurlCall([])).toEqual(['-H', 'Authorization: raw-token-456']);
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
  it('should inject correct curl arguments with token and cookie', () => {
    const credentials = new SlackApiCredentials('xoxc-token', 'd-cookie-value');
    expect(credentials.injectIntoCurlCall([])).toEqual([
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
  it('should inject correct curl arguments', () => {
    const credentials = new RawCurlCredentials(['-H', 'X-Token: secret', '-H', 'X-Other: value']);
    expect(credentials.injectIntoCurlCall([])).toEqual([
      '-H',
      'X-Token: secret',
      '-H',
      'X-Other: value',
    ]);
  });

  it('should handle empty curl arguments', () => {
    const credentials = new RawCurlCredentials([]);
    expect(credentials.injectIntoCurlCall([])).toEqual([]);
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

describe('TelegramBotCredentials', () => {
  it('should inject token into telegram API URL path', () => {
    const credentials = new TelegramBotCredentials('123456:ABC-DEF');
    expect(credentials.injectIntoCurlCall(['https://api.telegram.org/getMe'])).toEqual([
      'https://api.telegram.org/bot123456:ABC-DEF/getMe',
    ]);
  });

  it('should inject token into URL with nested path', () => {
    const credentials = new TelegramBotCredentials('123456:ABC-DEF');
    expect(credentials.injectIntoCurlCall(['https://api.telegram.org/sendMessage'])).toEqual([
      'https://api.telegram.org/bot123456:ABC-DEF/sendMessage',
    ]);
  });

  it('should not modify non-telegram URLs', () => {
    const credentials = new TelegramBotCredentials('123456:ABC-DEF');
    expect(
      credentials.injectIntoCurlCall([
        '-H',
        'Content-Type: application/json',
        'https://other.example.com/api',
      ])
    ).toEqual(['-H', 'Content-Type: application/json', 'https://other.example.com/api']);
  });

  it('should preserve other curl arguments', () => {
    const credentials = new TelegramBotCredentials('123456:ABC-DEF');
    expect(
      credentials.injectIntoCurlCall(['-X', 'POST', 'https://api.telegram.org/getMe'])
    ).toEqual(['-X', 'POST', 'https://api.telegram.org/bot123456:ABC-DEF/getMe']);
  });

  it('should serialize to JSON', () => {
    const credentials = new TelegramBotCredentials('123456:ABC-DEF');
    expect(credentials.toJSON()).toEqual({
      objectType: 'telegramBot',
      token: '123456:ABC-DEF',
    });
  });

  it('should deserialize from JSON', () => {
    const data = {
      objectType: 'telegramBot' as const,
      token: '123456:ABC-DEF',
    };
    const credentials = TelegramBotCredentials.fromJSON(data);
    expect(credentials.token).toBe('123456:ABC-DEF');
  });

  it('should return undefined for isExpired', () => {
    const credentials = new TelegramBotCredentials('123456:ABC-DEF');
    expect(credentials.isExpired()).toBeUndefined();
  });
});

describe('AwsCredentials', () => {
  it('should inject Authorization, x-amz-date, and x-amz-content-sha256 headers', () => {
    const credentials = new AwsCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG');
    const result = credentials.injectIntoCurlCall([
      'https://sts.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15',
    ]);
    const resultStrings = result as string[];
    // Should have the original URL plus 6 new arguments (3 header pairs)
    expect(resultStrings).toHaveLength(7);
    expect(resultStrings[0]).toBe('-H');
    expect(resultStrings[1]).toMatch(
      /^Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//
    );
    expect(resultStrings[2]).toBe('-H');
    expect(resultStrings[3]).toMatch(/^x-amz-date: \d{8}T\d{6}Z$/);
    expect(resultStrings[4]).toBe('-H');
    expect(resultStrings[5]).toMatch(/^x-amz-content-sha256: [a-f0-9]{64}$/);
    expect(resultStrings[6]).toBe(
      'https://sts.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15'
    );
  });

  it('should preserve existing curl arguments', () => {
    const credentials = new AwsCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG');
    const result = credentials.injectIntoCurlCall([
      '-X',
      'POST',
      '-d',
      '{"key": "value"}',
      'https://s3.us-east-1.amazonaws.com/bucket/key',
    ]);
    const resultStrings = result as string[];
    // Signing headers (6) + original args (5)
    expect(resultStrings).toHaveLength(11);
    expect(resultStrings.slice(6)).toEqual([
      '-X',
      'POST',
      '-d',
      '{"key": "value"}',
      'https://s3.us-east-1.amazonaws.com/bucket/key',
    ]);
  });

  it('should pass through arguments unchanged when no URL is present', () => {
    const credentials = new AwsCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG');
    const result = credentials.injectIntoCurlCall(['-v']);
    expect(result).toEqual(['-v']);
  });

  it('should include content-type in signed headers when present', () => {
    const credentials = new AwsCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG');
    const result = credentials.injectIntoCurlCall([
      '-H',
      'Content-Type: application/json',
      '-d',
      '{}',
      'https://lambda.us-east-1.amazonaws.com/2015-03-31/functions',
    ]);
    const resultStrings = result as string[];
    const authHeader = resultStrings[1]!;
    expect(authHeader).toContain('SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date');
  });

  it('should serialize to JSON', () => {
    const credentials = new AwsCredentials('AKIAIOSFODNN7EXAMPLE', 'secret123');
    expect(credentials.toJSON()).toEqual({
      objectType: 'aws',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'secret123',
    });
  });

  it('should deserialize from JSON', () => {
    const data = {
      objectType: 'aws' as const,
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'secret123',
    };
    const credentials = AwsCredentials.fromJSON(data);
    expect(credentials.accessKeyId).toBe('AKIAIOSFODNN7EXAMPLE');
    expect(credentials.secretAccessKey).toBe('secret123');
  });

  it('should return undefined for isExpired', () => {
    const credentials = new AwsCredentials('AKIAIOSFODNN7EXAMPLE', 'secret123');
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

  it('should deserialize TelegramBotCredentials', () => {
    const data = {
      objectType: 'telegramBot' as const,
      token: '123456:ABC-DEF',
    };
    const credentials = deserializeCredentials(data);
    expect(credentials).toBeInstanceOf(TelegramBotCredentials);
    expect((credentials as TelegramBotCredentials).token).toBe('123456:ABC-DEF');
  });

  it('should deserialize AwsCredentials', () => {
    const data = {
      objectType: 'aws' as const,
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'secret123',
    };
    const credentials = deserializeCredentials(data);
    expect(credentials).toBeInstanceOf(AwsCredentials);
    expect((credentials as AwsCredentials).accessKeyId).toBe('AKIAIOSFODNN7EXAMPLE');
    expect((credentials as AwsCredentials).secretAccessKey).toBe('secret123');
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

  it('should serialize TelegramBotCredentials', () => {
    const credentials = new TelegramBotCredentials('123456:ABC-DEF');
    const data = serializeCredentials(credentials);
    expect(data).toEqual({
      objectType: 'telegramBot',
      token: '123456:ABC-DEF',
    });
  });

  it('should serialize AwsCredentials', () => {
    const credentials = new AwsCredentials('AKIAIOSFODNN7EXAMPLE', 'secret123');
    const data = serializeCredentials(credentials);
    expect(data).toEqual({
      objectType: 'aws',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'secret123',
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

  it('should validate TelegramBotCredentials', () => {
    const result = ApiCredentialsSchema.safeParse({
      objectType: 'telegramBot',
      token: '123456:ABC-DEF',
    });
    expect(result.success).toBe(true);
  });

  it('should validate AwsCredentials', () => {
    const result = ApiCredentialsSchema.safeParse({
      objectType: 'aws',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'secret',
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
