#!/usr/bin/env npx tsx
/**
 * CLI tool for encrypting and decrypting latchkey files.
 *
 * This is a developer utility for inspecting and modifying encrypted
 * credential and browser state files.
 *
 * Usage:
 *   npx tsx scripts/encryptFile.ts decrypt <file>     # Decrypt file to stdout
 *   npx tsx scripts/encryptFile.ts encrypt <file>     # Encrypt file in place
 *
 * The encryption key is sourced from:
 *   1. LATCHKEY_ENCRYPTION_KEY environment variable
 *   2. System keychain
 *
 * Examples:
 *   npx tsx scripts/encryptFile.ts decrypt ~/.latchkey/credentials.json
 *   npx tsx scripts/encryptFile.ts encrypt ~/.latchkey/credentials.json
 */

import { program } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CONFIG } from '../src/config.js';
import { EncryptedStorage } from '../src/encryptedStorage.js';
import { encrypt, generateKey } from '../src/encryption.js';
import { isKeychainAvailable, retrieveFromKeychain } from '../src/keychain.js';

const ENCRYPTED_FILE_PREFIX = 'LATCHKEY_ENCRYPTED:';

function getEncryptionKey(): string {
  // 1. Check environment variable via Config
  if (CONFIG.encryptionKeyOverride) {
    return CONFIG.encryptionKeyOverride;
  }

  // 2. Check keychain
  if (isKeychainAvailable(CONFIG.serviceName, CONFIG.accountName)) {
    const keychainKey = retrieveFromKeychain(CONFIG.serviceName, CONFIG.accountName);
    if (keychainKey) {
      return keychainKey;
    }
  }

  console.error(`\
Error: No encryption key available.
Set LATCHKEY_ENCRYPTION_KEY or ensure the system keychain has a stored key.

To generate a new key:
  export LATCHKEY_ENCRYPTION_KEY="${generateKey()}"`);
  process.exit(1);
}

function decryptCommand(filePath: string): void {
  if (!existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const storage = new EncryptedStorage({
    serviceName: CONFIG.serviceName,
    accountName: CONFIG.accountName,
  });
  const content = storage.readFile(filePath);

  if (content === null) {
    console.error(`Error: Could not read file: ${filePath}`);
    process.exit(1);
  }

  // Output to stdout
  process.stdout.write(content);
}

function encryptCommand(filePath: string): void {
  if (!existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const content = readFileSync(filePath, 'utf-8');
  if (content.startsWith(ENCRYPTED_FILE_PREFIX)) {
    console.error(`Error: File is already encrypted: ${filePath}`);
    process.exit(1);
  }

  const key = getEncryptionKey();
  const encryptedData = encrypt(content, key);
  const dataToWrite = ENCRYPTED_FILE_PREFIX + encryptedData;

  writeFileSync(filePath, dataToWrite, { encoding: 'utf-8', mode: 0o600 });
  console.error(`Encrypted: ${filePath}`);
}

program.name('encryptFile').description(`\
CLI tool for encrypting and decrypting latchkey files.

The encryption key is sourced from:
  1. LATCHKEY_ENCRYPTION_KEY environment variable
  2. System keychain`);

program
  .command('decrypt')
  .description('Decrypt file and print to stdout')
  .argument('<file>', 'Path to the encrypted file')
  .action((filePath: string) => {
    decryptCommand(filePath);
  });

program
  .command('encrypt')
  .description('Encrypt an unencrypted file in place')
  .argument('<file>', 'Path to the file to encrypt')
  .action((filePath: string) => {
    encryptCommand(filePath);
  });

program.parse();
