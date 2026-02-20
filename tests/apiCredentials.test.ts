import { describe, it, expect } from 'vitest';
import {
  AuthorizationBearer,
  AuthorizationBare,
  RawCurlCredentials,
} from '../src/apiCredentials.js';
import {
  deserializeCredentials,
  serializeCredentials,
  ApiCredentialsSchema,
} from '../src/apiCredentialsSerialization.js';
import { SlackApiCredentials } from '../src/services/slack.js';
import { TelegramBotCredentials } from '../src/services/telegram.js';
import { AwsCredentials } from '../src/services/aws.js';
import { GoogleApiKeyCredentials } from '../src/services/google/base.js';

describe('AuthorizationBearer', () => {
  it('should inject Bearer token header', () => {
    const credentials = new AuthorizationBearer('test-token-123');
    expect(credentials.injectIntoCurlCall([])).toEqual([
      '-H',
      'Authorization: Bearer test-token-123',
    ]);
  });
});

describe('AuthorizationBare', () => {
  it('should inject raw Authorization header', () => {
    const credentials = new AuthorizationBare('raw-token-456');
    expect(credentials.injectIntoCurlCall([])).toEqual(['-H', 'Authorization: raw-token-456']);
  });
});

describe('SlackApiCredentials', () => {
  it('should inject token and cookie headers', () => {
    const credentials = new SlackApiCredentials('xoxc-token', 'd-cookie-value');
    expect(credentials.injectIntoCurlCall([])).toEqual([
      '-H',
      'Authorization: Bearer xoxc-token',
      '-H',
      'Cookie: d=d-cookie-value',
    ]);
  });
});

describe('RawCurlCredentials', () => {
  it('should inject raw curl arguments', () => {
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
});

describe('TelegramBotCredentials', () => {
  it('should inject token into telegram API URL path', () => {
    const credentials = new TelegramBotCredentials('123456:ABC-DEF');
    expect(credentials.injectIntoCurlCall(['https://api.telegram.org/getMe'])).toEqual([
      'https://api.telegram.org/bot123456:ABC-DEF/getMe',
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
});

describe('GoogleApiKeyCredentials', () => {
  it('should inject X-Goog-Api-Key header for googleapis.com URLs', () => {
    const credentials = new GoogleApiKeyCredentials('AIzaSyTestKey123');
    expect(
      credentials.injectIntoCurlCall(['https://routes.googleapis.com/directions/v2:computeRoutes'])
    ).toEqual([
      '-H',
      'X-Goog-Api-Key: AIzaSyTestKey123',
      'https://routes.googleapis.com/directions/v2:computeRoutes',
    ]);
  });

  it('should not modify non-googleapis.com URLs', () => {
    const credentials = new GoogleApiKeyCredentials('AIzaSyTestKey123');
    expect(
      credentials.injectIntoCurlCall([
        '-H',
        'Content-Type: application/json',
        'https://other.example.com/api',
      ])
    ).toEqual(['-H', 'Content-Type: application/json', 'https://other.example.com/api']);
  });
});

describe('AwsCredentials', () => {
  it('should inject Authorization, x-amz-date, and x-amz-content-sha256 headers', () => {
    const credentials = new AwsCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG');
    const result = credentials.injectIntoCurlCall([
      'https://sts.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15',
    ]);
    const resultStrings = result as string[];
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

  it('should pass through arguments unchanged when no URL is present', () => {
    const credentials = new AwsCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG');
    const result = credentials.injectIntoCurlCall(['-v']);
    expect(result).toEqual(['-v']);
  });
});

describe('serialization roundtrip', () => {
  const cases: {
    name: string;
    credentials: () => import('../src/apiCredentials.js').ApiCredentials;
  }[] = [
    { name: 'AuthorizationBearer', credentials: () => new AuthorizationBearer('test-token') },
    { name: 'AuthorizationBare', credentials: () => new AuthorizationBare('test-token') },
    {
      name: 'SlackApiCredentials',
      credentials: () => new SlackApiCredentials('token', 'cookie'),
    },
    {
      name: 'RawCurlCredentials',
      credentials: () => new RawCurlCredentials(['-H', 'X-Token: test']),
    },
    {
      name: 'TelegramBotCredentials',
      credentials: () => new TelegramBotCredentials('123456:ABC-DEF'),
    },
    {
      name: 'AwsCredentials',
      credentials: () => new AwsCredentials('AKIAIOSFODNN7EXAMPLE', 'secret123'),
    },
    {
      name: 'GoogleApiKeyCredentials',
      credentials: () => new GoogleApiKeyCredentials('AIzaSyTestKey123'),
    },
  ];

  for (const { name, credentials: createCredentials } of cases) {
    it(`should roundtrip ${name} through serialize/deserialize`, () => {
      const original = createCredentials();
      const serialized = serializeCredentials(original);
      const deserialized = deserializeCredentials(serialized);
      expect(deserialized).toBeInstanceOf(original.constructor);
      expect(serializeCredentials(deserialized)).toEqual(serialized);
    });

    it(`should validate ${name} with ApiCredentialsSchema`, () => {
      const original = createCredentials();
      const serialized = serializeCredentials(original);
      expect(ApiCredentialsSchema.safeParse(serialized).success).toBe(true);
    });
  }

  it('should reject invalid object type', () => {
    const result = ApiCredentialsSchema.safeParse({
      objectType: 'invalid',
      token: 'test',
    });
    expect(result.success).toBe(false);
  });
});
