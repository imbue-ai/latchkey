/**
 * CLI command implementations with dependency injection for testability.
 */

import type { Command } from 'commander';
import { existsSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  AmbiguousAccountError,
  ApiCredentialStore,
  ApiCredentialStoreError,
} from './apiCredentials/store.js';
import {
  ApiCredentials,
  ApiCredentialsUsageError,
  RawCurlCredentials,
} from './apiCredentials/base.js';
import {
  CredentialsExpiredError,
  NoCredentialsForServiceError,
  NoServiceForUrlError,
  prepareCurlInvocation,
  RequestNotPermittedError,
  UrlExtractionFailedError,
} from './curlInjection.js';
import {
  BROWSER_SOURCES,
  BrowserNotFoundError,
  DEFAULT_BROWSER_SOURCES,
  ensureBrowser,
  type BrowserSource,
} from './browserConfig.js';
import { Config, CONFIG } from './config.js';
import { deleteRegisteredService, saveRegisteredService } from './configDataStore.js';
import {
  BrowserDisabledError,
  BrowserFlowsNotSupportedError,
  GraphicalEnvironmentNotFoundError,
} from './playwrightUtils.js';
import { BrowserFeaturesUnavailableError, loadPlaywright } from './playwrightLoader.js';
import type { CurlResult } from './curl.js';
import { EncryptedStorage, EncryptedStorageError } from './encryptedStorage.js';
import { encrypt, EncryptionError, resolveEncryptionKey } from './encryption.js';
import {
  DuplicateServiceNameError,
  InvalidServiceNameError,
  ServiceRegistry,
  SERVICE_REGISTRY,
  canonicalizeServiceName,
} from './serviceRegistry.js';
import { RegisteredService } from './services/core/registered.js';
import {
  LoginCancelledError,
  LoginFailedError,
  NoCurlCredentialsNotSupportedError,
  PrepareInputInvalidError,
  PrepareNotSupportedError,
  Service,
} from './services/index.js';
import {
  CurlParseError,
  extractUrlFromCurlArguments,
  run as curlRun,
  runAsync as curlRunAsync,
} from './curl.js';
import { checkPermission, PermissionCheckError } from './permissions.js';
import { ErrorMessages } from './errorMessages.js';
import { getSkillMdContent } from './skillMd.js';
import { startGateway } from './gateway/server.js';
import {
  callLatchkeyEndpoint,
  GatewayCommandNotSupportedError,
  GatewayCurlRewriteError,
  GatewayRequestError,
  rewriteCurlArgumentsForGateway,
} from './gateway/client.js';
import type { LatchkeyRequest } from './gateway/latchkeyEndpoint.js';
import {
  createPermissionsOverrideJwt,
  derivePermissionsOverrideSigningKey,
  InvalidPermissionsOverrideError,
} from './gateway/permissionsOverride.js';
import {
  servicesList,
  servicesInfo,
  authList,
  authBrowser,
  authBrowserPrepare,
  prepareService,
  UnknownServiceError,
  AccountNotFoundError,
  BrowserNotConfiguredError,
  PreparationRequiredError,
} from './sharedOperations.js';
import { VERSION } from './version.js';

/**
 * Exit code used when a request is rejected by permission rules.
 * Uses the Unix convention for "command not permitted" (126).
 * Curl itself does not use this exit code.
 */
export const PERMISSION_DENIED_EXIT_CODE = 126;

/**
 * Dependencies that can be injected for testing.
 */
export interface CliDependencies {
  readonly registry: ServiceRegistry;
  readonly config: Config;
  readonly runCurl: (args: readonly string[]) => CurlResult;
  readonly runCurlAsync: typeof curlRunAsync;
  readonly checkPermission: (
    request: Request,
    configPath: string,
    doNotUseBuiltinSchemas: boolean
  ) => Promise<boolean>;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly readStdin: () => Promise<string>;
  readonly exit: (code: number) => never;
  readonly log: (message: string) => void;
  readonly errorLog: (message: string) => void;
  readonly version: string;
}

/**
 * Default implementation of CLI dependencies.
 */
export function createDefaultDependencies(): CliDependencies {
  return {
    registry: SERVICE_REGISTRY,
    config: CONFIG,
    runCurl: curlRun,
    runCurlAsync: curlRunAsync,
    checkPermission: checkPermission,
    confirm: defaultConfirm,
    readStdin: defaultReadStdin,
    exit: (code: number) => process.exit(code),
    log: (message: string) => {
      console.log(message);
    },
    errorLog: (message: string) => {
      console.error(message);
    },
    version: VERSION,
  };
}

/**
 * Forward a request to the gateway's `/latchkey/` endpoint. On transport or
 * protocol errors the CLI exits with status 1 after logging the error message.
 */
async function forwardToGateway(deps: CliDependencies, request: LatchkeyRequest): Promise<unknown> {
  const gatewayUrl = deps.config.gatewayUrl;
  if (gatewayUrl === null) {
    throw new GatewayCommandNotSupportedError(request.command);
  }
  try {
    return await callLatchkeyEndpoint(
      gatewayUrl,
      request,
      deps.config.gatewayPassword,
      deps.config.gatewayPermissionsOverride
    );
  } catch (error) {
    if (error instanceof GatewayRequestError) {
      deps.errorLog(`Error: ${error.message}`);
      deps.exit(1);
    }
    throw error;
  }
}

/**
 * If the CLI is running in gateway mode, log an error and exit. Used for
 * commands that manage local state and cannot be meaningfully delegated.
 */
function refuseInGatewayMode(deps: CliDependencies, commandName: string): void {
  if (deps.config.gatewayUrl !== null) {
    const error = new GatewayCommandNotSupportedError(commandName);
    deps.errorLog(`Error: ${error.message}`);
    deps.exit(1);
  }
}

async function defaultReadStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function defaultConfirm(message: string): Promise<boolean> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    readline.question(`${message} (y/N) `, (answer) => {
      readline.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

async function clearAll(deps: CliDependencies, yes: boolean): Promise<void> {
  const latchkeyStore = deps.config.credentialStorePath;
  const browserState = deps.config.browserStatePath;

  const filesToDelete: string[] = [];
  if (existsSync(latchkeyStore)) {
    filesToDelete.push(latchkeyStore);
  }
  if (existsSync(browserState)) {
    filesToDelete.push(browserState);
  }

  if (filesToDelete.length === 0) {
    deps.log('No files to delete.');
    return;
  }

  if (!yes) {
    deps.log('This will delete the following files:');
    for (const filePath of filesToDelete) {
      deps.log(`  ${filePath}`);
    }

    const confirmed = await deps.confirm('Are you sure you want to continue?');
    if (!confirmed) {
      deps.log('Aborted.');
      deps.exit(1);
    }
  }

  for (const filePath of filesToDelete) {
    unlinkSync(filePath);
    if (filePath === latchkeyStore) {
      deps.log(`Deleted credentials store: ${filePath}`);
    } else {
      deps.log(`Deleted browser state: ${filePath}`);
    }
  }
}

async function resolveEncryptionKeyFromConfig(config: Config): Promise<string> {
  const hasEncryptedData =
    existsSync(config.credentialStorePath) || existsSync(config.browserStatePath);
  return resolveEncryptionKey({
    encryptionKeyOverride: config.encryptionKeyOverride,
    serviceName: config.serviceName,
    accountName: config.accountName,
    allowKeyGeneration: !hasEncryptedData,
  });
}

async function createEncryptedStorageFromConfig(config: Config): Promise<EncryptedStorage> {
  const key = await resolveEncryptionKeyFromConfig(config);
  return new EncryptedStorage(key);
}

async function clearService(
  deps: CliDependencies,
  serviceName: string,
  account: string | undefined,
  all: boolean
): Promise<void> {
  const service = deps.registry.getByName(serviceName);
  if (service === null) {
    deps.errorLog(`Error: Unknown service: ${serviceName}`);
    deps.errorLog("Use 'latchkey services list' to see available services.");
    deps.exit(1);
  }

  const encryptedStorage = await createEncryptedStorageFromConfig(deps.config);
  const apiCredentialStore = new ApiCredentialStore(
    deps.config.credentialStorePath,
    encryptedStorage
  );

  let deleted: boolean;
  try {
    deleted = all
      ? apiCredentialStore.deleteAll(serviceName)
      : apiCredentialStore.delete(serviceName, account);
  } catch (error) {
    if (error instanceof AmbiguousAccountError) {
      deps.errorLog(`Error: ${error.message}`);
      deps.exit(1);
    }
    throw error;
  }

  if (deleted) {
    deps.log(`API credentials for ${serviceName} have been cleared.`);
  } else {
    deps.log(`No API credentials found for ${serviceName}.`);
  }
}

/**
 * Build the "Done" message for a completed browser flow, naming the account the
 * credentials were stored under when it is not the default (unnamed) account.
 */
function loginDoneMessage(account: string | undefined): string {
  return account !== undefined && account !== ''
    ? `Done. Stored credentials for account '${account}'.`
    : 'Done';
}

/**
 * Build the space-separated command path (e.g. "auth set") for a command,
 * excluding the root program name.
 */
function fullCommandPath(command: Command): string {
  const parts: string[] = [];
  let current: Command = command;
  while (current.parent) {
    parts.unshift(current.name());
    current = current.parent;
  }
  return parts.join(' ');
}

/**
 * Register all CLI commands on the given program.
 */
export function registerCommands(program: Command, deps: CliDependencies): void {
  program.option(
    '--account <account>',
    "Account (e.g. an e-mail) whose credentials to use. Supported by 'curl', " +
      "'auth set', 'auth set-nocurl', 'auth clear', and 'auth browser'. Required " +
      'when a service has more than one stored account.'
  );

  // The account is a global option; commander exposes it on the root program
  // regardless of which subcommand is invoked.
  const getAccount = (): string | undefined => program.opts<{ account?: string }>().account;

  // Only these commands act on a specific account. Every other command must
  // reject --account rather than silently ignore it, so users are never misled
  // into thinking it took effect.
  const accountAwareCommands = new Set([
    'curl',
    'auth set',
    'auth set-nocurl',
    'auth clear',
    'auth browser',
  ]);
  program.hook('preAction', (_thisCommand, actionCommand) => {
    if (getAccount() === undefined) {
      return;
    }
    const commandPath = fullCommandPath(actionCommand);
    if (!accountAwareCommands.has(commandPath)) {
      deps.errorLog(`Error: The --account option is not supported by 'latchkey ${commandPath}'.`);
      deps.exit(1);
    }
  });

  const servicesCommand = program
    .command('services')
    .description('Manage and inspect supported services.');

  servicesCommand
    .command('list')
    .description('List all supported services.')
    .option('--builtin', 'Only list built-in services (exclude registered services)')
    .option(
      '--viable',
      'Only list services that either have stored credentials or can be authenticated via a browser.'
    )
    .action(async (options: { builtin?: boolean; viable?: boolean }) => {
      if (deps.config.gatewayUrl !== null) {
        const result = await forwardToGateway(deps, {
          command: 'services list',
          params: options,
        });
        deps.log(JSON.stringify(result, null, 2));
        return;
      }
      const encryptedStorage = await createEncryptedStorageFromConfig(deps.config);
      const apiCredentialStore = new ApiCredentialStore(
        deps.config.credentialStorePath,
        encryptedStorage
      );
      const result = servicesList(deps.registry, apiCredentialStore, deps.config, options);
      deps.log(JSON.stringify(result, null, 2));
    });

  servicesCommand
    .command('info')
    .description('Show information about a service.')
    .argument('<service_name>', 'Name of the service to get info for')
    .option(
      '--offline',
      'Do not send a request to validate credentials; report them as only "missing" or "unknown".'
    )
    .action(async (serviceName: string, options: { offline?: boolean }) => {
      if (deps.config.gatewayUrl !== null) {
        const info = await forwardToGateway(deps, {
          command: 'services info',
          params: { serviceName, offline: options.offline },
        });
        deps.log(JSON.stringify(info, null, 2));
        return;
      }
      try {
        const encryptedStorage = await createEncryptedStorageFromConfig(deps.config);
        const apiCredentialStore = new ApiCredentialStore(
          deps.config.credentialStorePath,
          encryptedStorage
        );
        const info = await servicesInfo(
          deps.registry,
          apiCredentialStore,
          deps.config,
          serviceName,
          options.offline ?? false
        );
        deps.log(JSON.stringify(info, null, 2));
      } catch (error) {
        if (error instanceof UnknownServiceError || error instanceof AmbiguousAccountError) {
          deps.errorLog(`Error: ${error.message}`);
          deps.exit(1);
        }
        throw error;
      }
    });

  servicesCommand
    .command('register')
    .description('Register a self-hosted service instance.')
    .argument('<service_name>', 'Name for the new service')
    .requiredOption('--base-api-url <url>', 'Base API URL for the self-hosted instance')
    .option(
      '--service-family <name>',
      'Name of the built-in service to use as a template, if any (e.g. gitlab)'
    )
    .option('--login-url <url>', 'Login URL for browser-based authentication, if applicable')
    .action(
      (
        rawServiceName: string,
        options: { baseApiUrl: string; serviceFamily?: string; loginUrl?: string }
      ) => {
        refuseInGatewayMode(deps, 'services register');
        let serviceName: string;
        try {
          serviceName = canonicalizeServiceName(rawServiceName);
        } catch (error) {
          if (error instanceof InvalidServiceNameError) {
            deps.errorLog(`Error: ${error.message}`);
            deps.exit(1);
          }
          throw error;
        }

        let familyService: Service | undefined;
        if (options.serviceFamily !== undefined) {
          familyService = deps.registry.getByName(options.serviceFamily) ?? undefined;
          if (familyService === undefined) {
            deps.errorLog(`Error: Unknown service family: ${options.serviceFamily}`);
            deps.errorLog(
              "Use 'latchkey services list --builtin' to see available service families."
            );
            deps.exit(1);
          }
        }

        if (options.loginUrl !== undefined) {
          if (familyService === undefined) {
            deps.errorLog(
              'Error: --login-url requires a --service-family that supports browser login.'
            );
            deps.exit(1);
          } else if (familyService.getSession === undefined) {
            deps.errorLog(
              `Error: Service family '${options.serviceFamily!}' does not support browser login, so --login-url is not applicable.`
            );
            deps.exit(1);
          }
        } else if (familyService?.getSession !== undefined) {
          deps.errorLog(
            `Error: Service family '${options.serviceFamily!}' supports browser login, so --login-url is required.`
          );
          deps.exit(1);
        }

        const registeredService = new RegisteredService(
          serviceName,
          options.baseApiUrl,
          familyService,
          options.loginUrl
        );

        try {
          deps.registry.addService(registeredService);
        } catch (error) {
          if (error instanceof DuplicateServiceNameError) {
            deps.errorLog(`Error: ${error.message}`);
            deps.exit(1);
          }
          throw error;
        }

        saveRegisteredService(deps.config.configPath, serviceName, {
          baseApiUrl: options.baseApiUrl,
          serviceFamily: options.serviceFamily,
          loginUrl: options.loginUrl,
        });

        deps.log(`Service '${serviceName}' registered.`);
      }
    );

  servicesCommand
    .command('deregister')
    .description('Deregister a previously registered service instance.')
    .argument('<service_name>', 'Name of the registered service to remove')
    .action(async (serviceName: string) => {
      refuseInGatewayMode(deps, 'services deregister');
      const service = deps.registry.getByName(serviceName);
      if (service === null) {
        deps.errorLog(`Error: Unknown service: ${serviceName}`);
        deps.exit(1);
      }

      if (!(service instanceof RegisteredService)) {
        deps.errorLog(
          `Error: Service '${serviceName}' is a built-in service and cannot be deregistered.`
        );
        deps.exit(1);
      }

      const encryptedStorage = await createEncryptedStorageFromConfig(deps.config);
      const apiCredentialStore = new ApiCredentialStore(
        deps.config.credentialStorePath,
        encryptedStorage
      );
      if (
        apiCredentialStore.listAccounts(serviceName).length > 0 ||
        apiCredentialStore.getPreparation(serviceName) !== null
      ) {
        deps.errorLog(
          `Error: Credentials or a preparation still exist for '${serviceName}'. ` +
            `Run 'latchkey auth clear ${serviceName} --all' before deregistering.`
        );
        deps.exit(1);
      }

      deleteRegisteredService(deps.config.configPath, serviceName);

      deps.log(`Service '${serviceName}' deregistered.`);
    });

  const authCommand = program.command('auth').description('Manage authentication credentials.');

  authCommand
    .command('clear')
    .description('Clear stored API credentials.')
    .argument('[service_name]', 'Name of the service to clear API credentials for')
    .option('-y, --yes', 'Skip confirmation prompt when clearing all data')
    .option('--all', "Clear all of the service's accounts as well as its preparation (if any)")
    .action(async (serviceName: string | undefined, options: { yes?: boolean; all?: boolean }) => {
      refuseInGatewayMode(deps, 'auth clear');
      const all = options.all ?? false;
      if (all && serviceName === undefined) {
        deps.errorLog('Error: --all requires a service name.');
        deps.exit(1);
      }
      if (all && getAccount() !== undefined) {
        deps.errorLog('Error: --all cannot be combined with --account.');
        deps.exit(1);
      }
      if (serviceName === undefined) {
        await clearAll(deps, options.yes ?? false);
      } else {
        await clearService(deps, serviceName, getAccount(), all);
      }
    });

  authCommand
    .command('list')
    .description('List all stored credentials and their status.')
    .action(async () => {
      if (deps.config.gatewayUrl !== null) {
        const entries = await forwardToGateway(deps, { command: 'auth list' });
        deps.log(JSON.stringify(entries, null, 2));
        return;
      }
      const encryptedStorage = await createEncryptedStorageFromConfig(deps.config);
      const apiCredentialStore = new ApiCredentialStore(
        deps.config.credentialStorePath,
        encryptedStorage
      );
      const entries = await authList(deps.registry, apiCredentialStore, deps.config);
      deps.log(JSON.stringify(entries, null, 2));
    });

  authCommand
    .command('set')
    .description('Store credentials for a service in the form of arbitrary curl arguments.')
    .argument('<service_name>', 'Name of the service to store credentials for')
    .addHelpText(
      'after',
      `\nExample:\n  $ latchkey auth set slack -H "Authorization: Bearer xoxb-your-token"`
    )
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (_serviceName: string, _options: unknown, command: { args: string[] }) => {
      refuseInGatewayMode(deps, 'auth set');
      const [serviceName, ...curlArguments] = command.args;
      if (serviceName === undefined) {
        deps.errorLog('Error: Service name is required.');
        deps.exit(1);
      }

      const service = deps.registry.getByName(serviceName);
      if (service === null) {
        deps.errorLog(`Error: Unknown service: ${serviceName}`);
        deps.errorLog("Use 'latchkey services list' to see available services.");
        deps.exit(1);
      }

      if (!curlArguments.some((argument) => argument.startsWith('-'))) {
        deps.errorLog(
          "Error: Arguments don't look like valid curl options (expected at least one switch starting with '-')."
        );
        deps.errorLog(
          `Example: latchkey auth set ${serviceName} -H "Authorization: Bearer <token>"`
        );
        deps.exit(1);
      }

      const encryptedStorage = await createEncryptedStorageFromConfig(deps.config);
      const apiCredentialStore = new ApiCredentialStore(
        deps.config.credentialStorePath,
        encryptedStorage
      );

      const credentials = new RawCurlCredentials(curlArguments);
      try {
        apiCredentialStore.save(serviceName, credentials, getAccount());
      } catch (error) {
        if (error instanceof AmbiguousAccountError) {
          deps.errorLog(`Error: ${error.message}`);
          deps.exit(1);
        }
        throw error;
      }
      deps.log('Credentials stored.');
    });

  authCommand
    .command('set-nocurl')
    .description(
      'Store credentials using service-specific arguments (not curl). ' +
        'Useful for services that cannot express their credentials ' +
        'as static curl arguments. Arguments are passed to the service ' +
        'implementation to modify latchkey curl requests on the fly.'
    )
    .argument('<service_name>', 'Name of the service to store credentials for')
    .addHelpText(
      'after',
      `\nExample:\n  $ latchkey auth set-nocurl aws <access-key-id> <secret-access-key>`
    )
    .allowExcessArguments()
    .action(async (_serviceName: string, _options: unknown, command: { args: string[] }) => {
      refuseInGatewayMode(deps, 'auth set-nocurl');
      const [serviceName, ...noCurlArguments] = command.args;
      if (serviceName === undefined) {
        deps.errorLog('Error: Service name is required.');
        deps.exit(1);
      }

      const service = deps.registry.getByName(serviceName);
      if (service === null) {
        deps.errorLog(`Error: Unknown service: ${serviceName}`);
        deps.errorLog("Use 'latchkey services list' to see available services.");
        deps.exit(1);
      }

      const encryptedStorage = await createEncryptedStorageFromConfig(deps.config);
      const apiCredentialStore = new ApiCredentialStore(
        deps.config.credentialStorePath,
        encryptedStorage
      );

      let credentials: ApiCredentials;
      try {
        credentials = service.getCredentialsNoCurl(noCurlArguments);
      } catch (error) {
        if (error instanceof NoCurlCredentialsNotSupportedError) {
          deps.errorLog(`Error: ${error.message}`);
          deps.exit(1);
        }
        throw error;
      }

      try {
        apiCredentialStore.save(serviceName, credentials, getAccount());
      } catch (error) {
        if (error instanceof AmbiguousAccountError) {
          deps.errorLog(`Error: ${error.message}`);
          deps.exit(1);
        }
        throw error;
      }
      deps.log('Credentials stored.');
    });

  authCommand
    .command('browser')
    .description('Login to a service via the browser and store the API credentials.')
    .argument('<service_name>', 'Name of the service to login to')
    .action(async (serviceName: string) => {
      if (deps.config.gatewayUrl !== null) {
        const result = (await forwardToGateway(deps, {
          command: 'auth browser',
          params: { serviceName, account: getAccount() },
        })) as { account?: string } | null;
        deps.log(loginDoneMessage(result?.account));
        return;
      }
      try {
        const encryptedStorage = await createEncryptedStorageFromConfig(deps.config);
        const apiCredentialStore = new ApiCredentialStore(
          deps.config.credentialStorePath,
          encryptedStorage
        );
        const { account } = await authBrowser(
          deps.registry,
          apiCredentialStore,
          encryptedStorage,
          deps.config,
          serviceName,
          getAccount()
        );
        deps.log(loginDoneMessage(account));
      } catch (error) {
        if (error instanceof UnknownServiceError || error instanceof AccountNotFoundError) {
          deps.errorLog(`Error: ${error.message}`);
          deps.exit(1);
        }
        if (error instanceof BrowserFlowsNotSupportedError) {
          deps.errorLog(error.message);
          deps.exit(1);
        }
        if (error instanceof PreparationRequiredError) {
          deps.errorLog(`Error: ${error.message}`);
          deps.exit(1);
        }
        if (error instanceof BrowserDisabledError) {
          deps.errorLog(error.message);
          deps.exit(1);
        }
        if (error instanceof GraphicalEnvironmentNotFoundError) {
          deps.errorLog(error.message);
          deps.exit(1);
        }
        if (error instanceof BrowserNotConfiguredError) {
          deps.errorLog(`Error: ${error.message}`);
          deps.exit(1);
        }
        if (error instanceof LoginCancelledError) {
          deps.errorLog('Login cancelled.');
          deps.exit(1);
        }
        if (error instanceof LoginFailedError) {
          deps.errorLog(error.message);
          deps.exit(1);
        }
        if (error instanceof BrowserFeaturesUnavailableError) {
          deps.errorLog(error.message);
          deps.exit(1);
        }
        throw error;
      }
    });

  authCommand
    .command('browser-prepare')
    .description('Prepare a service to be used with the browser command.')
    .argument('<service_name>', 'Name of the service to prepare')
    .action(async (serviceName: string) => {
      if (deps.config.gatewayUrl !== null) {
        const result = (await forwardToGateway(deps, {
          command: 'auth browser-prepare',
          params: { serviceName },
        })) as { alreadyPrepared?: boolean } | null;
        if (result !== null && result.alreadyPrepared === true) {
          deps.log('Already prepared.');
        } else {
          deps.log('Done');
        }
        return;
      }
      try {
        const encryptedStorage = await createEncryptedStorageFromConfig(deps.config);
        const apiCredentialStore = new ApiCredentialStore(
          deps.config.credentialStorePath,
          encryptedStorage
        );
        const result = await authBrowserPrepare(
          deps.registry,
          apiCredentialStore,
          encryptedStorage,
          deps.config,
          serviceName
        );
        if (result.alreadyPrepared) {
          deps.log('Already prepared.');
        } else {
          deps.log('Done');
        }
      } catch (error) {
        if (error instanceof UnknownServiceError) {
          deps.errorLog(`Error: ${error.message}`);
          deps.exit(1);
        }
        if (error instanceof BrowserDisabledError) {
          deps.errorLog(error.message);
          deps.exit(1);
        }
        if (error instanceof GraphicalEnvironmentNotFoundError) {
          deps.errorLog(error.message);
          deps.exit(1);
        }
        if (error instanceof BrowserNotConfiguredError) {
          deps.errorLog(`Error: ${error.message}`);
          deps.exit(1);
        }
        if (error instanceof LoginCancelledError) {
          deps.errorLog('Preparation cancelled.');
          deps.exit(1);
        }
        if (error instanceof LoginFailedError) {
          deps.errorLog(error.message);
          deps.exit(1);
        }
        if (error instanceof BrowserFeaturesUnavailableError) {
          deps.errorLog(error.message);
          deps.exit(1);
        }
        throw error;
      }
    });

  authCommand
    .command('prepare')
    .description(
      "Register a service's client details (e.g. an OAuth client id/secret) from a JSON payload, for use during login."
    )
    .argument('<service_name>', 'Name of the service to prepare')
    .argument(
      '<json>',
      'Service-specific registration JSON, e.g. \'{"clientId":"...","clientSecret":"..."}\''
    )
    .addHelpText(
      'after',
      `\nExample:\n  $ latchkey auth prepare google-gmail '{"clientId":"<id>","clientSecret":"<secret>"}'`
    )
    .action(async (serviceName: string, json: string) => {
      if (deps.config.gatewayUrl !== null) {
        await forwardToGateway(deps, {
          command: 'auth prepare',
          params: { serviceName, json },
        });
        deps.log(`Done`);
        return;
      }
      try {
        const encryptedStorage = await createEncryptedStorageFromConfig(deps.config);
        const apiCredentialStore = new ApiCredentialStore(
          deps.config.credentialStorePath,
          encryptedStorage
        );
        prepareService(deps.registry, apiCredentialStore, serviceName, json);
        deps.log(`Done`);
      } catch (error) {
        if (
          error instanceof UnknownServiceError ||
          error instanceof PrepareNotSupportedError ||
          error instanceof PrepareInputInvalidError
        ) {
          deps.errorLog(`Error: ${error.message}`);
          deps.exit(1);
        }
        throw error;
      }
    });

  program
    .command('curl')
    .description('Run curl with API credential injection.')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (_options: unknown, command: { args: string[] }) => {
      const curlArguments = command.args;

      if (deps.config.gatewayUrl !== null) {
        let targetUrl: string | null;
        try {
          targetUrl = extractUrlFromCurlArguments(curlArguments);
        } catch (error) {
          if (error instanceof CurlParseError) {
            if (error.message) {
              deps.errorLog(`${ErrorMessages.couldNotExtractUrlBrief} ${error.message}`);
            } else {
              deps.errorLog(`${ErrorMessages.couldNotExtractUrl} ${error.message}`);
            }
            deps.exit(1);
          }
          throw error;
        }
        if (targetUrl === null) {
          deps.errorLog(ErrorMessages.couldNotExtractUrl);
          deps.exit(1);
        }
        let rewritten: readonly string[];
        try {
          rewritten = rewriteCurlArgumentsForGateway(
            curlArguments,
            targetUrl,
            deps.config.gatewayUrl,
            deps.config.gatewayPassword,
            deps.config.gatewayPermissionsOverride
          );
        } catch (error) {
          if (error instanceof GatewayCurlRewriteError) {
            deps.errorLog(`Error: ${error.message}`);
            deps.exit(1);
          }
          throw error;
        }
        const result = deps.runCurl(rewritten);
        deps.exit(result.returncode);
      }

      const encryptedStorage = await createEncryptedStorageFromConfig(deps.config);
      const apiCredentialStore = new ApiCredentialStore(
        deps.config.credentialStorePath,
        encryptedStorage
      );

      let finalArguments: readonly string[];
      try {
        finalArguments = await prepareCurlInvocation(curlArguments, apiCredentialStore, {
          registry: deps.registry,
          checkPermission: deps.checkPermission,
          permissionsConfigPath: deps.config.permissionsConfigPath,
          permissionsDoNotUseBuiltinSchemas: deps.config.permissionsDoNotUseBuiltinSchemas,
          passthroughUnknown: deps.config.passthroughUnknown,
          credentialsRefreshDisabled: deps.config.credentialsRefreshDisabled,
          account: getAccount(),
        });
      } catch (error) {
        if (error instanceof RequestNotPermittedError) {
          deps.errorLog(error.message);
          deps.exit(PERMISSION_DENIED_EXIT_CODE);
        }
        if (error instanceof PermissionCheckError) {
          deps.errorLog(`Error: ${error.message}`);
          deps.exit(PERMISSION_DENIED_EXIT_CODE);
        }
        if (
          error instanceof UrlExtractionFailedError ||
          error instanceof NoServiceForUrlError ||
          error instanceof NoCredentialsForServiceError ||
          error instanceof CredentialsExpiredError ||
          error instanceof AmbiguousAccountError ||
          error instanceof ApiCredentialsUsageError
        ) {
          deps.errorLog(error.message);
          deps.exit(1);
        }
        throw error;
      }

      const result = deps.runCurl(finalArguments);
      deps.exit(result.returncode);
    });

  const gatewayCommand = program
    .command('gateway')
    .description('Start a local HTTP gateway that proxies requests with credential injection.')
    .option(
      '--port <number>',
      `Port to listen on (default: ${deps.config.gatewayListenPort.toString()}, configurable via config.json key 'gatewayListenPort')`
    )
    .option(
      '--host <address>',
      `Address to bind to (default: ${deps.config.gatewayListenHost}, configurable via config.json key 'gatewayListenHost')`
    )
    .option(
      '--max-body-size <bytes>',
      'Maximum request body size in bytes',
      String(10 * 1024 * 1024)
    )
    .action(async (options: { port?: string; host?: string; maxBodySize: string }) => {
      refuseInGatewayMode(deps, 'gateway');
      const portString = options.port ?? deps.config.gatewayListenPort.toString();
      const port = parseInt(portString, 10);
      if (isNaN(port) || port < 0 || port > 65535) {
        deps.errorLog(`Error: Invalid port number: ${portString}`);
        deps.exit(1);
      }

      const maxBodySize = parseInt(options.maxBodySize, 10);
      if (isNaN(maxBodySize) || maxBodySize <= 0) {
        deps.errorLog(`Error: Invalid max body size: ${options.maxBodySize}`);
        deps.exit(1);
      }

      const encryptionKey = await resolveEncryptionKeyFromConfig(deps.config);
      const encryptedStorage = new EncryptedStorage(encryptionKey);
      const apiCredentialStore = new ApiCredentialStore(
        deps.config.credentialStorePath,
        encryptedStorage
      );

      const gateway = await startGateway(deps, apiCredentialStore, encryptedStorage, {
        port,
        host: options.host ?? deps.config.gatewayListenHost,
        maxBodySize,
        password: deps.config.gatewayListenPassword,
        permissionsOverrideSigningKey: derivePermissionsOverrideSigningKey(encryptionKey),
      });

      const shutdown = async () => {
        await gateway.close();
        deps.exit(0);
      };

      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
    });

  gatewayCommand
    .command('create-jwt')
    .description(
      'Create a permissions-override JWT for the X-Latchkey-Gateway-Permissions-Override header. ' +
        'When the gateway receives a valid JWT, it uses the referenced permissions.json ' +
        'instead of the default one for that single request.'
    )
    .argument('<permissions_config_path>', 'Absolute path to a permissions.json file')
    .argument(
      '[additional_claims]',
      'Optional JSON object whose fields are merged into the JWT payload alongside the default ' +
        'claims. Must be a JSON-encoded object whose keys do not collide with the claims this ' +
        'command adds itself.'
    )
    .option(
      '--no-validate',
      'Skip checking that the path exists; only validate that it is absolute'
    )
    .action(
      async (
        permissionsConfigPath: string,
        additionalClaimsJson: string | undefined,
        options: { validate: boolean }
      ) => {
        refuseInGatewayMode(deps, 'gateway create-jwt');
        if (options.validate) {
          if (!existsSync(permissionsConfigPath)) {
            deps.errorLog(`Error: File does not exist: ${permissionsConfigPath}`);
            deps.errorLog('Pass --no-validate to skip this check.');
            deps.exit(1);
          }
        }
        let additionalClaims: Record<string, unknown> = {};
        if (additionalClaimsJson !== undefined) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(additionalClaimsJson);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            deps.errorLog(`Error: Additional claims must be valid JSON: ${detail}`);
            deps.exit(1);
            return;
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            deps.errorLog('Error: Additional claims must be a JSON object.');
            deps.exit(1);
            return;
          }
          additionalClaims = parsed as Record<string, unknown>;
        }
        const encryptionKey = await resolveEncryptionKeyFromConfig(deps.config);
        try {
          const jwt = createPermissionsOverrideJwt(
            permissionsConfigPath,
            derivePermissionsOverrideSigningKey(encryptionKey),
            additionalClaims
          );
          deps.log(jwt);
        } catch (error) {
          if (error instanceof InvalidPermissionsOverrideError) {
            deps.errorLog(`Error: ${error.message}`);
            deps.exit(1);
          }
          throw error;
        }
      }
    );

  authCommand
    .command('re-encrypt')
    .description(
      'Re-encrypt stored credentials with a new key and write them into a ' +
        'destination directory, using the same filename Latchkey itself expects. ' +
        'The new key is read from stdin so that it does not appear in the process ' +
        'arguments or shell history. When stdin is empty, the existing encryption ' +
        'key is reused.'
    )
    .argument(
      '<destination_directory>',
      'Directory to write the re-encrypted credential store into'
    )
    .option(
      '--services <services...>',
      'Only include these services in the new encrypted store (default: all stored services)'
    )
    .addHelpText(
      'after',
      `\nExamples:\n  $ openssl rand -base64 32 | latchkey auth re-encrypt ~/latchkey-export` +
        `\n  $ echo "" | latchkey auth re-encrypt ~/latchkey-export --services gitlab slack`
    )
    .action(async (destinationDirectory: string, options: { services?: string[] }) => {
      refuseInGatewayMode(deps, 'auth re-encrypt');

      if (existsSync(destinationDirectory) && !statSync(destinationDirectory).isDirectory()) {
        deps.errorLog(`Error: Destination is not a directory: ${destinationDirectory}`);
        deps.exit(1);
      }

      const destination = join(destinationDirectory, basename(deps.config.credentialStorePath));
      if (existsSync(destination)) {
        deps.errorLog(`Error: Destination file already exists: ${destination}`);
        deps.errorLog('Remove it first or choose a different destination directory.');
        deps.exit(1);
      }

      const sourceKey = await resolveEncryptionKeyFromConfig(deps.config);

      // An empty stdin means "reuse the existing encryption key".
      const stdinKey = (await deps.readStdin()).trim();
      const destinationKey = stdinKey === '' ? sourceKey : stdinKey;
      // Validate the key up front using the encryption routine itself, rather
      // than duplicating its key-format checks.
      try {
        encrypt('', destinationKey);
      } catch (error) {
        if (error instanceof EncryptionError) {
          deps.errorLog(`Error: ${error.message}. Generate a key with: openssl rand -base64 32`);
          deps.exit(1);
        }
        throw error;
      }

      const sourceStorage = new EncryptedStorage(sourceKey);
      const sourceStore = new ApiCredentialStore(deps.config.credentialStorePath, sourceStorage);

      let allCredentials: ReadonlyMap<string, ReadonlyMap<string, ApiCredentials>>;
      try {
        allCredentials = sourceStore.getAll();
      } catch (error) {
        if (error instanceof ApiCredentialStoreError || error instanceof EncryptedStorageError) {
          deps.errorLog(`Error: ${error.message}`);
          deps.exit(1);
        }
        throw error;
      }

      let selectedServiceNames: string[];
      if (options.services !== undefined) {
        const missing = options.services.filter((name) => !allCredentials.has(name));
        if (missing.length > 0) {
          deps.errorLog(`Error: No stored credentials for: ${missing.join(', ')}`);
          deps.exit(1);
        }
        selectedServiceNames = options.services;
      } else {
        selectedServiceNames = [...allCredentials.keys()];
      }

      if (selectedServiceNames.length === 0) {
        deps.errorLog('Error: No stored credentials found to re-encrypt.');
        deps.exit(1);
      }

      const destinationStorage = new EncryptedStorage(destinationKey);
      const destinationStore = new ApiCredentialStore(destination, destinationStorage);
      for (const serviceName of selectedServiceNames) {
        const accountMap = allCredentials.get(serviceName);
        if (accountMap !== undefined) {
          for (const [account, credentials] of accountMap) {
            destinationStore.save(serviceName, credentials, account);
          }
        }
        const preparation = sourceStore.getPreparation(serviceName);
        if (preparation !== null) {
          destinationStore.savePreparation(serviceName, preparation);
        }
      }

      deps.log(`Re-encrypted ${String(selectedServiceNames.length)} service(s) to ${destination}.`);
    });

  program
    .command('skill-md')
    .description('Print the SKILL.md file for AI agent integration.')
    .action(async () => {
      deps.log(await getSkillMdContent());
    });

  program
    .command('ensure-browser')
    .description('Ensure a Chrome/Chromium browser is available for Latchkey to use.')
    .option(
      '--source <sources>',
      `Comma-separated list of sources to try in order: ${BROWSER_SOURCES.join(', ')}`,
      DEFAULT_BROWSER_SOURCES.join(',')
    )
    .action(async (options: { source: string }) => {
      refuseInGatewayMode(deps, 'ensure-browser');
      const configPath = deps.config.configPath;

      // Parse and validate sources
      const sourceList = options.source.split(',').map((s) => s.trim());
      const invalidSources = sourceList.filter(
        (s) => !BROWSER_SOURCES.includes(s as BrowserSource)
      );
      if (invalidSources.length > 0) {
        deps.errorLog(`Error: Invalid source(s): ${invalidSources.join(', ')}`);
        deps.errorLog(`Valid sources: ${BROWSER_SOURCES.join(', ')}`);
        deps.exit(1);
      }
      const sources = sourceList as BrowserSource[];

      // In the standalone binary, playwright is not available at runtime.
      // Refuse `ensure-browser` up front rather than silently succeeding via
      // a stale `existing-config` source that points to a browser we could
      // never actually launch anyway.
      try {
        await loadPlaywright();
      } catch (error) {
        if (error instanceof BrowserFeaturesUnavailableError) {
          deps.errorLog(error.message);
          deps.exit(1);
        }
        throw error;
      }

      deps.log(`Discovering browser using sources: ${sources.join(', ')}`);

      try {
        const { config, source } = await ensureBrowser(configPath, sources);
        deps.log('');
        deps.log('Browser configured successfully:');
        deps.log(`  Path: ${config.executablePath}`);
        deps.log(`  Found via: ${source}`);
        if (source !== 'existing-config') {
          deps.log(`  Config saved to: ${configPath}`);
        }
      } catch (error) {
        if (error instanceof BrowserNotFoundError) {
          deps.errorLog(`Error: ${error.message}`);
          deps.exit(1);
        }
        if (error instanceof BrowserFeaturesUnavailableError) {
          deps.errorLog(error.message);
          deps.exit(1);
        }
        throw error;
      }
    });
}
