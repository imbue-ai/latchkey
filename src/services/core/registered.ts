/**
 * A user-registered service that wraps a built-in "family" service
 * with a custom name and base API URL. Used for self-hosted instances.
 *
 * When no family service is provided, the registered service acts as a
 * generic service that supports `latchkey auth set` for credentials, plus —
 * if a login URL and a login flow were given — a browser login of its own.
 */

import { ApiCredentialStatus, type ApiCredentials } from '../../apiCredentials/base.js';
import { Service, type LoginFlow, type ServiceSession } from './base.js';

/**
 * Where a registered service gets its browser login, if anywhere. The two
 * sources are mutually exclusive — a family service already brings its own
 * login and credential shape — so they are alternatives rather than fields
 * that happen not to be combined. Omitting the options entirely leaves the
 * service with `latchkey auth set` only.
 *
 * The `never` markers are what make the exclusion stick: a plain union of the
 * two shapes would still accept an object carrying both, because excess
 * property checking against a union permits any property known to some member.
 */
export type RegisteredServiceOptions =
  | {
      /** Built-in service to use as a template, for self-hosted instances. */
      readonly familyService: Service;
      /** Page opened by `latchkey auth browser`, for families that support it. */
      readonly loginUrl?: string;
      readonly loginFlow?: never;
    }
  | {
      /** Generic browser login, already configured with its parameters. */
      readonly loginFlow: LoginFlow;
      /** Page the flow starts from. A flow has nowhere to begin without one. */
      readonly loginUrl: string;
      readonly familyService?: never;
    };

/**
 * Build options from values that are each independently optional, as they come
 * out of the CLI and out of config.json.
 *
 * This is the one place where a family service and a login flow can meet, so it
 * is also where their precedence is decided: the family wins, since its login
 * and credential shape are what the rest of the service is built on. Callers
 * that construct options directly are held to the exclusion by the type.
 */
export function buildRegisteredServiceOptions(
  familyService: Service | undefined,
  loginUrl: string | undefined,
  loginFlow: LoginFlow | undefined
): RegisteredServiceOptions | undefined {
  if (familyService !== undefined) {
    return { familyService, loginUrl };
  }
  if (loginFlow !== undefined && loginUrl !== undefined) {
    return { loginFlow, loginUrl };
  }
  return undefined;
}

export class RegisteredService extends Service {
  readonly name: string;
  readonly displayName: string;
  readonly baseApiUrls: readonly string[];
  readonly loginUrl: string;
  readonly info: string;
  readonly credentialCheckCurlArguments: readonly string[];

  private readonly familyService: Service | undefined;

  constructor(name: string, baseApiUrl: string, options?: RegisteredServiceOptions) {
    super();
    const familyService = options?.familyService;
    const loginUrl = options?.loginUrl;
    // The options type rules out a flow without a page to open, and a flow
    // alongside a family service, for TypeScript callers. This repeats the
    // checks because latchkey is also consumed as a library from JavaScript.
    const usableLoginFlow =
      options?.loginFlow !== undefined && loginUrl !== undefined && familyService === undefined
        ? { flow: options.loginFlow, loginUrl }
        : undefined;

    this.name = name;
    this.displayName = name;
    this.baseApiUrls = [baseApiUrl];
    this.loginUrl = loginUrl ?? '';
    this.credentialCheckCurlArguments = [];
    this.familyService = familyService;

    if (familyService !== undefined) {
      this.info = `Self-hosted ${familyService.displayName} instance. ${familyService.info}`;
    } else if (usableLoginFlow !== undefined) {
      this.info =
        `Generic service. ${usableLoginFlow.flow.describe(usableLoginFlow.loginUrl)} ` +
        'Alternatively, use `latchkey auth set` to supply credentials as curl arguments.';
    } else {
      this.info =
        'Generic service. Use `latchkey auth set` to supply credentials as curl arguments.';
    }

    if (loginUrl !== undefined && familyService?.getSession !== undefined) {
      this.getSession = (appNamePrefix: string) => familyService.getSession!(appNamePrefix);
    } else if (usableLoginFlow !== undefined) {
      this.getSession = (appNamePrefix: string) =>
        usableLoginFlow.flow.createSession(this, appNamePrefix);
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
