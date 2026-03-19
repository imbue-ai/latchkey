import { describe, it, expect, vi } from 'vitest';
import { EncryptedStorage, EncryptionKeyLostError } from '../src/encryptedStorage.js';

vi.mock('../src/keychain.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/keychain.js')>();
  return {
    ...original,
    retrieveFromKeychain: () => Promise.resolve(null),
    storeInKeychain: () => Promise.resolve(undefined),
  };
});

describe('EncryptedStorage key generation guard', () => {
  it('should throw EncryptionKeyLostError when allowKeyGeneration is false and keychain has no key', async () => {
    await expect(EncryptedStorage.create({ allowKeyGeneration: false })).rejects.toThrow(
      EncryptionKeyLostError
    );
  });

  it('should generate a new key when allowKeyGeneration is true and keychain has no key', async () => {
    await expect(EncryptedStorage.create({ allowKeyGeneration: true })).resolves.toBeDefined();
  });

  it('should generate a new key when allowKeyGeneration is not set and keychain has no key', async () => {
    await expect(EncryptedStorage.create({})).resolves.toBeDefined();
  });
});
