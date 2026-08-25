/**
 * Fastmail CardDAV / CalDAV service implementation.
 *
 * Separate from the `fastmail` service, which speaks JMAP, because the two take
 * different credentials against different hosts. Fastmail's OAuth access tokens
 * are accepted only by the JMAP API; the DAV endpoints refuse them (401 on every
 * collection, including the principal URL) and want an **app password** over
 * HTTP Basic auth instead. Fastmail's own documentation draws the same line: an
 * API token is "for JMAP access", an app password is "for everything else".
 *
 * Splitting by host also keeps URL matching unambiguous. `latchkey curl` picks
 * among services that match a URL by registration order, with no way for a
 * caller to name the one it wants, so two services claiming the same host would
 * be a coin flip. These hosts are disjoint from the JMAP ones.
 *
 * The credential is an app password from Settings → Privacy & Security →
 * "Connected apps & API tokens" → "Manage app passwords and access", used with
 * the account's own e-mail address as the username. Its "DAV" access level is
 * enough.
 *
 * One failure worth recognizing: on an account with no active subscription
 * (observed on a lapsed trial) app passwords appear to be refused for every
 * legacy protocol, and the refusal is a 401 reading "Incorrect username,
 * password or access token" — indistinguishable from a typo — while JMAP over
 * an API token or OAuth keeps working. Subscribing restored DAV with no change
 * to any request. An IMAP login against imap.fastmail.com with the same
 * credential tells the two apart: refused there too points at the account
 * rather than the credential.
 */

import type { ApiCredentials } from '../apiCredentials/base.js';
import { fetchAccountFromEndpoint } from '../apiCredentials/account.js';
import { Service } from './core/base.js';

/**
 * A `current-user-principal` PROPFIND (RFC 5397). Depth 0 keeps it to the
 * collection itself, and the response names the principal of whoever
 * authenticated — which is how this doubles as the account lookup.
 */
const PRINCIPAL_PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>';

const PRINCIPAL_CHECK_CURL_ARGUMENTS = [
  '-X',
  'PROPFIND',
  '-H',
  'Depth: 0',
  '-H',
  'Content-Type: application/xml; charset=utf-8',
  '--data-binary',
  PRINCIPAL_PROPFIND_BODY,
  'https://carddav.fastmail.com/dav/principals/',
] as const;

/**
 * Pull the account out of a `current-user-principal` response. Fastmail's
 * principal hrefs carry the account's e-mail, e.g.
 * `/dav/principals/user/someone@fastmail.com/`.
 *
 * Matched with a regular expression rather than parsed as XML: latchkey has no
 * XML parser, the shape is fixed by RFC 5397, and the alternative is taking on a
 * dependency to read one href.
 */
function parseAccountFromPrincipalResponse(responseBody: string): string | null {
  return /\/dav\/principals\/user\/([^/<>"]+)/.exec(responseBody)?.[1] ?? null;
}

export class FastmailDav extends Service {
  readonly name = 'fastmail-dav';
  readonly displayName = 'Fastmail (CardDAV/CalDAV)';

  /**
   * Contacts and calendars live on their own hosts, and — unlike the JMAP API —
   * these are not region-sharded: `/.well-known/carddav` redirects within
   * `carddav.fastmail.com` rather than off to a shard. The optional prefix is
   * defensive, so a future shard would not need a new registration.
   */
  readonly baseApiUrls = [
    /^https:\/\/([a-z0-9-]+[.-])?carddav\.fastmail\.com\//,
    /^https:\/\/([a-z0-9-]+[.-])?caldav\.fastmail\.com\//,
  ] as const;

  readonly loginUrl = 'https://app.fastmail.com/settings/security';

  readonly info =
    'https://www.fastmail.com/dev/ — contacts over CardDAV (RFC 6352) and calendars over ' +
    'CalDAV (RFC 4791), rooted at /dav/addressbooks and /dav/calendars. ' +
    'Credentials are an app password, rather than the OAuth token the `fastmail` service uses. ' +
    'The `fastmail` service can also reach contacts over JMAP, which is the better route unless a ' +
    'caller needs DAV specifically.';

  readonly credentialCheckCurlArguments = PRINCIPAL_CHECK_CURL_ARGUMENTS;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -u "you@fastmail.com:<app password>"`;
  }

  /**
   * WebDAV answers a successful PROPFIND with 207 Multi-Status (RFC 4918 §13),
   * so the inherited 200-only check would report every working app password as
   * invalid.
   */
  protected override isCredentialCheckResponseValid(httpStatusCode: string): boolean {
    return httpStatusCode === '207' || httpStatusCode === '200';
  }

  override getAccount(apiCredentials: ApiCredentials): Promise<string | null> {
    return fetchAccountFromEndpoint(
      apiCredentials,
      this.credentialCheckCurlArguments,
      parseAccountFromPrincipalResponse
    );
  }
}

export const FASTMAIL_DAV = new FastmailDav();
