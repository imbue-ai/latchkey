/**
 * CLI command implementations with dependency injection for testability.
 */

import type { Command } from 'commander';
import { existsSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { ApiCredentialStore } from './apiCredentialStore.js';
import { ApiCredentialStatus, ApiCredentials } from './apiCredentials.js';
import { Config, CONFIG } from './config.js';
import type { CurlResult } from './curl.js';
import { EncryptedStorage } from './encryptedStorage.js';
import { Registry, REGISTRY } from './registry.js';
import { LoginCancelledError, LoginFailedError } from './services/index.js';
import { run as curlRun } from './curl.js';

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
  const encryptedStorage = createEncryptedStorageFromConfig(deps.config);
  const latchkeyStore = encryptedStorage.getActualPath(deps.config.credentialStorePath);
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
    .argument('<service_name>', 'Name of the service to check status for')
    .action((serviceName: string) => {
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
      const apiCredentials = apiCredentialStore.get(serviceName);

      if (apiCredentials === null) {
        deps.log(ApiCredentialStatus.Missing);
        return;
      }

      const apiCredentialStatus = service.checkApiCredentials(apiCredentials);
      deps.log(apiCredentialStatus);
    });

  program
    .command('login')
    .description('Login to a service and optionally store the API credentials.')
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

      try {
        const apiCredentials = await service
          .getSession()
          .login(encryptedStorage, deps.config.browserStatePath);
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

      if (apiCredentials === null) {
        try {
          apiCredentials = await service
            .getSession()
            .login(encryptedStorage, deps.config.browserStatePath);
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

      const allArguments = [...apiCredentials.asCurlArguments(), ...curlArguments];
      const result = deps.runCurl(allArguments);
      deps.exit(result.returncode);
    });
}
