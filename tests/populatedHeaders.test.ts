import { describe, expect, it } from 'vitest';
import {
  MATCHED_SERVICE_HEADER,
  UnknownPopulatedHeaderError,
  populateHeadersForCurl,
  resolvePopulatedHeaderNames,
} from '../src/populatedHeaders.js';

describe('resolvePopulatedHeaderNames', () => {
  it('returns no names when none are requested', () => {
    expect(resolvePopulatedHeaderNames([])).toEqual([]);
  });

  it('returns the canonical spelling whatever case was requested, without duplicates', () => {
    expect(
      resolvePopulatedHeaderNames(['x-latchkey-matched-service', 'X-LATCHKEY-MATCHED-SERVICE'])
    ).toEqual([MATCHED_SERVICE_HEADER]);
  });

  it('refuses a header Latchkey does not know how to populate', () => {
    expect(() => resolvePopulatedHeaderNames(['X-Latchkey-Foo-Bar'])).toThrow(
      UnknownPopulatedHeaderError
    );
    expect(() => resolvePopulatedHeaderNames(['X-Latchkey-Foo-Bar'])).toThrow(
      /X-Latchkey-Foo-Bar.*Known headers: X-Latchkey-Matched-Service/
    );
  });
});

describe('populateHeadersForCurl', () => {
  const url = 'https://slack.com/api/test';

  it('leaves the arguments alone when no header is requested', () => {
    const curlArguments = ['-H', `${MATCHED_SERVICE_HEADER}: from-the-caller`, url];
    expect(populateHeadersForCurl(curlArguments, [], { matchedServiceName: 'slack' })).toEqual(
      curlArguments
    );
  });

  it('puts the matched service in front of the other arguments', () => {
    expect(
      populateHeadersForCurl(['-H', 'Authorization: Bearer token', url], [MATCHED_SERVICE_HEADER], {
        matchedServiceName: 'slack',
      })
    ).toEqual(['-H', `${MATCHED_SERVICE_HEADER}: slack`, '-H', 'Authorization: Bearer token', url]);
  });

  it('adds nothing when no service was matched', () => {
    expect(
      populateHeadersForCurl(['-sS', url], [MATCHED_SERVICE_HEADER], { matchedServiceName: null })
    ).toEqual(['-sS', url]);
  });

  it.each([
    ['-H value', ['-H', 'X-Latchkey-Matched-Service: github']],
    ['--header value', ['--header', 'x-latchkey-matched-service: github']],
    ['-Hvalue', ['-HX-Latchkey-Matched-Service: github']],
    ['--header=value', ['--header=X-LATCHKEY-MATCHED-SERVICE: github']],
    ['an empty-valued header', ['-H', 'X-Latchkey-Matched-Service;']],
  ])('removes a copy the caller supplied as %s', (_spelling, callerArguments) => {
    const otherArguments = ['-H', 'Accept: */*', url];
    expect(
      populateHeadersForCurl([...callerArguments, ...otherArguments], [MATCHED_SERVICE_HEADER], {
        matchedServiceName: 'slack',
      })
    ).toEqual(['-H', `${MATCHED_SERVICE_HEADER}: slack`, ...otherArguments]);
    expect(
      populateHeadersForCurl([...callerArguments, ...otherArguments], [MATCHED_SERVICE_HEADER], {
        matchedServiceName: null,
      })
    ).toEqual(otherArguments);
  });

  it('keeps a header whose value merely mentions the name', () => {
    const curlArguments = ['-H', `X-Note: ${MATCHED_SERVICE_HEADER}: github`, '-H', url];
    expect(
      populateHeadersForCurl(curlArguments, [MATCHED_SERVICE_HEADER], { matchedServiceName: null })
    ).toEqual(curlArguments);
  });
});
