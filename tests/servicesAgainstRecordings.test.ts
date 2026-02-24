/**
 * Test login recordings against service implementations.
 *
 * This module validates that recorded login sessions can be used to test
 * service API credential extraction logic. It discovers recordings in
 * scripts/recordings/<service_name>/ and verifies that the service's
 * getApiCredentialsFromResponse() method can extract valid API credentials
 * from the recorded requests.
 *
 * The tests work by loading recorded HTTP request/response pairs from login_session.json
 * and creating mock Response objects to pass to the service's API credential extraction
 * method. This validates that the service can correctly identify and extract
 * API credentials from outgoing browser requests.
 *
 * Usage:
 *   npm test -- tests/servicesAgainstRecordings.test.ts           # Test all recordings
 *   npm test -- tests/servicesAgainstRecordings.test.ts -t slack  # Test only Slack
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import type { Response, Request } from 'playwright';
import { ApiCredentials } from '../src/apiCredentials.js';
import { REGISTRY } from '../src/registry.js';
import { Service, SimpleServiceSession } from '../src/services/core/base.js';

// Get the directory of this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Recordings directory relative to this file
const RECORDINGS_DIRECTORY = resolve(__dirname, '..', 'scripts', 'recordings');

// Default recording filename (matches recordBrowserSession.ts)
const DEFAULT_RECORDING_NAME = 'login_session.json';

// Do not test services that require special followup steps.
const BLACKLIST = new Set(['dropbox', 'github', 'linear']);

class InvalidRecordingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRecordingError';
  }
}

class ApiCredentialExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiCredentialExtractionError';
  }
}

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

function loadRecordingEntries(requestsPath: string): RecordedEntry[] {
  const content = readFileSync(requestsPath, 'utf-8');
  return JSON.parse(content) as RecordedEntry[];
}

function createMockRequest(requestData: RequestData): Request {
  const mockRequest = {
    url: () => requestData.url,
    method: () => requestData.method,
    headers: () => requestData.headers,
    allHeaders: () => Promise.resolve(requestData.headers),
    resourceType: () => requestData.resource_type,
    postData: () => requestData.post_data ?? null,
  } as unknown as Request;

  return mockRequest;
}

function createMockResponse(responseData: ResponseData, mockRequest: Request): Response {
  const body = responseData.body ?? '';

  const mockResponse = {
    status: () => responseData.status,
    statusText: () => responseData.status_text,
    headers: () => responseData.headers,
    allHeaders: () => Promise.resolve(responseData.headers),
    request: () => mockRequest,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
    body: () => Promise.resolve(Buffer.from(body)),
  } as unknown as Response;

  return mockResponse;
}

/**
 * Test a service's API credential extraction using a recorded session.
 *
 * Loads recorded HTTP request/response pairs and tests that the service can
 * extract API credentials from them using getApiCredentialsFromResponse().
 */
async function testServiceWithRecording(
  service: Service,
  recordingDirectory: string
): Promise<ApiCredentials> {
  const requestsPath = join(recordingDirectory, DEFAULT_RECORDING_NAME);

  if (!existsSync(requestsPath)) {
    throw new InvalidRecordingError(`Requests file not found: ${requestsPath}`);
  }

  const recordingEntries = loadRecordingEntries(requestsPath);

  if (recordingEntries.length === 0) {
    throw new InvalidRecordingError('No requests recorded');
  }

  if (!service.getSession) {
    throw new InvalidRecordingError(
      `Service ${service.name} does not support browser login, cannot test with recordings`
    );
  }

  const session = service.getSession();

  if (!(session instanceof SimpleServiceSession)) {
    throw new InvalidRecordingError(
      `Service ${service.name} does not use SimpleServiceSession, cannot test with recordings`
    );
  }

  // Try to extract API credentials from each recorded request/response pair
  for (const entry of recordingEntries) {
    const mockRequest = createMockRequest(entry.request);
    const mockResponse = createMockResponse(entry.response, mockRequest);

    // Call onResponse which internally calls getApiCredentialsFromResponse
    session.onResponse(mockResponse);

    // Give async operations time to complete (e.g., Slack reads response body)
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // Give additional time for any async operations to complete
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Access the apiCredentials via the session (it's protected but accessible for testing)
  const apiCredentials = (session as unknown as { apiCredentials: ApiCredentials | null })
    .apiCredentials;

  if (apiCredentials !== null) {
    return apiCredentials;
  }

  throw new ApiCredentialExtractionError(
    `No API credentials could be extracted from ${String(recordingEntries.length)} recorded entries`
  );
}

interface DiscoveredRecording {
  serviceName: string;
  recordingPath: string;
}

function discoverRecordings(): DiscoveredRecording[] {
  const recordings: DiscoveredRecording[] = [];

  if (!existsSync(RECORDINGS_DIRECTORY)) {
    return recordings;
  }

  const items = readdirSync(RECORDINGS_DIRECTORY, { withFileTypes: true });

  for (const item of items) {
    if (item.isDirectory() && !item.name.startsWith('.') && !BLACKLIST.has(item.name)) {
      const recordingPath = join(RECORDINGS_DIRECTORY, item.name);
      const requestsPath = join(recordingPath, DEFAULT_RECORDING_NAME);

      if (existsSync(requestsPath)) {
        recordings.push({
          serviceName: item.name,
          recordingPath,
        });
      }
    }
  }

  return recordings.sort((a, b) => a.serviceName.localeCompare(b.serviceName));
}

// Discover recordings at module load time
const discoveredRecordings = discoverRecordings();

describe('Services Against Recordings', () => {
  if (discoveredRecordings.length === 0) {
    it.skip('No recordings found', () => {
      // Skip if no recordings exist
    });
  }

  for (const { serviceName, recordingPath } of discoveredRecordings) {
    it(`should extract credentials from ${serviceName} recording`, async () => {
      const service = REGISTRY.getByName(serviceName);

      if (service === null) {
        // Skip if service not found in registry
        expect.fail(`Service '${serviceName}' not found in registry`);
        return;
      }

      const apiCredentials = await testServiceWithRecording(service, recordingPath);

      // Verify API credentials are valid
      expect(apiCredentials).not.toBeNull();

      const curlArgs = apiCredentials.injectIntoCurlCall([]);
      expect(curlArgs.length).toBeGreaterThan(0);
    });
  }
});
