/**
 * A user-registered service that wraps a built-in "family" service
 * with a custom name and base API URL. Used for self-hosted instances.
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

  private readonly familyService: Service;

  constructor(name: string, baseApiUrl: string, familyService: Service, loginUrl?: string) {
    super();
    this.name = name;
    this.displayName = name;
    this.baseApiUrls = [baseApiUrl];
    this.loginUrl = loginUrl ?? '';
    this.info = `Self-hosted ${familyService.displayName} instance. ${familyService.info}`;
    this.credentialCheckCurlArguments = [];
    this.familyService = familyService;

    if (loginUrl !== undefined && familyService.getSession !== undefined) {
      this.getSession = () => familyService.getSession!();
    }
  }

  override getSession?(): ServiceSession;

  setCredentialsExample(serviceName: string): string {
    return this.familyService.setCredentialsExample(serviceName);
  }

  override getCredentialsNoCurl(arguments_: readonly string[]): ApiCredentials {
    return this.familyService.getCredentialsNoCurl(arguments_);
  }
}
