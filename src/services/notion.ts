/**
 * Notion service implementation.
 *
 * Browser-based login is not supported. Credentials must be set manually
 * (e.g. by creating an internal integration at the loginUrl below).
 */

import { Service } from './core/base.js';

const NOTION_INTEGRATIONS_URL =
  'https://www.notion.so/profile/integrations/internal/form/new-integration';

export class Notion extends Service {
  readonly name = 'notion';
  readonly displayName = 'Notion';
  readonly baseApiUrls = ['https://api.notion.com/'] as const;
  readonly loginUrl = NOTION_INTEGRATIONS_URL;
  readonly info =
    'If valid credentials are already set for this service, use it with https://developers.notion.com/reference for API reference. ' +
    'Otherwise, prefer the notion-mcp service, which connects to mcp.notion.com and works for both organization and personal Notion spaces. ' +
    'This service has no automated login flow; credentials must be set manually by the user via an internal integration token.';

  readonly credentialCheckCurlArguments = [
    '-H',
    'Notion-Version: 2022-06-28',
    'https://api.notion.com/v1/users/me',
  ] as const;

  setCredentialsExample(serviceName: string): string {
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }
}

export const NOTION = new Notion();
