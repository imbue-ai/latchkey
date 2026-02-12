#!/usr/bin/env npx tsx
/**
 * Record browser interactions and generate TypeScript code for a new service definition.
 *
 * This script opens a browser at the given URL and records:
 * - User interactions (clicks, fills, navigations, etc.)
 * - HTTP request metadata
 *
 * The session has two phases:
 * - Pre-login: No recording, HTTP requests marked as pre-login
 * - Post-login: User interactions recorded, requests marked as post-login
 *
 * A toolbar is injected into the page to control recording phases and
 * select API key elements.
 *
 * Usage:
 *   npx tsx scripts/codegen.ts <name> <url>
 *
 * Examples:
 *   npx tsx scripts/codegen.ts wordpress https://wordpress.com/generate-api-key
 *   npx tsx scripts/codegen.ts slack https://api.slack.com/apps
 */

import { runCodegen } from '../src/codegen/index.js';

class InvalidArgumentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArgumentsError';
  }
}

function printUsage(): void {
  console.log('Usage: npx tsx scripts/codegen.ts <name> <url>');
  console.log('');
  console.log('Arguments:');
  console.log('  name    Name of the service to record (used for output directory)');
  console.log('  url     Initial URL to navigate to');
  console.log('');
  console.log('Output:');
  console.log('  recordings/<name>/actions.js     Recorded user actions as TypeScript code');
  console.log('  recordings/<name>/requests.json  HTTP request metadata');
  console.log('  recordings/<name>/prompt.txt     Instructions for creating a service definition');
  console.log('');
  console.log('Examples:');
  console.log('  npx tsx scripts/codegen.ts wordpress https://wordpress.com/generate-api-key');
  console.log('  npx tsx scripts/codegen.ts slack https://api.slack.com/apps');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    process.exit(0);
  }

  if (args.length < 2) {
    throw new InvalidArgumentsError('Missing required arguments. Expected: <name> <url>');
  }

  const name = args[0]!;
  const url = args[1]!;

  // Validate URL
  try {
    new URL(url);
  } catch {
    throw new InvalidArgumentsError(`Invalid URL: ${url}`);
  }

  console.log(`Recording session for: ${name}`);
  console.log(`Starting URL: ${url}`);
  console.log('');
  console.log('Instructions:');
  console.log('  1. Log in to the service in the browser');
  console.log('  2. Click "I\'ve logged in" button when ready to start recording');
  console.log('  3. Perform the actions to generate an API key');
  console.log('  4. Click "Select API key" and click on the API key element');
  console.log('  5. Close the browser when done');
  console.log('');

  await runCodegen({ name, url });
}

void main().catch((error: unknown) => {
  if (error instanceof InvalidArgumentsError) {
    console.error(`Error: ${error.message}`);
    console.error('');
    printUsage();
    process.exit(1);
  }
  if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
  throw error;
});
