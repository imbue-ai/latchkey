import { describe, expect, it } from 'vitest';
import { MATCHED_SERVICE_HEADER, addDiagnosticHeaders } from '../src/diagnosticHeaders.js';

describe('addDiagnosticHeaders', () => {
  const url = 'https://slack.com/api/test';

  it('puts the matched service ahead of the other arguments', () => {
    expect(
      addDiagnosticHeaders(['-H', 'Authorization: Bearer token', url], {
        matchedServiceName: 'slack',
      })
    ).toEqual(['-H', `${MATCHED_SERVICE_HEADER}: slack`, '-H', 'Authorization: Bearer token', url]);
  });

  it('adds nothing when no service was matched', () => {
    expect(addDiagnosticHeaders(['-sS', url], { matchedServiceName: null })).toEqual(['-sS', url]);
  });

  it('leaves a header of the same name that the caller supplied, after its own', () => {
    const callerArguments = ['-H', `${MATCHED_SERVICE_HEADER}: github`, url];
    expect(addDiagnosticHeaders(callerArguments, { matchedServiceName: 'slack' })).toEqual([
      '-H',
      `${MATCHED_SERVICE_HEADER}: slack`,
      ...callerArguments,
    ]);
  });
});
