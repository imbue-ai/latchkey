import { describe, it, expect } from 'vitest';
import { GOOGLE_GMAIL } from '../src/services/google/gmail.js';
import type { GoogleServiceConfig } from '../src/services/google/base.js';

/**
 * Gmail filters (users.settings.filters) require the `gmail.settings.basic`
 * OAuth scope; `gmail.modify` alone permits reading filters but not creating
 * or deleting them. This test guards against an accidental scope regression
 * that would silently make filter management fail with
 * ACCESS_TOKEN_SCOPE_INSUFFICIENT after a fresh login.
 *
 * Accessing the protected `config` via a cast is intentional and test-only;
 * the field is not part of the public Service surface.
 */
describe('GoogleGmail OAuth scopes', () => {
  const config = (GOOGLE_GMAIL as unknown as { config: GoogleServiceConfig }).config;

  it('requests gmail.modify (read/label messages, read filters/labels)', () => {
    expect(config.scopes).toContain('https://www.googleapis.com/auth/gmail.modify');
  });

  it('requests gmail.settings.basic (create/delete filters and forwarding rules)', () => {
    expect(config.scopes).toContain('https://www.googleapis.com/auth/gmail.settings.basic');
  });
});
