/**
 * CLI command implementations with dependency injection for testability.
 */

import type { Command } from 'commander';
import { existsSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { ApiCredentialStore } from './apiCredentialStore.js';
import { ApiCredentialStatus, ApiCredentials } from './apiCredentials.js';
import {
  BROWSER_SOURCES,
  BrowserNotFoundError,
  DEFAULT_BROWSER_SOURCES,
  ensureBrowser,
  loadBrowserConfig,
  type BrowserSource,
} from './browserConfig.js';
import { Config, CONFIG } from './config.js';
import type { CurlResult } from './curl.js';
import { EncryptedStorage } from './encryptedStorage.js';
import { Registry, REGISTRY } from './registry.js';
import { LoginCancelledError, LoginFailedError, Service } from './services/index.js';
import { run as curlRun } from './curl.js';
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
  if (!apiCredentials.isExpired?.() || !service.refreshCredentials) {
    return apiCredentials;
  }
  const refreshedCredentials = await service.refreshCredentials(apiCredentials);
  if (refreshedCredentials !== null) {
    apiCredentialStore.save(service.name, refreshedCredentials);
    return refreshedCredentials;
  }
  return apiCredentials;
}

// Curl flags that don't affect the HTTP request semantics but may not be supported by URL extraction.
const CURL_PASSTHROUGH_FLAGS = new Set(['-v', '--verbose']);

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

function filterPassthroughFlags(args: string[]): string[] {
  return args.filter((arg) => !CURL_PASSTHROUGH_FLAGS.has(arg));
}

export function extractUrlFromCurlArguments(args: string[]): string | null {
  const filteredArgs = filterPassthroughFlags(args);

  // Simple URL extraction: look for arguments that look like URLs
  // or parse known curl argument patterns
  for (let i = 0; i < filteredArgs.length; i++) {
    const arg = filteredArgs[i];
    if (arg === undefined) continue;

    // Skip flags and their values
    if (arg.startsWith('-')) {
      // Skip flags that take a value
      if (['-H', '-d', '-X', '-o', '-w', '-u', '-A', '-e', '-b', '-c', '-F', '-T'].includes(arg)) {
        i++; // Skip the next argument which is the value
      }
      continue;
    }

    // This looks like a URL
    if (arg.startsWith('http://') || arg.startsWith('https://')) {
      return arg;
    }
  }

  return null;
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
    deps.errorLog("Use 'latchkey services' to see available services.");
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
 * Get the browser launch options from configuration, handling errors with CLI output.
 * Exits with error if no valid browser config exists.
 */
function getBrowserLaunchOptionsOrExit(deps: CliDependencies): {
  browserStatePath: string;
  executablePath: string;
} {
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
  program
    .command('services')
    .description('List known and supported third-party services.')
    .action(() => {
      const serviceNames = deps.registry.services.map((service) => service.name);
      deps.log(serviceNames.join(' '));
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

  program
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

  program
    .command('status')
    .description('Check the API credential status for a service.')
    .argument('[service_name]', 'Name of the service to check status for')
    .action(async (serviceName: string | undefined) => {
      const encryptedStorage = createEncryptedStorageFromConfig(deps.config);
      const apiCredentialStore = new ApiCredentialStore(
        deps.config.credentialStorePath,
        encryptedStorage
      );

      if (serviceName === undefined) {
        for (const service of deps.registry.services) {
          let apiCredentials = apiCredentialStore.get(service.name);
          if (apiCredentials === null) {
            deps.log(`${service.name}: ${ApiCredentialStatus.Missing}`);
          } else {
            apiCredentials = await maybeRefreshCredentials(
              service,
              apiCredentials,
              apiCredentialStore
            );
            const status = service.checkApiCredentials(apiCredentials);
            deps.log(`${service.name}: ${status}`);
          }
        }
        return;
      }

      const service = deps.registry.getByName(serviceName);
      if (service === null) {
        deps.errorLog(`Error: Unknown service: ${serviceName}`);
        deps.errorLog("Use 'latchkey services' to see available services.");
        deps.exit(1);
      }

      let apiCredentials = apiCredentialStore.get(serviceName);

      if (apiCredentials === null) {
        deps.log(ApiCredentialStatus.Missing);
        return;
      }

      apiCredentials = await maybeRefreshCredentials(service, apiCredentials, apiCredentialStore);

      const apiCredentialStatus = service.checkApiCredentials(apiCredentials);
      deps.log(apiCredentialStatus);
    });

  program
    .command('login')
    .description('Login to a service and store the API credentials.')
    .argument('<service_name>', 'Name of the service to login to')
    .action(async (serviceName: string) => {
      const service = deps.registry.getByName(serviceName);
      if (service === null) {
        deps.errorLog(`Error: Unknown service: ${serviceName}`);
        deps.errorLog("Use 'latchkey services' to see available services.");
        deps.exit(1);
      }

      const encryptedStorage = createEncryptedStorageFromConfig(deps.config);
      const apiCredentialStore = new ApiCredentialStore(
        deps.config.credentialStorePath,
        encryptedStorage
      );

      const oldCredentials = apiCredentialStore.get(service.name);
      if (service.prepare && oldCredentials === null) {
        deps.errorLog(`Error: Service ${serviceName} requires preparation first.`);
        deps.errorLog(`Run 'latchkey prepare ${serviceName}' before logging in.`);
        deps.exit(1);
      }

      const launchOptions = getBrowserLaunchOptionsOrExit(deps);

      try {
        const apiCredentials = await service
          .getSession()
          .login(encryptedStorage, launchOptions, oldCredentials ?? undefined);
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

  program
    .command('prepare')
    .description('Prepare a service for use.')
    .argument('<service_name>', 'Name of the service to prepare')
    .action(async (serviceName: string) => {
      const service = deps.registry.getByName(serviceName);
      if (service === null) {
        deps.errorLog(`Error: Unknown service: ${serviceName}`);
        deps.errorLog("Use 'latchkey services' to see available services.");
        deps.exit(1);
      }

      if (!service.prepare) {
        deps.errorLog(`Error: Service ${serviceName} does not support the prepare command.`);
        deps.exit(1);
      }

      const encryptedStorage = createEncryptedStorageFromConfig(deps.config);
      const apiCredentialStore = new ApiCredentialStore(
        deps.config.credentialStorePath,
        encryptedStorage
      );
      const launchOptions = getBrowserLaunchOptionsOrExit(deps);

      try {
        const apiCredentials = await service.prepare(encryptedStorage, launchOptions);
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
      const isExpired = apiCredentials?.isExpired?.() ?? false;

      if (apiCredentials === null || isExpired) {
        // Check if service requires preparation first
        if (service.prepare && apiCredentials === null) {
          deps.errorLog(`Error: Service ${service.name} requires preparation first.`);
          deps.errorLog(`Run 'latchkey prepare ${service.name}' before using curl.`);
          deps.exit(1);
        }

        // Try to refresh credentials if the service supports it and credentials are expired
        if (isExpired && apiCredentials !== null) {
          apiCredentials = await maybeRefreshCredentials(
            service,
            apiCredentials,
            apiCredentialStore
          );
        }

        // If we still don't have valid credentials, perform login
        if (apiCredentials === null || apiCredentials.isExpired?.()) {
          const launchOptions = getBrowserLaunchOptionsOrExit(deps);

          try {
            // Pass old credentials to login() if they're expired (to reuse client ID/secret)
            const oldCredentials =
              isExpired && apiCredentials !== null ? apiCredentials : undefined;
            apiCredentials = await service
              .getSession()
              .login(encryptedStorage, launchOptions, oldCredentials);
            apiCredentialStore.save(service.name, apiCredentials);
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
        }
      }

      const allArguments = [...apiCredentials.asCurlArguments(), ...curlArguments];
      const result = deps.runCurl(allArguments);
      deps.exit(result.returncode);
    });
}
