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
 *   npx tsx scripts/encryptFile.ts edit <file>        # Decrypt, edit with $EDITOR, re-encrypt
 *
 * The encryption key is sourced from:
 *   1. LATCHKEY_ENCRYPTION_KEY environment variable
 *   2. System keychain
 *
 * Examples:
 *   npx tsx scripts/encryptFile.ts decrypt ~/.latchkey/credentials.json
 *   npx tsx scripts/encryptFile.ts encrypt ~/.latchkey/credentials.json
 *   npx tsx scripts/encryptFile.ts edit ~/.latchkey/browser_state.json
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EncryptedStorage } from '../src/encryptedStorage.js';
import { encrypt, generateKey } from '../src/encryption.js';
import { isKeychainAvailable, retrieveFromKeychain } from '../src/keychain.js';

const ENCRYPTED_FILE_PREFIX = 'LATCHKEY_ENCRYPTED:';

function printUsage(): void {
  console.log('Usage: npx tsx scripts/encryptFile.ts <command> <file>');
  console.log('');
  console.log('Commands:');
  console.log('  decrypt <file>   Decrypt file and print to stdout');
  console.log('  encrypt <file>   Encrypt an unencrypted file in place');
  console.log('  edit <file>      Decrypt, open in $EDITOR, then re-encrypt');
  console.log('  status <file>    Check if file is encrypted');
  console.log('');
  console.log('The encryption key is sourced from:');
  console.log('  1. LATCHKEY_ENCRYPTION_KEY environment variable');
  console.log('  2. System keychain');
  console.log('');
  console.log('Examples:');
  console.log('  npx tsx scripts/encryptFile.ts decrypt ~/.latchkey/credentials.json');
  console.log('  npx tsx scripts/encryptFile.ts encrypt ~/.latchkey/credentials.json');
  console.log('  npx tsx scripts/encryptFile.ts edit ~/.latchkey/browser_state.json');
  console.log('  EDITOR=code npx tsx scripts/encryptFile.ts edit ~/.latchkey/credentials.json');
}

function getEncryptionKey(): string {
  // 1. Check environment variable
  const envKey = process.env.LATCHKEY_ENCRYPTION_KEY;
  if (envKey) {
    return envKey;
  }

  // 2. Check keychain
  if (isKeychainAvailable()) {
    const keychainKey = retrieveFromKeychain();
    if (keychainKey) {
      return keychainKey;
    }
  }

  console.error('Error: No encryption key available.');
  console.error('Set LATCHKEY_ENCRYPTION_KEY or ensure the system keychain has a stored key.');
  console.error('');
  console.error('To generate a new key:');
  console.error(`  export LATCHKEY_ENCRYPTION_KEY="${generateKey()}"`);
  process.exit(1);
}

function isFileEncrypted(filePath: string): boolean {
  if (!existsSync(filePath)) {
    return false;
  }
  const content = readFileSync(filePath, 'utf-8');
  return content.startsWith(ENCRYPTED_FILE_PREFIX);
}

function decryptCommand(filePath: string): void {
  if (!existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const storage = new EncryptedStorage();
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

  if (isFileEncrypted(filePath)) {
    console.error(`Error: File is already encrypted: ${filePath}`);
    process.exit(1);
  }

  const key = getEncryptionKey();
  const content = readFileSync(filePath, 'utf-8');
  const encryptedData = encrypt(content, key);
  const dataToWrite = ENCRYPTED_FILE_PREFIX + encryptedData;

  writeFileSync(filePath, dataToWrite, { encoding: 'utf-8', mode: 0o600 });
  console.error(`Encrypted: ${filePath}`);
}

function statusCommand(filePath: string): void {
  if (!existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  if (isFileEncrypted(filePath)) {
    console.log(`${filePath}: encrypted`);
  } else {
    console.log(`${filePath}: unencrypted`);
  }
}

async function editCommand(filePath: string): Promise<void> {
  if (!existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const editor = process.env.EDITOR ?? process.env.VISUAL ?? 'vi';
  const storage = new EncryptedStorage();
  const key = getEncryptionKey();

  // Read and decrypt the file
  const content = storage.readFile(filePath);
  if (content === null) {
    console.error(`Error: Could not read file: ${filePath}`);
    process.exit(1);
  }

  // Write to a temporary file
  const tempFileName = `latchkey-edit-${randomBytes(8).toString('hex')}.json`;
  const tempFilePath = join(tmpdir(), tempFileName);

  try {
    writeFileSync(tempFilePath, content, { encoding: 'utf-8', mode: 0o600 });

    // Open editor and wait for it to close
    await new Promise<void>((resolve, reject) => {
      const child = spawn(editor, [tempFilePath], {
        stdio: 'inherit',
        shell: true,
      });

      child.on('error', (error) => {
        reject(new Error(`Failed to start editor: ${error.message}`));
      });

      child.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Editor exited with code ${String(code)}`));
        }
      });
    });

    // Read the edited content
    const editedContent = readFileSync(tempFilePath, 'utf-8');

    // Re-encrypt and save
    const encryptedData = encrypt(editedContent, key);
    const dataToWrite = ENCRYPTED_FILE_PREFIX + encryptedData;
    writeFileSync(filePath, dataToWrite, { encoding: 'utf-8', mode: 0o600 });

    console.error(`Saved and encrypted: ${filePath}`);
  } finally {
    // Clean up temp file
    if (existsSync(tempFilePath)) {
      unlinkSync(tempFilePath);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    process.exit(0);
  }

  const command = args[0];
  const filePath = args[1];

  if (!filePath) {
    console.error('Error: No file specified.');
    console.error('');
    printUsage();
    process.exit(1);
  }

  switch (command) {
    case 'decrypt':
      decryptCommand(filePath);
      break;
    case 'encrypt':
      encryptCommand(filePath);
      break;
    case 'status':
      statusCommand(filePath);
      break;
    case 'edit':
      await editCommand(filePath);
      break;
    default:
      console.error(`Error: Unknown command: ${String(command)}`);
      console.error('');
      printUsage();
      process.exit(1);
  }
}

void main();
