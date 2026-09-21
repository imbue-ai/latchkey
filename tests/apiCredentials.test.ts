import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  type ApiCredentials,
  AuthorizationBearer,
  AuthorizationBare,
  RawCurlCredentials,
} from '../src/apiCredentials/base.js';
import {
  ApiCredentialsSerializationError,
  BUILTIN_API_CREDENTIALS_TYPES,
  deserializeCredentials,
  serializeCredentials,
} from '../src/apiCredentials/serialization.js';
import { SlackApiCredentials } from '../src/services/slack.js';
import { TelegramBotCredentials } from '../src/services/telegram.js';
import {
  AwsCredentials,
  AwsRequestBodyNotAvailableError,
  AwsRequestBodyNotSignableError,
} from '../src/services/aws.js';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoogleApiKeyCredentials } from '../src/services/google/base.js';
import { ZoomServerToServerCredentials } from '../src/services/zoom.js';

describe('AuthorizationBearer', () => {
  it('should inject Bearer token header', async () => {
    const credentials = new AuthorizationBearer('test-token-123');
    await expect(credentials.injectIntoCurlCall([])).resolves.toEqual([
      '-H',
      'Authorization: Bearer test-token-123',
    ]);
  });
});

describe('AuthorizationBare', () => {
  it('should inject raw Authorization header', async () => {
    const credentials = new AuthorizationBare('raw-token-456');
    await expect(credentials.injectIntoCurlCall([])).resolves.toEqual([
      '-H',
      'Authorization: raw-token-456',
    ]);
  });
});

describe('SlackApiCredentials', () => {
  it('should inject token and cookie headers', async () => {
    const credentials = new SlackApiCredentials('xoxc-token', 'd-cookie-value');
    await expect(credentials.injectIntoCurlCall([])).resolves.toEqual([
      '-H',
      'Authorization: Bearer xoxc-token',
      '-H',
      'Cookie: d=d-cookie-value',
    ]);
  });
});

describe('RawCurlCredentials', () => {
  it('should inject raw curl arguments', async () => {
    const credentials = new RawCurlCredentials(['-H', 'X-Token: secret', '-H', 'X-Other: value']);
    await expect(credentials.injectIntoCurlCall([])).resolves.toEqual([
      '-H',
      'X-Token: secret',
      '-H',
      'X-Other: value',
    ]);
  });

  it('should handle empty curl arguments', async () => {
    const credentials = new RawCurlCredentials([]);
    await expect(credentials.injectIntoCurlCall([])).resolves.toEqual([]);
  });
});

describe('TelegramBotCredentials', () => {
  it('should inject token into telegram API URL path', async () => {
    const credentials = new TelegramBotCredentials('123456:ABC-DEF');
    await expect(
      credentials.injectIntoCurlCall(['https://api.telegram.org/getMe'])
    ).resolves.toEqual(['https://api.telegram.org/bot123456:ABC-DEF/getMe']);
  });

  it('should not modify non-telegram URLs', async () => {
    const credentials = new TelegramBotCredentials('123456:ABC-DEF');
    await expect(
      credentials.injectIntoCurlCall([
        '-H',
        'Content-Type: application/json',
        'https://other.example.com/api',
      ])
    ).resolves.toEqual(['-H', 'Content-Type: application/json', 'https://other.example.com/api']);
  });

  it('should preserve other curl arguments', async () => {
    const credentials = new TelegramBotCredentials('123456:ABC-DEF');
    await expect(
      credentials.injectIntoCurlCall(['-X', 'POST', 'https://api.telegram.org/getMe'])
    ).resolves.toEqual(['-X', 'POST', 'https://api.telegram.org/bot123456:ABC-DEF/getMe']);
  });
});

describe('GoogleApiKeyCredentials', () => {
  it('should inject X-Goog-Api-Key header for googleapis.com URLs', async () => {
    const credentials = new GoogleApiKeyCredentials('AIzaSyTestKey123');
    await expect(
      credentials.injectIntoCurlCall(['https://routes.googleapis.com/directions/v2:computeRoutes'])
    ).resolves.toEqual([
      '-H',
      'X-Goog-Api-Key: AIzaSyTestKey123',
      'https://routes.googleapis.com/directions/v2:computeRoutes',
    ]);
  });

  it('should not modify non-googleapis.com URLs', async () => {
    const credentials = new GoogleApiKeyCredentials('AIzaSyTestKey123');
    await expect(
      credentials.injectIntoCurlCall([
        '-H',
        'Content-Type: application/json',
        'https://other.example.com/api',
      ])
    ).resolves.toEqual(['-H', 'Content-Type: application/json', 'https://other.example.com/api']);
  });
});

describe('AwsCredentials', () => {
  it('should inject Authorization, x-amz-date, and x-amz-content-sha256 headers', async () => {
    const credentials = new AwsCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG');
    const result = await credentials.injectIntoCurlCall([
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

  it('should include content-type in signed headers when present', async () => {
    const credentials = new AwsCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG');
    const result = await credentials.injectIntoCurlCall([
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

  it('should sign S3 virtual-hosted-style URLs with default region', async () => {
    const credentials = new AwsCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG');
    const result = await credentials.injectIntoCurlCall([
      'https://test-int8-transient.s3.amazonaws.com/',
    ]);
    const resultStrings = result as string[];
    const authHeader = resultStrings[1]!;
    // Credential scope must contain us-east-1/s3, not s3/test-int8-transient
    expect(authHeader).toMatch(/Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/s3\//);
  });

  it('should sign S3 virtual-hosted-style URLs with explicit region', async () => {
    const credentials = new AwsCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG');
    const result = await credentials.injectIntoCurlCall([
      'https://test-int8-transient.s3.us-west-2.amazonaws.com/',
    ]);
    const resultStrings = result as string[];
    const authHeader = resultStrings[1]!;
    expect(authHeader).toMatch(/Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-west-2\/s3\//);
  });

  it('should pass through arguments unchanged when no URL is present', async () => {
    const credentials = new AwsCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG');
    const result = await credentials.injectIntoCurlCall(['-v']);
    expect(result).toEqual(['-v']);
  });

  it('should sign the out-of-band body instead of the @- placeholder', async () => {
    const credentials = new AwsCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG');
    const body = '{"logGroupName":"/aws/lambda/test"}';
    const curlArguments = [
      '-X',
      'POST',
      '-H',
      'Content-Type: application/x-amz-json-1.1',
      '--data-binary',
      '@-',
      'https://logs.us-east-1.amazonaws.com/',
    ];

    const result = (await credentials.injectIntoCurlCall(
      curlArguments,
      Buffer.from(body, 'utf-8')
    )) as string[];

    const payloadHashHeader = result.find((argument) =>
      argument.startsWith('x-amz-content-sha256: ')
    );
    const expectedHash = createHash('sha256').update(body, 'utf-8').digest('hex');
    expect(payloadHashHeader).toBe(`x-amz-content-sha256: ${expectedHash}`);
    expect(payloadHashHeader).not.toBe(
      `x-amz-content-sha256: ${createHash('sha256').update('@-', 'utf-8').digest('hex')}`
    );
  });

  it('should read a @file body reference when signing', async () => {
    const credentials = new AwsCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG');
    const body = '{"limit":10}';
    const bodyFile = join(mkdtempSync(join(tmpdir(), 'latchkey-aws-')), 'body.json');
    writeFileSync(bodyFile, body);

    const result = (await credentials.injectIntoCurlCall([
      '-X',
      'POST',
      '--data-binary',
      `@${bodyFile}`,
      'https://logs.us-east-1.amazonaws.com/',
    ])) as string[];

    const expectedHash = createHash('sha256').update(body, 'utf-8').digest('hex');
    expect(result).toContain(`x-amz-content-sha256: ${expectedHash}`);
  });

  it('should report a clear error when the body only exists on curl stdin', async () => {
    const credentials = new AwsCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG');

    await expect(
      credentials.injectIntoCurlCall([
        '-X',
        'POST',
        '--data-binary',
        '@-',
        'https://logs.us-east-1.amazonaws.com/',
      ])
    ).rejects.toBeInstanceOf(AwsRequestBodyNotAvailableError);
  });

  it('should refuse to sign bodies curl assembles from several data arguments', async () => {
    const credentials = new AwsCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG');
    const bodyFile = join(mkdtempSync(join(tmpdir(), 'latchkey-aws-')), 'body.json');
    writeFileSync(bodyFile, '{"limit":10}');

    await expect(
      credentials.injectIntoCurlCall([
        '-X',
        'POST',
        '-d',
        `@${bodyFile}`,
        '-d',
        'extra=1',
        'https://logs.us-east-1.amazonaws.com/',
      ])
    ).rejects.toBeInstanceOf(AwsRequestBodyNotSignableError);

    await expect(
      credentials.injectIntoCurlCall([
        '-X',
        'POST',
        '--data-urlencode',
        `@${bodyFile}`,
        'https://logs.us-east-1.amazonaws.com/',
      ])
    ).rejects.toBeInstanceOf(AwsRequestBodyNotSignableError);
  });

  it('should sign x-amz-* headers supplied by the caller', async () => {
    const credentials = new AwsCredentials('AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG');

    const result = (await credentials.injectIntoCurlCall(
      [
        '-X',
        'POST',
        '-H',
        'Content-Type: application/x-amz-json-1.1',
        '-H',
        'X-Amz-Target: Logs_20140328.DescribeLogGroups',
        '--data-binary',
        '@-',
        'https://logs.us-east-1.amazonaws.com/',
      ],
      Buffer.from('{}', 'utf-8')
    )) as string[];

    expect(result[1]).toContain(
      'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-target'
    );
  });
});

describe('serialization roundtrip', () => {
  const cases: {
    name: string;
    credentials: () => import('../src/apiCredentials/base.js').ApiCredentials;
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
    {
      name: 'ZoomServerToServerCredentials',
      credentials: () =>
        new ZoomServerToServerCredentials(
          'account-id',
          'client-id',
          'client-secret',
          'access-token',
          new Date(Date.now() + 3600_000).toISOString()
        ),
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
  }

  it('should reject data of an unknown object type', () => {
    expect(() => deserializeCredentials({ objectType: 'invalid', token: 'test' })).toThrow(
      new ApiCredentialsSerializationError(
        "Unknown credential type 'invalid'. Credentials of a type defined by a plugin " +
          'can only be used while that plugin is installed.'
      )
    );
  });

  it('should reject data without an object type', () => {
    expect(() => deserializeCredentials({ token: 'test' })).toThrow(
      ApiCredentialsSerializationError
    );
  });

  it('should reject data that does not match the schema of its object type', () => {
    expect(() => deserializeCredentials({ objectType: 'authorizationBearer' })).toThrow(
      /Invalid 'authorizationBearer' credential data/
    );
  });

  it('should refuse to serialize credentials that are never stored', () => {
    const transient: ApiCredentials = {
      objectType: 'transient',
      injectIntoCurlCall: (curlArguments) => Promise.resolve(curlArguments),
      isExpired: () => undefined,
    };
    expect(() => serializeCredentials(transient)).toThrow(
      "Credentials of type 'transient' are never stored."
    );
  });

  describe('with a custom credentials type', () => {
    const CustomCredentialsSchema = z.object({
      objectType: z.literal('custom'),
      secret: z.string(),
    });

    class CustomCredentials implements ApiCredentials {
      static readonly objectType = 'custom' as const;
      readonly objectType = CustomCredentials.objectType;

      constructor(readonly secret: string) {}

      static fromJSON(data: unknown): CustomCredentials {
        return new CustomCredentials(CustomCredentialsSchema.parse(data).secret);
      }

      injectIntoCurlCall(curlArguments: readonly string[]): Promise<readonly string[]> {
        return Promise.resolve(['-H', `X-Secret: ${this.secret}`, ...curlArguments]);
      }

      isExpired(): undefined {
        return undefined;
      }

      toJSON(): z.infer<typeof CustomCredentialsSchema> {
        return { objectType: this.objectType, secret: this.secret };
      }
    }

    const apiCredentialsTypes = [...BUILTIN_API_CREDENTIALS_TYPES, CustomCredentials];

    it('round-trips through serialize and deserialize when the type is known', () => {
      const serialized = serializeCredentials(new CustomCredentials('s3cret'), apiCredentialsTypes);
      const restored = deserializeCredentials(serialized, apiCredentialsTypes);
      expect(restored).toBeInstanceOf(CustomCredentials);
      expect((restored as CustomCredentials).secret).toBe('s3cret');
    });

    it('refuses to serialize credentials whose type is not registered', () => {
      expect(() => serializeCredentials(new CustomCredentials('s3cret'))).toThrow(
        "Unknown credential type 'custom'. A plugin defining its own credentials class " +
          "has to list its type in 'apiCredentialsTypes'."
      );
    });

    it('still reads the built-in types', () => {
      const restored = deserializeCredentials(
        serializeCredentials(new AuthorizationBearer('t')),
        apiCredentialsTypes
      );
      expect(restored).toBeInstanceOf(AuthorizationBearer);
    });
  });
});
