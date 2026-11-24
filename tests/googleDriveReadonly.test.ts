import { describe, it, expect, vi, afterEach } from 'vitest';
import { EncryptedStorage } from '../src/encryptedStorage.js';
import { OAuthCredentials } from '../src/apiCredentials/base.js';
import type { GoogleServiceConfig } from '../src/services/google/base.js';
import {
  GOOGLE_DOCS,
  GOOGLE_DRIVE,
  GOOGLE_DRIVE_READONLY,
  GOOGLE_SHEETS,
  GOOGLE_SLIDES,
} from '../src/services/index.js';
import { createServiceRegistry, BUILTIN_SERVICES } from '../src/serviceRegistry.js';
import { BUILTIN_SERVICE_REGISTRY } from './builtinServiceRegistry.js';
import { stubGoogleLogin } from './googleLoginStub.js';

const TEST_ENCRYPTION_KEY = 'dGVzdGtleXRlc3RrZXl0ZXN0a2V5dGVzdGtleXRlc3Q=';

// The service's own config is a protected implementation detail; the test
// reaches in for the list of APIs that `browser-prepare` turns on.
const CONFIG = (GOOGLE_DRIVE_READONLY as unknown as { config: GoogleServiceConfig }).config;

const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const COMMON_SCOPES = [
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Google Drive (read-only) login', () => {
  it('asks for drive.readonly and the common scopes, and nothing else', async () => {
    const { fakePage } = stubGoogleLogin({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: [...COMMON_SCOPES, DRIVE_READONLY_SCOPE].join(' '),
    });

    const result = await GOOGLE_DRIVE_READONLY.getSession('Latchkey').login(
      new EncryptedStorage(TEST_ENCRYPTION_KEY),
      {},
      OAuthCredentials.prepared('client-id', 'client-secret'),
      { strict: true }
    );

    const authorizationUrl = new URL(fakePage.goto.mock.calls[0]?.[0] as string);
    const requestedScopes = authorizationUrl.searchParams.get('scope')?.split(' ');
    expect([...(requestedScopes ?? [])].sort()).toEqual(
      [...COMMON_SCOPES, DRIVE_READONLY_SCOPE].sort()
    );
    expect((result.credentials as OAuthCredentials).accessToken).toBe('access');
  });
});

describe('Google Drive (read-only) prepare', () => {
  it('turns on the Drive, Docs, Sheets and Slides APIs in its one project', () => {
    expect([...CONFIG.apis].sort()).toEqual([
      'docs.googleapis.com',
      'drive.googleapis.com',
      'sheets.googleapis.com',
      'slides.googleapis.com',
    ]);
  });
});

describe('Google Drive (read-only) URL matching', () => {
  const readUrls = [
    'https://www.googleapis.com/drive/v3/files?pageSize=1',
    'https://www.googleapis.com/drive/v3/files/abc/revisions',
    'https://www.googleapis.com/drive/v3/files/abc/comments?fields=*',
    'https://www.googleapis.com/drive/v3/files/abc/export?mimeType=text/plain',
    'https://www.googleapis.com/drive/v3/drives',
    'https://www.googleapis.com/drive/v3/about?fields=user',
    'https://docs.googleapis.com/v1/documents/abc',
    'https://sheets.googleapis.com/v4/spreadsheets/abc',
    'https://slides.googleapis.com/v1/presentations/abc',
    'https://docs.google.com/feeds/download/documents/export/Export?id=abc&revision=3&exportFormat=odt',
    'https://docs.google.com/spreadsheets/export?id=abc&revision=3&exportFormat=ods',
    'https://docs.google.com/feeds/download/presentations/Export?id=abc&revision=3&exportFormat=odp',
  ];
  for (const url of readUrls) {
    it(`matches ${url}`, () => {
      expect(BUILTIN_SERVICE_REGISTRY.getCandidatesByUrl(url)).toContain(GOOGLE_DRIVE_READONLY);
    });
  }

  it('does not match the write-only Drive upload endpoint', () => {
    expect(
      BUILTIN_SERVICE_REGISTRY.getCandidatesByUrl(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=media'
      )
    ).toEqual([GOOGLE_DRIVE]);
  });

  it('does not match the rest of docs.google.com', () => {
    expect(
      BUILTIN_SERVICE_REGISTRY.getCandidatesByUrl('https://docs.google.com/document/d/abc/edit')
    ).toEqual([]);
  });

  it('comes after the read-write Drive services, so it never takes over their requests', () => {
    expect(
      BUILTIN_SERVICE_REGISTRY.getCandidatesByUrl(
        'https://www.googleapis.com/drive/v3/files?pageSize=1'
      )
    ).toEqual([GOOGLE_DRIVE, GOOGLE_SHEETS, GOOGLE_DOCS, GOOGLE_SLIDES, GOOGLE_DRIVE_READONLY]);
  });

  it('is the only candidate once the read-write Drive services are hidden', () => {
    const registry = createServiceRegistry(BUILTIN_SERVICES, null, [
      'google-drive',
      'google-docs',
      'google-sheets',
      'google-slides',
    ]);
    for (const url of readUrls) {
      expect(registry.getCandidatesByUrl(url)).toEqual([GOOGLE_DRIVE_READONLY]);
    }
  });
});
