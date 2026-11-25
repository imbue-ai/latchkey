import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountNotStoredError,
  AmbiguousAccountError,
  BrowserStateNotFoundError,
  clearCredentials,
  Config,
  createLatchkeyRuntime,
  DestinationCredentialsUnreadableError,
  DestinationDataFormatError,
  DestinationNotADirectoryError,
  EncryptedStorage,
  EncryptedStorageError,
  generateKey,
  InvalidDestinationKeyError,
  MigrationError,
  NothingToReencryptError,
  reencryptCredentials,
  ReencryptCredentialsError,
  ServicesNotStoredError,
  SourceCredentialsUnreadableError,
  UnknownServiceError,
  type ApiCredentialsType,
  type LatchkeyRuntime,
  type ReencryptCredentialsOptions,
  type ReencryptCredentialsResult,
} from '../src/embed.js';
import {
  resetAsyncSubprocessRunner,
  resetCurlCommand,
  setAsyncSubprocessRunner,
} from '../src/curl.js';
import { LATEST_VERSION } from '../src/migrations.js';
import { resetClaimedCurlCommand } from '../src/runtime.js';

const DATA_FORMAT_VERSION_FILENAME = 'data-format-version';

type SerializedCredentials = Readonly<Record<string, unknown>>;

interface StoreContents {
  readonly credentials?: Readonly<Record<string, Readonly<Record<string, SerializedCredentials>>>>;
  readonly preparations?: Readonly<Record<string, SerializedCredentials>>;
}

function rawCurl(token: string): SerializedCredentials {
  return { objectType: 'rawCurl', curlArguments: ['-H', `X-Token: ${token}`] };
}

function oauthClient(clientId: string): SerializedCredentials {
  return { objectType: 'oauth', clientId, clientSecret: `${clientId}-secret` };
}

/** Where a bare Latchkey directory keeps its files. */
function pathsOf(directory: string): Config {
  return new Config(
    (name) => (name === 'LATCHKEY_DIRECTORY' ? directory : undefined),
    () => ({})
  );
}

function stampDataFormat(directory: string, content: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, DATA_FORMAT_VERSION_FILENAME), content, 'utf-8');
}

function readDataFormatStamp(directory: string): string | null {
  const stampPath = join(directory, DATA_FORMAT_VERSION_FILENAME);
  return existsSync(stampPath) ? readFileSync(stampPath, 'utf-8') : null;
}

/** Write a store in the newest data format, stamped as such. */
function writeStore(directory: string, encryptionKey: string, contents: StoreContents): void {
  new EncryptedStorage(encryptionKey).writeFile(
    pathsOf(directory).credentialStorePath,
    JSON.stringify({
      credentials: contents.credentials ?? {},
      preparations: contents.preparations ?? {},
    })
  );
  stampDataFormat(directory, String(LATEST_VERSION));
}

function readStore(directory: string, encryptionKey: string): Required<StoreContents> {
  const content = new EncryptedStorage(encryptionKey).readFile(
    pathsOf(directory).credentialStorePath
  );
  const parsed = JSON.parse(content ?? '{}') as StoreContents;
  return { credentials: parsed.credentials ?? {}, preparations: parsed.preparations ?? {} };
}

function createRuntime(directory: string, encryptionKey: string): Promise<LatchkeyRuntime> {
  return createLatchkeyRuntime({
    directory,
    encryptionKey,
    log: () => undefined,
    errorLog: () => undefined,
  });
}

describe('credential operations', () => {
  let temporaryDirectory: string;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'latchkey-credential-operations-'));
  });

  afterEach(() => {
    resetAsyncSubprocessRunner();
    resetClaimedCurlCommand();
    resetCurlCommand();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  describe('clearCredentials', () => {
    const SLACK_PREPARATION = oauthClient('slack-client');

    let directory: string;
    let encryptionKey: string;
    let runtime: LatchkeyRuntime;

    beforeEach(async () => {
      directory = join(temporaryDirectory, 'latchkey');
      encryptionKey = generateKey();
      runtime = await createRuntime(directory, encryptionKey);
    });

    it('deletes the named account and leaves the other accounts and the preparation', () => {
      writeStore(directory, encryptionKey, {
        credentials: { slack: { 'a@example.com': rawCurl('a'), 'b@example.com': rawCurl('b') } },
        preparations: { slack: SLACK_PREPARATION },
      });

      const isDeleted = clearCredentials(runtime, 'slack', {
        kind: 'account',
        account: 'a@example.com',
      });

      expect(isDeleted).toBe(true);
      expect(readStore(directory, encryptionKey)).toEqual({
        credentials: { slack: { 'b@example.com': rawCurl('b') } },
        preparations: { slack: SLACK_PREPARATION },
      });
    });

    it('deletes the only account of the service when none is named, and leaves the preparation', () => {
      writeStore(directory, encryptionKey, {
        credentials: {
          slack: { 'a@example.com': rawCurl('a') },
          discord: { '': rawCurl('discord') },
        },
        preparations: { slack: SLACK_PREPARATION },
      });

      const isDeleted = clearCredentials(runtime, 'slack', { kind: 'account' });

      expect(isDeleted).toBe(true);
      expect(readStore(directory, encryptionKey)).toEqual({
        credentials: { discord: { '': rawCurl('discord') } },
        preparations: { slack: SLACK_PREPARATION },
      });
    });

    it('deletes every account of the service and its preparation with allAccounts', () => {
      writeStore(directory, encryptionKey, {
        credentials: {
          slack: { 'a@example.com': rawCurl('a'), 'b@example.com': rawCurl('b') },
          discord: { '': rawCurl('discord') },
        },
        preparations: { slack: SLACK_PREPARATION, gitlab: oauthClient('gitlab-client') },
      });

      const isDeleted = clearCredentials(runtime, 'slack', { kind: 'allAccounts' });

      expect(isDeleted).toBe(true);
      expect(readStore(directory, encryptionKey)).toEqual({
        credentials: { discord: { '': rawCurl('discord') } },
        preparations: { gitlab: oauthClient('gitlab-client') },
      });
    });

    it('deletes a preparation that is all the service has with allAccounts, and not without', () => {
      writeStore(directory, encryptionKey, { preparations: { slack: SLACK_PREPARATION } });

      expect(clearCredentials(runtime, 'slack', { kind: 'account' })).toBe(false);
      expect(readStore(directory, encryptionKey).preparations).toEqual({
        slack: SLACK_PREPARATION,
      });

      expect(clearCredentials(runtime, 'slack', { kind: 'allAccounts' })).toBe(true);
      expect(readStore(directory, encryptionKey).preparations).toEqual({});
    });

    it('throws UnknownServiceError for a service the registry of the directory does not know', () => {
      const contents: StoreContents = {
        credentials: { 'no-such-service': { '': rawCurl('orphan') } },
      };
      writeStore(directory, encryptionKey, contents);

      for (const selection of [{ kind: 'account' }, { kind: 'allAccounts' }] as const) {
        expect(() => clearCredentials(runtime, 'no-such-service', selection)).toThrow(
          UnknownServiceError
        );
      }
      expect(readStore(directory, encryptionKey).credentials).toEqual(contents.credentials);
    });

    it('throws AmbiguousAccountError when the service has several accounts and none is named', () => {
      const contents: StoreContents = {
        credentials: { slack: { 'a@example.com': rawCurl('a'), 'b@example.com': rawCurl('b') } },
      };
      writeStore(directory, encryptionKey, contents);

      expect(() => clearCredentials(runtime, 'slack', { kind: 'account' })).toThrow(
        AmbiguousAccountError
      );
      expect(readStore(directory, encryptionKey).credentials).toEqual(contents.credentials);
    });

    it.each([
      ['no account is named', { kind: 'account' }],
      ['an account is named', { kind: 'account', account: 'a@example.com' }],
      ['every account is selected', { kind: 'allAccounts' }],
    ] as const)(
      'returns false when nothing is stored for the service and %s',
      (_description, selection) => {
        expect(clearCredentials(runtime, 'slack', selection)).toBe(false);
        expect(existsSync(runtime.config.credentialStorePath)).toBe(false);
      }
    );

    it('returns false for an account the service does not have, and deletes nothing', () => {
      const contents: StoreContents = {
        credentials: { slack: { 'a@example.com': rawCurl('a') } },
      };
      writeStore(directory, encryptionKey, contents);

      const isDeleted = clearCredentials(runtime, 'slack', {
        kind: 'account',
        account: 'missing@example.com',
      });

      expect(isDeleted).toBe(false);
      expect(readStore(directory, encryptionKey).credentials).toEqual(contents.credentials);
    });
  });

  describe('reencryptCredentials', () => {
    const SLACK = { objectType: 'slack', token: 'tok', dCookie: 'cookie' };
    const DISCORD = { objectType: 'authorizationBearer', token: 'discord-token' };
    const BROWSER_STATE = JSON.stringify({ cookies: [{ name: 'session', value: 'abc' }] });

    let sourceDirectory: string;
    let sourceKey: string;
    let destinationDirectory: string;
    let destinationKey: string;
    let apiCredentialsTypes: readonly ApiCredentialsType[];

    function reencrypt(
      overrides: Partial<ReencryptCredentialsOptions> = {}
    ): Promise<ReencryptCredentialsResult> {
      return reencryptCredentials({
        source: { directory: sourceDirectory, encryptionKey: sourceKey },
        destination: { directory: destinationDirectory, encryptionKey: destinationKey },
        apiCredentialsTypes,
        ...overrides,
      });
    }

    /**
     * Expect a refusal of the given class, and return it. Every refusal is a
     * `ReencryptCredentialsError`, with the hint its class sets.
     */
    async function expectRefusal(
      reencryption: Promise<ReencryptCredentialsResult>,
      refusalClass: abstract new (...parameters: never[]) => ReencryptCredentialsError,
      expectedHint: string | null
    ): Promise<ReencryptCredentialsError> {
      const refusal: unknown = await reencryption.then(
        () => null,
        (error: unknown) => error
      );
      expect(refusal).toBeInstanceOf(refusalClass);
      expect(refusal).toBeInstanceOf(ReencryptCredentialsError);
      const typedRefusal = refusal as ReencryptCredentialsError;
      expect(typedRefusal.hint).toBe(expectedHint);
      return typedRefusal;
    }

    beforeEach(async () => {
      sourceDirectory = join(temporaryDirectory, 'source');
      sourceKey = generateKey();
      destinationDirectory = join(temporaryDirectory, 'destination');
      destinationKey = generateKey();
      // An embedding program passes the credential types of a runtime it holds.
      const runtime = await createRuntime(join(temporaryDirectory, 'runtime'), generateKey());
      apiCredentialsTypes = runtime.apiCredentialsTypes;
    });

    it('writes the stored credentials into the destination under the key of the destination', async () => {
      const credentials = { slack: { '': SLACK }, discord: { 'me@example.com': DISCORD } };
      writeStore(sourceDirectory, sourceKey, { credentials });

      const result = await reencrypt();

      const destinationStorePath = pathsOf(destinationDirectory).credentialStorePath;
      expect([...result.services].sort()).toEqual(['discord', 'slack']);
      expect(result.credentialStorePath).toBe(destinationStorePath);
      expect(result.browserStatePath).toBeNull();
      expect(readStore(destinationDirectory, destinationKey).credentials).toEqual(credentials);
      expect(() => new EncryptedStorage(sourceKey).readFile(destinationStorePath)).toThrow(
        EncryptedStorageError
      );
      expect(readStore(sourceDirectory, sourceKey).credentials).toEqual(credentials);
    });

    it('stamps the destination with the newest data format', async () => {
      writeStore(sourceDirectory, sourceKey, { credentials: { slack: { '': SLACK } } });
      expect(readDataFormatStamp(destinationDirectory)).toBeNull();

      await reencrypt();

      expect(readDataFormatStamp(destinationDirectory)).toBe(String(LATEST_VERSION));
    });

    it('writes only the services that are named', async () => {
      writeStore(sourceDirectory, sourceKey, {
        credentials: { slack: { '': SLACK }, discord: { '': DISCORD } },
        preparations: { gitlab: oauthClient('gitlab-client') },
      });

      const result = await reencrypt({ services: ['slack'] });

      expect(result.services).toEqual(['slack']);
      expect(readStore(destinationDirectory, destinationKey)).toEqual({
        credentials: { slack: { '': SLACK } },
        preparations: {},
      });
    });

    it('replaces a service of the destination when no account is named, and keeps its other services', async () => {
      writeStore(sourceDirectory, sourceKey, {
        credentials: { slack: { 'work@example.com': rawCurl('work') } },
      });
      writeStore(destinationDirectory, destinationKey, {
        credentials: {
          slack: { 'old@example.com': rawCurl('old'), 'work@example.com': rawCurl('stale') },
          discord: { '': DISCORD },
        },
        preparations: { slack: oauthClient('old-slack-client') },
      });

      await reencrypt();

      expect(readStore(destinationDirectory, destinationKey)).toEqual({
        credentials: {
          slack: { 'work@example.com': rawCurl('work') },
          discord: { '': DISCORD },
        },
        preparations: {},
      });
    });

    it('writes only the named account and keeps the other accounts of the destination', async () => {
      writeStore(sourceDirectory, sourceKey, {
        credentials: {
          slack: { 'work@example.com': rawCurl('work'), 'home@example.com': rawCurl('home') },
        },
      });
      writeStore(destinationDirectory, destinationKey, {
        credentials: {
          slack: { 'old@example.com': rawCurl('old'), 'work@example.com': rawCurl('stale') },
        },
      });

      const result = await reencrypt({ account: 'work@example.com' });

      expect(result.services).toEqual(['slack']);
      expect(readStore(destinationDirectory, destinationKey).credentials).toEqual({
        slack: { 'old@example.com': rawCurl('old'), 'work@example.com': rawCurl('work') },
      });
    });

    it('carries over the preparations of the selected services', async () => {
      writeStore(sourceDirectory, sourceKey, {
        credentials: { slack: { '': SLACK } },
        preparations: {
          slack: oauthClient('slack-client'),
          gitlab: oauthClient('gitlab-client'),
        },
      });

      const result = await reencrypt();

      expect([...result.services].sort()).toEqual(['gitlab', 'slack']);
      expect(readStore(destinationDirectory, destinationKey)).toEqual({
        credentials: { slack: { '': SLACK } },
        preparations: {
          slack: oauthClient('slack-client'),
          gitlab: oauthClient('gitlab-client'),
        },
      });
    });

    it('carries over a preparation when an account is named, since it belongs to no account', async () => {
      writeStore(sourceDirectory, sourceKey, {
        credentials: { slack: { 'work@example.com': rawCurl('work') } },
        preparations: { slack: oauthClient('new-slack-client') },
      });
      writeStore(destinationDirectory, destinationKey, {
        credentials: { slack: { 'old@example.com': rawCurl('old') } },
        preparations: { slack: oauthClient('old-slack-client') },
      });

      await reencrypt({ account: 'work@example.com' });

      expect(readStore(destinationDirectory, destinationKey)).toEqual({
        credentials: {
          slack: { 'old@example.com': rawCurl('old'), 'work@example.com': rawCurl('work') },
        },
        preparations: { slack: oauthClient('new-slack-client') },
      });
    });

    it('writes the browser state under the key of the destination when it is included', async () => {
      writeStore(sourceDirectory, sourceKey, { credentials: { slack: { '': SLACK } } });
      new EncryptedStorage(sourceKey).writeFile(
        pathsOf(sourceDirectory).browserStatePath,
        BROWSER_STATE
      );

      const result = await reencrypt({ isBrowserStateIncluded: true });

      const destinationBrowserStatePath = pathsOf(destinationDirectory).browserStatePath;
      expect(result.browserStatePath).toBe(destinationBrowserStatePath);
      expect(new EncryptedStorage(destinationKey).readFile(destinationBrowserStatePath)).toBe(
        BROWSER_STATE
      );
      expect(() => new EncryptedStorage(sourceKey).readFile(destinationBrowserStatePath)).toThrow(
        EncryptedStorageError
      );
    });

    it('leaves the browser state behind when it is not included', async () => {
      writeStore(sourceDirectory, sourceKey, { credentials: { slack: { '': SLACK } } });
      new EncryptedStorage(sourceKey).writeFile(
        pathsOf(sourceDirectory).browserStatePath,
        BROWSER_STATE
      );

      const result = await reencrypt();

      expect(result.browserStatePath).toBeNull();
      expect(existsSync(pathsOf(destinationDirectory).browserStatePath)).toBe(false);
    });

    it('writes a browser state that is all the source has', async () => {
      new EncryptedStorage(sourceKey).writeFile(
        pathsOf(sourceDirectory).browserStatePath,
        BROWSER_STATE
      );

      const result = await reencrypt({ isBrowserStateIncluded: true });

      expect(result.services).toEqual([]);
      expect(
        new EncryptedStorage(destinationKey).readFile(
          pathsOf(destinationDirectory).browserStatePath
        )
      ).toBe(BROWSER_STATE);
    });

    it('migrates in place a source in an older data format before reading it', async () => {
      // The format before accounts: one entry per service, and no stamp. The
      // service is one Latchkey does not ship, so nothing is asked of it over
      // the network; the stand-in below shows that curl was indeed not run.
      const curlInvocations: (readonly string[])[] = [];
      setAsyncSubprocessRunner((curlArguments) => {
        curlInvocations.push(curlArguments);
        return Promise.resolve({ returncode: 1, stdout: Buffer.alloc(0), stderr: 'no network' });
      });
      new EncryptedStorage(sourceKey).writeFile(
        pathsOf(sourceDirectory).credentialStorePath,
        JSON.stringify({ 'internal-api': rawCurl('old-format') })
      );
      expect(readDataFormatStamp(sourceDirectory)).toBeNull();

      const result = await reencrypt();

      const migratedContents = {
        credentials: { 'internal-api': { '': rawCurl('old-format') } },
        preparations: {},
      };
      expect(result.services).toEqual(['internal-api']);
      expect(readDataFormatStamp(sourceDirectory)).toBe(String(LATEST_VERSION));
      expect(readStore(sourceDirectory, sourceKey)).toEqual(migratedContents);
      expect(readStore(destinationDirectory, destinationKey)).toEqual(migratedContents);
      expect(curlInvocations).toEqual([]);
    });

    it('throws SourceCredentialsUnreadableError for an older-format source its key cannot open', async () => {
      new EncryptedStorage(generateKey()).writeFile(
        pathsOf(sourceDirectory).credentialStorePath,
        JSON.stringify({ 'internal-api': rawCurl('old-format') })
      );

      await expectRefusal(reencrypt(), SourceCredentialsUnreadableError, null);

      expect(readDataFormatStamp(sourceDirectory)).toBeNull();
      expect(existsSync(destinationDirectory)).toBe(false);
    });

    it('leaves an older-format source as it is when the destination key is refused', async () => {
      const oldFormatContents = JSON.stringify({ 'internal-api': rawCurl('old-format') });
      new EncryptedStorage(sourceKey).writeFile(
        pathsOf(sourceDirectory).credentialStorePath,
        oldFormatContents
      );

      await expectRefusal(
        reencrypt({
          destination: { directory: destinationDirectory, encryptionKey: 'not-a-key' },
        }),
        InvalidDestinationKeyError,
        null
      );

      expect(readDataFormatStamp(sourceDirectory)).toBeNull();
      expect(
        new EncryptedStorage(sourceKey).readFile(pathsOf(sourceDirectory).credentialStorePath)
      ).toBe(oldFormatContents);
    });

    it('throws MigrationError for a source in a newer data format', async () => {
      writeStore(sourceDirectory, sourceKey, { credentials: { slack: { '': SLACK } } });
      stampDataFormat(sourceDirectory, String(LATEST_VERSION + 1));

      await expect(reencrypt()).rejects.toBeInstanceOf(MigrationError);
      expect(existsSync(destinationDirectory)).toBe(false);
    });

    it('merges into the directory of a live runtime, whose store then sees the account', async () => {
      const runtime = await createRuntime(destinationDirectory, destinationKey);
      const rawCurlType = runtime.apiCredentialsTypes.find(
        (type) => type.objectType === 'rawCurl'
      )!;
      runtime.apiCredentialStore.save(
        'slack',
        rawCurlType.fromJSON(rawCurl('existing')),
        'existing@example.com'
      );
      writeStore(sourceDirectory, sourceKey, {
        credentials: { slack: { 'work@example.com': rawCurl('work') } },
      });
      expect(runtime.apiCredentialStore.listAccounts('slack')).toEqual(['existing@example.com']);

      await reencryptCredentials({
        source: { directory: sourceDirectory, encryptionKey: sourceKey },
        destination: { directory: runtime.config.directory, encryptionKey: destinationKey },
        apiCredentialsTypes: runtime.apiCredentialsTypes,
        account: 'work@example.com',
      });

      expect(runtime.apiCredentialStore.listAccounts('slack')).toEqual([
        'existing@example.com',
        'work@example.com',
      ]);
      expect(runtime.apiCredentialStore.get('slack', 'work@example.com')?.toJSON?.()).toEqual(
        rawCurl('work')
      );
      expect(runtime.apiCredentialStore.get('slack', 'existing@example.com')?.toJSON?.()).toEqual(
        rawCurl('existing')
      );
    });

    describe('refusals', () => {
      beforeEach(() => {
        writeStore(sourceDirectory, sourceKey, {
          credentials: { slack: { 'work@example.com': rawCurl('work') } },
        });
      });

      it('throws DestinationNotADirectoryError for a destination that is a file', async () => {
        writeFileSync(destinationDirectory, 'a file', 'utf-8');

        const refusal = await expectRefusal(reencrypt(), DestinationNotADirectoryError, null);

        expect(refusal.message).toContain(destinationDirectory);
        expect(readFileSync(destinationDirectory, 'utf-8')).toBe('a file');
      });

      it.each([
        ['not base64 of 32 bytes', 'not-a-key'],
        ['empty', ''],
      ])(
        'throws InvalidDestinationKeyError for a destination key that is %s',
        async (_description, malformedKey) => {
          await expectRefusal(
            reencrypt({
              destination: { directory: destinationDirectory, encryptionKey: malformedKey },
            }),
            InvalidDestinationKeyError,
            null
          );

          expect(existsSync(destinationDirectory)).toBe(false);
        }
      );

      it('throws SourceCredentialsUnreadableError for a store the source key cannot open', async () => {
        await expectRefusal(
          reencrypt({ source: { directory: sourceDirectory, encryptionKey: generateKey() } }),
          SourceCredentialsUnreadableError,
          null
        );

        expect(existsSync(destinationDirectory)).toBe(false);
      });

      it('throws SourceCredentialsUnreadableError for a browser state the source key cannot open', async () => {
        new EncryptedStorage(generateKey()).writeFile(
          pathsOf(sourceDirectory).browserStatePath,
          BROWSER_STATE
        );

        await expectRefusal(
          reencrypt({ isBrowserStateIncluded: true }),
          SourceCredentialsUnreadableError,
          null
        );

        expect(existsSync(destinationDirectory)).toBe(false);
      });

      it('throws BrowserStateNotFoundError when the browser state is included and there is none', async () => {
        const refusal = await expectRefusal(
          reencrypt({ isBrowserStateIncluded: true }),
          BrowserStateNotFoundError,
          null
        );

        expect(refusal.message).toContain(pathsOf(sourceDirectory).browserStatePath);
        expect(existsSync(destinationDirectory)).toBe(false);
      });

      it('throws ServicesNotStoredError naming the services the source has nothing for', async () => {
        const refusal = await expectRefusal(
          reencrypt({ services: ['slack', 'discord', 'gitlab'] }),
          ServicesNotStoredError,
          null
        );

        expect((refusal as ServicesNotStoredError).serviceNames).toEqual(['discord', 'gitlab']);
        expect(existsSync(destinationDirectory)).toBe(false);
      });

      it('throws AccountNotStoredError for an account none of the selected services has', async () => {
        const refusal = await expectRefusal(
          reencrypt({ account: 'missing@example.com' }),
          AccountNotStoredError,
          null
        );

        expect(refusal.message).toContain('missing@example.com');
        expect(existsSync(destinationDirectory)).toBe(false);
      });

      it('throws NothingToReencryptError for a source whose store is empty', async () => {
        writeStore(sourceDirectory, sourceKey, {});

        await expectRefusal(reencrypt(), NothingToReencryptError, null);

        expect(existsSync(destinationDirectory)).toBe(false);
      });

      it('throws NothingToReencryptError for a source that has no store', async () => {
        await expectRefusal(
          reencrypt({
            source: { directory: join(temporaryDirectory, 'empty'), encryptionKey: sourceKey },
          }),
          NothingToReencryptError,
          null
        );

        expect(existsSync(destinationDirectory)).toBe(false);
      });

      it.each([
        ['no stamp', null],
        ['the stamp of an older format', String(LATEST_VERSION - 1)],
      ])(
        'throws DestinationDataFormatError for an existing destination store with %s',
        async (_description, stamp) => {
          const destinationStorePath = pathsOf(destinationDirectory).credentialStorePath;
          new EncryptedStorage(destinationKey).writeFile(
            destinationStorePath,
            JSON.stringify({ discord: DISCORD })
          );
          if (stamp !== null) {
            stampDataFormat(destinationDirectory, stamp);
          }
          const storeBefore = readFileSync(destinationStorePath, 'utf-8');

          await expectRefusal(
            reencrypt(),
            DestinationDataFormatError,
            'Point Latchkey at that directory to migrate it first, or choose an empty destination.'
          );

          expect(readFileSync(destinationStorePath, 'utf-8')).toBe(storeBefore);
          expect(readDataFormatStamp(destinationDirectory)).toBe(stamp);
        }
      );

      it('throws DestinationDataFormatError for an existing destination store with an unreadable stamp', async () => {
        writeStore(destinationDirectory, destinationKey, {
          credentials: { discord: { '': DISCORD } },
        });
        stampDataFormat(destinationDirectory, 'not-a-version');

        await expectRefusal(reencrypt(), DestinationDataFormatError, null);

        expect(readStore(destinationDirectory, destinationKey).credentials).toEqual({
          discord: { '': DISCORD },
        });
      });

      it('throws DestinationCredentialsUnreadableError for an existing destination store under another key', async () => {
        const keyOfExistingStore = generateKey();
        writeStore(destinationDirectory, keyOfExistingStore, {
          credentials: { discord: { '': DISCORD } },
        });

        const refusal = await expectRefusal(
          reencrypt(),
          DestinationCredentialsUnreadableError,
          'It must be readable with the new key to be added to.'
        );

        expect(refusal.message).toContain(pathsOf(destinationDirectory).credentialStorePath);
        expect(readStore(destinationDirectory, keyOfExistingStore).credentials).toEqual({
          discord: { '': DISCORD },
        });
      });
    });
  });
});
