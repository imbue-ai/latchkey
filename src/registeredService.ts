/**
 * A user-registered service that wraps a built-in "family" service
 * with a custom name and base API URL. Used for self-hosted instances.
 *
 * When no family service is provided, the registered service acts as a
 * generic service that only supports `latchkey auth set` for credentials.
 */

import type { ApiCredentials } from './apiCredentials.js';
import { Service, type ServiceSession } from './services/base.js';

export class RegisteredService extends Service {
  readonly name: string;
  readonly displayName: string;
  readonly baseApiUrls: readonly string[];
  readonly loginUrl: string;
  readonly info: string;
  readonly credentialCheckCurlArguments: readonly string[];

  private readonly familyService: Service | undefined;

  constructor(name: string, baseApiUrl: string, familyService?: Service, loginUrl?: string) {
    super();
    this.name = name;
    this.displayName = name;
    this.baseApiUrls = [baseApiUrl];
    this.loginUrl = loginUrl ?? '';
    this.credentialCheckCurlArguments = [];
    this.familyService = familyService;

    if (familyService !== undefined) {
      this.info = `Self-hosted ${familyService.displayName} instance. ${familyService.info}`;
    } else {
      this.info =
        'Generic service. Use `latchkey auth set` to supply credentials as curl arguments.';
    }

    if (loginUrl !== undefined && familyService?.getSession !== undefined) {
      this.getSession = () => familyService.getSession!();
    }
  }

  override getSession?(): ServiceSession;

  setCredentialsExample(serviceName: string): string {
    if (this.familyService !== undefined) {
      return this.familyService.setCredentialsExample(serviceName);
    }
    return `latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`;
  }

  override getCredentialsNoCurl(arguments_: readonly string[]): ApiCredentials {
    if (this.familyService !== undefined) {
      return this.familyService.getCredentialsNoCurl(arguments_);
    }
    return super.getCredentialsNoCurl(arguments_);
  }
}
