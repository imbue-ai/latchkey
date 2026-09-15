/**
 * Tests for the shared credential error messages, in particular the shell
 * quoting of accounts in the commands they suggest.
 */

import { describe, expect, it } from 'vitest';
import { ErrorMessages } from '../src/errorMessages.js';

describe('ErrorMessages.noCredentialsFound', () => {
  it('leaves an ordinary account unquoted', () => {
    const message = ErrorMessages.noCredentialsFound('slack', 'jane@example.com');
    expect(message).toContain("(account 'jane@example.com')");
    expect(message).toContain('latchkey --account jane@example.com auth browser slack');
  });

  it('suggests no account at all for the default account', () => {
    const message = ErrorMessages.noCredentialsFound('slack', '');
    expect(message).not.toContain('--account');
    expect(message).toContain('latchkey auth browser slack');
  });

  it('double-quotes an account with spaces and an apostrophe', () => {
    const message = ErrorMessages.noCredentialsFound('notion-mcp', "jane@example.com:Jane's Space");
    expect(message).toContain(
      'latchkey --account "jane@example.com:Jane\'s Space" auth browser notion-mcp'
    );
  });

  it('single-quotes an account that double quotes would not protect', () => {
    const message = ErrorMessages.noCredentialsFound('slack', 'we$rd "one"');
    expect(message).toContain(`latchkey --account 'we$rd "one"' auth browser slack`);
  });

  it('escapes an apostrophe when it has to single-quote', () => {
    const message = ErrorMessages.noCredentialsFound('slack', `Jane's $pace`);
    expect(message).toContain(`latchkey --account 'Jane'\\''s $pace' auth browser slack`);
  });
});
