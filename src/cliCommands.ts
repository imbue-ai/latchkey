/**
 * CLI command implementations with dependency injection for testability.
 */

import type { Command } from 'commander';
import { existsSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { ApiCredentialStore } from './apiCredentials/store.js';
import { ApiCredentials, RawCurlCredentials } from './apiCredentials/base.js';
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
import type { CurlResult } from './curl.js';
import { EncryptedStorage } from './encryptedStorage.js';
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
  servicesList,
  servicesInfo,
  authList,
  authBrowser,
  authBrowserPrepare,
  UnknownServiceError,
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
    curlArguments: readonly string[],
    configPath: string,
    doNotUseBuiltinSchemas: boolean
  ) => Promise<boolean>;
  readonly confirm: (message: string) => Promise<boolean>;
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
    return await callLatchkeyEndpoint(gatewayUrl, request);
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

async function createEncryptedStorageFromConfig(config: Config) {
  const hasEncryptedData =
    existsSync(config.credentialStorePath) || existsSync(config.browserStatePath);
  return EncryptedStorage.create({
    encryptionKeyOverride: config.encryptionKeyOverride,
    serviceName: config.serviceName,
    accountName: config.accountName,
    allowKeyGeneration: !hasEncryptedData,
  });
}

async function clearService(deps: CliDependencies, serviceName: string): Promise<void> {
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
  const deleted = apiCredentialStore.delete(serviceName);

  if (deleted) {
    deps.log(`API credentials for ${serviceName} have been cleared.`);
  } else {
    deps.log(`No API credentials found for ${serviceName}.`);
  }
}

/**
 * Register all CLI commands on the given program.
 */
export function registerCommands(program: Command, deps: CliDependencies): void {
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
    .action(async (serviceName: string) => {
      if (deps.config.gatewayUrl !== null) {
        const info = await forwardToGateway(deps, {
          command: 'services info',
          params: { serviceName },
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
          serviceName
        );
        deps.log(JSON.stringify(info, null, 2));
      } catch (error) {
        if (error instanceof UnknownServiceError) {
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
      const credentials = apiCredentialStore.get(serviceName);
      if (credentials !== null) {
        deps.errorLog(
          `Error: Credentials still exist for '${serviceName}'. ` +
            `Run 'latchkey auth clear ${serviceName}' before deregistering.`
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
    .action(async (serviceName: string | undefined, options: { yes?: boolean }) => {
      refuseInGatewayMode(deps, 'auth clear');
      if (serviceName === undefined) {
        await clearAll(deps, options.yes ?? false);
      } else {
        await clearService(deps, serviceName);
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
      const entries = await authList(deps.registry, apiCredentialStore);
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
      apiCredentialStore.save(serviceName, credentials);
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

      apiCredentialStore.save(serviceName, credentials);
      deps.log('Credentials stored.');
    });

  authCommand
    .command('browser')
    .description('Login to a service via the browser and store the API credentials.')
    .argument('<service_name>', 'Name of the service to login to')
    .action(async (serviceName: string) => {
      if (deps.config.gatewayUrl !== null) {
        await forwardToGateway(deps, {
          command: 'auth browser',
          params: { serviceName },
        });
        deps.log('Done');
        return;
      }
      try {
        const encryptedStorage = await createEncryptedStorageFromConfig(deps.config);
        const apiCredentialStore = new ApiCredentialStore(
          deps.config.credentialStorePath,
          encryptedStorage
        );
        await authBrowser(
          deps.registry,
          apiCredentialStore,
          encryptedStorage,
          deps.config,
          serviceName
        );
        deps.log('Done');
      } catch (error) {
        if (error instanceof UnknownServiceError) {
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
            deps.errorLog(`${ErrorMessages.couldNotExtractUrl} ${error.message}`);
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
            deps.config.gatewayUrl
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
          error instanceof CredentialsExpiredError
        ) {
          deps.errorLog(error.message);
          deps.exit(1);
        }
        throw error;
      }

      const result = deps.runCurl(finalArguments);
      deps.exit(result.returncode);
    });

  program
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

      const encryptedStorage = await createEncryptedStorageFromConfig(deps.config);
      const apiCredentialStore = new ApiCredentialStore(
        deps.config.credentialStorePath,
        encryptedStorage
      );

      const gateway = await startGateway(deps, apiCredentialStore, encryptedStorage, {
        port,
        host: options.host ?? deps.config.gatewayListenHost,
        maxBodySize,
      });

      const shutdown = async () => {
        await gateway.close();
        deps.exit(0);
      };

      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
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
        throw error;
      }
    });
}
