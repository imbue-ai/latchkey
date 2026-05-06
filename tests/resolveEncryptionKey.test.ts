import { describe, it, expect, vi } from 'vitest';
import { EncryptionKeyLostError, generateKey, resolveEncryptionKey } from '../src/encryption.js';

vi.mock('../src/keychain.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/keychain.js')>();
  return {
    ...original,
    retrieveFromKeychain: () => Promise.resolve(null),
    storeInKeychain: () => Promise.resolve(undefined),
  };
});

describe('resolveEncryptionKey', () => {
  it('returns the override verbatim and does not touch the keychain', async () => {
    const override = generateKey();
    await expect(resolveEncryptionKey({ encryptionKeyOverride: override })).resolves.toBe(override);
  });

  it('throws EncryptionKeyLostError when allowKeyGeneration is false and keychain has no key', async () => {
    await expect(resolveEncryptionKey({ allowKeyGeneration: false })).rejects.toThrow(
      EncryptionKeyLostError
    );
  });

  it('generates a new key when allowKeyGeneration is true and keychain has no key', async () => {
    await expect(resolveEncryptionKey({ allowKeyGeneration: true })).resolves.toMatch(/.+/);
  });

  it('generates a new key when allowKeyGeneration is unset and keychain has no key', async () => {
    await expect(resolveEncryptionKey({})).resolves.toMatch(/.+/);
  });
});
