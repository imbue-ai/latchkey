/**
 * CLI command implementations with dependency injection for testability.
 */

import type { Command } from 'commander';
import { existsSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { ApiCredentialStore } from './apiCredentialStore.js';
import { ApiCredentialStatus, ApiCredentials, RawCurlCredentials } from './apiCredentials.js';
import {
  BROWSER_SOURCES,
  BrowserNotFoundError,
  DEFAULT_BROWSER_SOURCES,
  ensureBrowser,
  loadBrowserConfig,
  type BrowserSource,
} from './browserConfig.js';
import { Config, CONFIG } from './config.js';
import { BrowserDisabledError } from './playwrightUtils.js';
import type { CurlResult } from './curl.js';
import { EncryptedStorage } from './encryptedStorage.js';
import { Registry, REGISTRY } from './registry.js';
import {
  LoginCancelledError,
  LoginFailedError,
  NoCurlCredentialsNotSupportedError,
  Service,
} from './services/index.js';
import { extractUrlFromCurlArguments, run as curlRun } from './curl.js';
import { getSkillMdContent } from './skillMd.js';

/**
 * Try to refresh expired credentials if the service supports it.
 * Returns refreshed credentials if successful, otherwise returns the original credentials.
 */
async function maybeRefreshCredentials(
  service: Service,
  apiCredentials: ApiCredentials,
  apiCredentialStore: ApiCredentialStore
): Promise<ApiCredentials> {
  if (apiCredentials.isExpired() !== true || !service.refreshCredentials) {
    return apiCredentials;
  }
  const refreshedCredentials = await service.refreshCredentials(apiCredentials);
  if (refreshedCredentials !== null) {
    apiCredentialStore.save(service.name, refreshedCredentials);
    return refreshedCredentials;
  }
  return apiCredentials;
}

async function getCredentialStatus(
  service: Service,
  credentials: ApiCredentials | null,
  apiCredentialStore: ApiCredentialStore
): Promise<ApiCredentialStatus> {
  if (credentials === null) {
    return ApiCredentialStatus.Missing;
  }
  const refreshed = await maybeRefreshCredentials(service, credentials, apiCredentialStore);
  return service.checkApiCredentials(refreshed);
}

/**
 * Dependencies that can be injected for testing.
 */
export interface CliDependencies {
  readonly registry: Registry;
  readonly config: Config;
  readonly runCurl: (args: readonly string[]) => CurlResult;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly exit: (code: number) => never;
  readonly log: (message: string) => void;
  readonly errorLog: (message: string) => void;
}

/**
 * Default implementation of CLI dependencies.
 */
export function createDefaultDependencies(): CliDependencies {
  return {
    registry: REGISTRY,
    config: CONFIG,
    runCurl: curlRun,
    confirm: defaultConfirm,
    exit: (code: number) => process.exit(code),
    log: (message: string) => {
      console.log(message);
    },
    errorLog: (message: string) => {
      console.error(message);
    },
  };
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

function createEncryptedStorageFromConfig(config: Config) {
  return new EncryptedStorage({
    encryptionKeyOverride: config.encryptionKeyOverride,
    serviceName: config.serviceName,
    accountName: config.accountName,
  });
}

function clearService(deps: CliDependencies, serviceName: string): void {
  const service = deps.registry.getByName(serviceName);
  if (service === null) {
    deps.errorLog(`Error: Unknown service: ${serviceName}`);
    deps.errorLog("Use 'latchkey services list' to see available services.");
    deps.exit(1);
  }

  const encryptedStorage = createEncryptedStorageFromConfig(deps.config);
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
 * Check if browser login is disabled via environment variable.
 * Exits with error if LATCHKEY_DISABLE_BROWSER is set.
 */
function checkBrowserNotDisabledOrExit(deps: CliDependencies): void {
  if (deps.config.browserDisabled) {
    deps.errorLog(new BrowserDisabledError().message);
    deps.exit(1);
  }
}

/**
 * Get the browser launch options from configuration, handling errors with CLI output.
 * Exits with error if no valid browser config exists or if browser is disabled.
 */
function getBrowserLaunchOptionsOrExit(deps: CliDependencies): {
  browserStatePath: string;
  executablePath: string;
} {
  checkBrowserNotDisabledOrExit(deps);

  const browserConfig = loadBrowserConfig(deps.config.configPath);
  if (!browserConfig) {
    deps.errorLog("Error: No browser configured. Run 'latchkey ensure-browser' first.");
    deps.exit(1);
  }
  return {
    browserStatePath: deps.config.browserStatePath,
    executablePath: browserConfig.executablePath,
  };
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
    .action(() => {
      const serviceNames = deps.registry.services.map((service) => service.name);
      deps.log(JSON.stringify(serviceNames, null, 2));
    });

  servicesCommand
    .command('info')
    .description('Show information about a service.')
    .argument('<service_name>', 'Name of the service to get info for')
    .action(async (serviceName: string) => {
      const service = deps.registry.getByName(serviceName);
      if (service === null) {
        deps.errorLog(`Error: Unknown service: ${serviceName}`);
        deps.errorLog("Use 'latchkey services list' to see available services.");
        deps.exit(1);
      }

      // Login options
      const supportsBrowser = service.getSession !== undefined && !deps.config.browserDisabled;
      const authOptions = supportsBrowser ? ['browser', 'set'] : ['set'];

      // Credentials status
      const encryptedStorage = createEncryptedStorageFromConfig(deps.config);
      const apiCredentialStore = new ApiCredentialStore(
        deps.config.credentialStorePath,
        encryptedStorage
      );
      const apiCredentials = apiCredentialStore.get(serviceName);
      const credentialStatus = await getCredentialStatus(
        service,
        apiCredentials,
        apiCredentialStore
      );

      const info = {
        authOptions,
        credentialStatus,
        setCredentialsExample: service.setCredentialsExample(serviceName),
        developerNotes: service.info,
      };
      deps.log(JSON.stringify(info, null, 2));
    });

  const authCommand = program.command('auth').description('Manage authentication credentials.');

  authCommand
    .command('clear')
    .description('Clear stored API credentials.')
    .argument('[service_name]', 'Name of the service to clear API credentials for')
    .option('-y, --yes', 'Skip confirmation prompt when clearing all data')
    .action(async (serviceName: string | undefined, options: { yes?: boolean }) => {
      if (serviceName === undefined) {
        await clearAll(deps, options.yes ?? false);
      } else {
        clearService(deps, serviceName);
      }
    });

  authCommand
    .command('list')
    .description('List all stored credentials and their status.')
    .action(async () => {
      const encryptedStorage = createEncryptedStorageFromConfig(deps.config);
      const apiCredentialStore = new ApiCredentialStore(
        deps.config.credentialStorePath,
        encryptedStorage
      );

      const allCredentials = apiCredentialStore.getAll();

      const statusChecks = Array.from(
        allCredentials,
        async ([serviceName, credentials]): Promise<
          readonly [string, { credentialType: string; credentialStatus: ApiCredentialStatus }]
        > => {
          const service = deps.registry.getByName(serviceName);
          const credentialStatus =
            service !== null
              ? await getCredentialStatus(service, credentials, apiCredentialStore)
              : ApiCredentialStatus.Valid;

          return [serviceName, { credentialType: credentials.objectType, credentialStatus }];
        }
      );

      const entries = Object.fromEntries(await Promise.all(statusChecks));

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
    .action((_serviceName: string, _options: unknown, command: { args: string[] }) => {
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

      const encryptedStorage = createEncryptedStorageFromConfig(deps.config);
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
    .description('Store credentials for a service using service-specific arguments (not curl).')
    .argument('<service_name>', 'Name of the service to store credentials for')
    .addHelpText('after', `\nExample:\n  $ latchkey auth set-nocurl telegram <bot-token>`)
    .allowExcessArguments()
    .action((_serviceName: string, _options: unknown, command: { args: string[] }) => {
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

      const encryptedStorage = createEncryptedStorageFromConfig(deps.config);
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
      const service = deps.registry.getByName(serviceName);
      if (service === null) {
        deps.errorLog(`Error: Unknown service: ${serviceName}`);
        deps.errorLog("Use 'latchkey services list' to see available services.");
        deps.exit(1);
      }

      const session = service.getSession?.();
      if (!session) {
        deps.errorLog(
          `Service '${serviceName}' does not support browser flows. ` +
            `Use '${service.setCredentialsExample(serviceName)}' to set credentials manually.`
        );
        deps.exit(1);
      }

      const encryptedStorage = createEncryptedStorageFromConfig(deps.config);
      const apiCredentialStore = new ApiCredentialStore(
        deps.config.credentialStorePath,
        encryptedStorage
      );

      const oldCredentials = apiCredentialStore.get(service.name);
      if (session.prepare && oldCredentials === null) {
        deps.errorLog(`Error: Service ${serviceName} requires preparation first.`);
        deps.errorLog(`Run 'latchkey auth browser-prepare ${serviceName}' before logging in.`);
        deps.exit(1);
      }
      const launchOptions = getBrowserLaunchOptionsOrExit(deps);

      try {
        const apiCredentials = await session.login(
          encryptedStorage,
          launchOptions,
          oldCredentials ?? undefined
        );
        apiCredentialStore.save(service.name, apiCredentials);
        deps.log('Done');
      } catch (error) {
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
      const service = deps.registry.getByName(serviceName);
      if (service === null) {
        deps.errorLog(`Error: Unknown service: ${serviceName}`);
        deps.errorLog("Use 'latchkey services list' to see available services.");
        deps.exit(1);
      }

      const session = service.getSession?.();
      if (!session?.prepare) {
        deps.log('This service does not require a preparation step.');
        return;
      }

      const encryptedStorage = createEncryptedStorageFromConfig(deps.config);
      const apiCredentialStore = new ApiCredentialStore(
        deps.config.credentialStorePath,
        encryptedStorage
      );

      // Check if already prepared (credentials exist)
      const existingCredentials = apiCredentialStore.get(service.name);
      if (existingCredentials !== null) {
        deps.log('Already prepared.');
        return;
      }

      const launchOptions = getBrowserLaunchOptionsOrExit(deps);

      try {
        const apiCredentials = await session.prepare(encryptedStorage, launchOptions);
        apiCredentialStore.save(service.name, apiCredentials);
        deps.log('Done');
      } catch (error) {
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

      const url = extractUrlFromCurlArguments(curlArguments);
      if (url === null) {
        deps.errorLog('Error: Could not extract URL from curl arguments.');
        deps.exit(1);
      }

      const service = deps.registry.getByUrl(url);
      if (service === null) {
        deps.errorLog(`Error: No service matches URL: ${url}`);
        deps.exit(1);
      }

      const encryptedStorage = createEncryptedStorageFromConfig(deps.config);
      const apiCredentialStore = new ApiCredentialStore(
        deps.config.credentialStorePath,
        encryptedStorage
      );
      let apiCredentials: ApiCredentials | null = apiCredentialStore.get(service.name);

      // Check if credentials exist but are expired
      const isExpired = apiCredentials?.isExpired() === true;

      if (apiCredentials === null) {
        deps.errorLog(`Error: No credentials found for ${service.name}.`);
        deps.errorLog(
          `Run 'latchkey auth browser ${service.name}' or 'latchkey auth set ${service.name}' first.`
        );
        deps.exit(1);
      }

      if (isExpired) {
        apiCredentials = await maybeRefreshCredentials(service, apiCredentials, apiCredentialStore);

        if (apiCredentials.isExpired() === true) {
          deps.errorLog(`Error: Credentials for ${service.name} are expired.`);
          deps.errorLog(
            `Run 'latchkey auth browser ${service.name}' or 'latchkey auth set ${service.name}' to refresh them.`
          );
          deps.exit(1);
        }
      }

      const allArguments = apiCredentials.injectIntoCurlCall(curlArguments);
      const result = deps.runCurl(allArguments);
      deps.exit(result.returncode);
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
