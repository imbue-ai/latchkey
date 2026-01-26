#!/usr/bin/env npx tsx
/**
 * Record browser requests and responses during a login session.
 *
 * This script opens a browser at a service's login URL and records all HTTP
 * requests and responses (including their headers and timing). When you close the
 * browser, the recording is saved. This is useful for recording login flows that
 * can be replayed later for testing credentials extraction.
 *
 * Usage:
 *   npx tsx scripts/recordBrowserSession.ts <service_name> [recording_name]
 *
 * Examples:
 *   npx tsx scripts/recordBrowserSession.ts slack
 *   npx tsx scripts/recordBrowserSession.ts discord custom_session.json
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, Response } from 'playwright';
import { getBrowserStatePath } from '../src/browserState.js';
import { REGISTRY } from '../src/registry.js';

// Get the directory of this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Recordings directory relative to this script
const RECORDINGS_DIRECTORY = resolve(__dirname, 'recordings');

// Default recording filename
const DEFAULT_RECORDING_NAME = 'login_session.json';

class UnknownServiceError extends Error {
  constructor(serviceName: string) {
    super(`Unknown service: ${serviceName}`);
    this.name = 'UnknownServiceError';
  }
}

// Resource types to skip (CSS, images, fonts, multimedia)
const SKIPPED_RESOURCE_TYPES = new Set(['stylesheet', 'image', 'media', 'font']);

// Common multi-part TLDs
const MULTI_PART_TLDS = new Set(['co.uk', 'com.au', 'co.nz', 'co.jp', 'com.br', 'co.in']);

interface RequestData {
  timestamp_ms: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  resource_type: string;
  post_data?: string;
}

interface ResponseData {
  status: number;
  status_text: string;
  headers: Record<string, string>;
  body?: string;
}

interface RecordedEntry {
  request: RequestData;
  response: ResponseData;
}

/**
 * Extract the base domain from a URL.
 *
 * For example:
 *   https://discord.com/login -> discord.com
 *   https://api.discord.com/v9/users -> discord.com
 *   https://www.example.co.uk/page -> example.co.uk
 */
function extractBaseDomain(url: string): string {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return '';
  }

  // Split the hostname into parts
  const parts = hostname.split('.');

  // Handle common multi-part TLDs (e.g., co.uk, com.au)
  if (parts.length >= 3) {
    const potentialTld = parts.slice(-2).join('.');
    if (MULTI_PART_TLDS.has(potentialTld)) {
      return parts.slice(-3).join('.');
    }
  }

  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }

  return hostname;
}

/**
 * Check if a request URL belongs to the same base domain.
 */
function isSameBaseDomain(requestUrl: string, baseDomain: string): boolean {
  let requestHostname: string;
  try {
    requestHostname = new URL(requestUrl).hostname;
  } catch {
    return false;
  }
  return requestHostname === baseDomain || requestHostname.endsWith('.' + baseDomain);
}

/**
 * Handle a response and record both request and response details.
 */
async function handleResponse(
  response: Response,
  recordedEntries: RecordedEntry[],
  startTime: { value: number },
  baseDomain: string
): Promise<void> {
  const request = response.request();

  // Skip CSS, images, fonts, and multimedia
  if (SKIPPED_RESOURCE_TYPES.has(request.resourceType())) {
    return;
  }

  // Skip requests to external domains
  if (!isSameBaseDomain(request.url(), baseDomain)) {
    return;
  }

  if (startTime.value === 0) {
    startTime.value = Date.now();
  }

  const timestampMs = Date.now() - startTime.value;

  const requestData: RequestData = {
    timestamp_ms: timestampMs,
    method: request.method(),
    url: request.url(),
    headers: await request.allHeaders(),
    resource_type: request.resourceType(),
  };

  // Include POST data if present
  try {
    const postData = request.postData();
    if (postData !== null) {
      requestData.post_data = postData;
    }
  } catch {
    // Post data not available or not decodable
  }

  const responseData: ResponseData = {
    status: response.status(),
    status_text: response.statusText(),
    headers: await response.allHeaders(),
  };

  // Try to get response body as text (skip binary content)
  try {
    const body = await response.text();
    responseData.body = body;
  } catch {
    // Binary content or other error - skip body
  }

  recordedEntries.push({
    request: requestData,
    response: responseData,
  });
}

/**
 * Record browser requests and responses during a login session.
 */
async function record(
  serviceName: string,
  recordingName: string = DEFAULT_RECORDING_NAME
): Promise<void> {
  const service = REGISTRY.getByName(serviceName);
  if (service === null) {
    throw new UnknownServiceError(serviceName);
  }

  const outputDirectory = join(RECORDINGS_DIRECTORY, serviceName);
  mkdirSync(outputDirectory, { recursive: true });
  const requestsPath = join(outputDirectory, recordingName);

  const browserStatePath = getBrowserStatePath();

  const baseDomain = extractBaseDomain(service.loginUrl);

  console.log(`Recording login for service: ${service.name}`);
  console.log(`Login URL: ${service.loginUrl}`);
  console.log(`Recording requests to: ${baseDomain} (and subdomains)`);
  console.log(`Output directory: ${outputDirectory}`);
  if (browserStatePath) {
    console.log(`Browser state: ${browserStatePath}`);
  }
  console.log("\nClose the browser window when you're done to save the recording.");

  const recordedEntries: RecordedEntry[] = [];
  const startTime = { value: 0 };

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext(
    browserStatePath && existsSync(browserStatePath)
      ? { storageState: browserStatePath }
      : undefined
  );
  const page = await context.newPage();

  // Register response handler to capture all requests and responses
  page.on('response', (response) => {
    handleResponse(response, recordedEntries, startTime, baseDomain).catch(() => {
      // Ignore errors in response handling
    });
  });

  await page.goto(service.loginUrl);

  // Wait for user to close the browser
  try {
    // This will block until the page/context is closed
    await page.waitForEvent('close', { timeout: 0 });
  } catch {
    // Browser was closed, this is expected
  }

  // Save browser state if path is configured
  if (browserStatePath) {
    try {
      await context.storageState({ path: browserStatePath });
    } catch {
      // Context may already be closed
    }
  }

  await context.close();
  await browser.close();

  // Save recorded entries
  writeFileSync(requestsPath, JSON.stringify(recordedEntries, null, 2));

  console.log('\nRecording saved successfully!');
  console.log(`  Requests file: ${requestsPath}`);
  console.log(`  Recorded ${recordedEntries.length} request/response pairs`);
}

// Main entry point
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log('Usage: npx tsx scripts/recordBrowserSession.ts <service_name> [recording_name]');
    console.log('');
    console.log('Arguments:');
    console.log(
      "  service_name    Name of the service to record login for (e.g., 'slack', 'discord')"
    );
    console.log('  recording_name  Name of the recording file (default: login_session.json)');
    console.log('');
    console.log('Examples:');
    console.log('  npx tsx scripts/recordBrowserSession.ts slack');
    console.log('  npx tsx scripts/recordBrowserSession.ts discord custom_session.json');
    process.exit(0);
  }

  const serviceName = args[0]!;
  const recordingName = args[1] ?? DEFAULT_RECORDING_NAME;

  try {
    await record(serviceName, recordingName);
  } catch (error) {
    if (error instanceof UnknownServiceError) {
      console.error(`Error: ${error.message}`);
      console.error('Available services:');
      for (const service of REGISTRY.services) {
        console.error(`  - ${service.name}`);
      }
      process.exit(1);
    }
    throw error;
  }
}

main();
