/**
 * A user-registered service that wraps a built-in "family" service
 * with a custom name and base API URL. Used for self-hosted instances.
 *
 * When no family service is provided, the registered service acts as a
 * generic service that supports `latchkey auth set` for credentials, plus —
 * if a login URL and a cookie key were given — the generic cookie-capturing
 * browser login.
 */

import { ApiCredentialStatus, type ApiCredentials } from '../../apiCredentials/base.js';
import { Service, type ServiceSession } from './base.js';
import type { ResolvedLoginFlow } from './loginFlows.js';

export interface RegisteredServiceOptions {
  /** Built-in service to use as a template, for self-hosted instances. */
  readonly familyService?: Service;
  /** Page opened by `latchkey auth browser`. */
  readonly loginUrl?: string;
  /**
   * Generic browser login to use, already resolved against its parameters.
   * Together with a login URL and without a family service, this gives the
   * service a browser login of its own.
   */
  readonly loginFlow?: ResolvedLoginFlow;
}

export class RegisteredService extends Service {
  readonly name: string;
  readonly displayName: string;
  readonly baseApiUrls: readonly string[];
  readonly loginUrl: string;
  readonly info: string;
  readonly credentialCheckCurlArguments: readonly string[];

  private readonly familyService: Service | undefined;

  constructor(name: string, baseApiUrl: string, options: RegisteredServiceOptions = {}) {
    super();
    const { familyService, loginUrl, loginFlow } = options;
    // A login flow needs a page to start from, and cannot displace the login
    // that a family service already brings.
    const usesLoginFlow =
      loginFlow !== undefined && loginUrl !== undefined && familyService === undefined;

    this.name = name;
    this.displayName = name;
    this.baseApiUrls = [baseApiUrl];
    this.loginUrl = loginUrl ?? '';
    this.credentialCheckCurlArguments = [];
    this.familyService = familyService;

    if (familyService !== undefined) {
      this.info = `Self-hosted ${familyService.displayName} instance. ${familyService.info}`;
    } else if (usesLoginFlow) {
      this.info =
        `Generic service. ${loginFlow.describe(loginUrl)} ` +
        'Alternatively, use `latchkey auth set` to supply credentials as curl arguments.';
    } else {
      this.info =
        'Generic service. Use `latchkey auth set` to supply credentials as curl arguments.';
    }

    if (loginUrl !== undefined && familyService?.getSession !== undefined) {
      this.getSession = (appNamePrefix: string) => familyService.getSession!(appNamePrefix);
    } else if (usesLoginFlow) {
      this.getSession = (appNamePrefix: string) => loginFlow.createSession(this, appNamePrefix);
    }
  }

  override getSession?(appNamePrefix: string): ServiceSession;

  override checkApiCredentials(): Promise<ApiCredentialStatus> {
    return Promise.resolve(ApiCredentialStatus.Unknown);
  }

  // Registered services point at self-hosted instances whose API shape is
  // unknown, so there is no endpoint to ask for an identity.
  getAccount(): Promise<string | null> {
    return Promise.resolve(null);
  }

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
