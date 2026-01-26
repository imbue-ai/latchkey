#!/usr/bin/env node

/**
 * Command-line interface for latchkey.
 */

import { program } from 'commander';
import { existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ApiCredentialStore } from './apiCredentialStore.js';
import { ApiCredentialStatus } from './apiCredentials.js';
import { getBrowserStatePath } from './browserState.js';
import { run as runCurl } from './curl.js';
import { REGISTRY } from './registry.js';
import { LoginCancelledError, LoginFailedError } from './services/index.js';

const LATCHKEY_STORE_ENV_VAR = 'LATCHKEY_STORE';

// Curl flags that don't affect the HTTP request semantics but may not be supported by URL extraction.
const CURL_PASSTHROUGH_FLAGS = new Set(['-v', '--verbose']);

function filterPassthroughFlags(args: string[]): string[] {
  return args.filter((arg) => !CURL_PASSTHROUGH_FLAGS.has(arg));
}

function extractUrlFromCurlArguments(args: string[]): string | null {
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

function getLatchkeyStorePath(): string | null {
  const envValue = process.env[LATCHKEY_STORE_ENV_VAR];
  if (envValue) {
    if (envValue.startsWith('~')) {
      return resolve(homedir(), envValue.slice(2));
    }
    return resolve(envValue);
  }
  return null;
}

async function confirm(message: string): Promise<boolean> {
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

async function clearAll(yes: boolean): Promise<void> {
  const latchkeyStore = getLatchkeyStorePath();
  const browserState = getBrowserStatePath();

  const filesToDelete: string[] = [];
  if (latchkeyStore !== null && existsSync(latchkeyStore)) {
    filesToDelete.push(latchkeyStore);
  }
  if (browserState !== null && existsSync(browserState)) {
    filesToDelete.push(browserState);
  }

  if (filesToDelete.length === 0) {
    console.log('No files to delete.');
    return;
  }

  if (!yes) {
    console.log('This will delete the following files:');
    for (const filePath of filesToDelete) {
      console.log(`  ${filePath}`);
    }

    const confirmed = await confirm('Are you sure you want to continue?');
    if (!confirmed) {
      console.log('Aborted.');
      process.exit(1);
    }
  }

  for (const filePath of filesToDelete) {
    unlinkSync(filePath);
    if (filePath === latchkeyStore) {
      console.log(`Deleted credentials store: ${filePath}`);
    } else {
      console.log(`Deleted browser state: ${filePath}`);
    }
  }
}

function clearService(serviceName: string): void {
  const service = REGISTRY.getByName(serviceName);
  if (service === null) {
    console.error(`Error: Unknown service: ${serviceName}`);
    console.error("Use 'latchkey services' to see available services.");
    process.exit(1);
  }

  const latchkeyStore = getLatchkeyStorePath();
  if (latchkeyStore === null) {
    console.error(`Error: ${LATCHKEY_STORE_ENV_VAR} environment variable is not set.`);
    process.exit(1);
  }

  const apiCredentialStore = new ApiCredentialStore(latchkeyStore);
  const deleted = apiCredentialStore.delete(serviceName);

  if (deleted) {
    console.log(`API credentials for ${serviceName} have been cleared.`);
  } else {
    console.log(`No API credentials found for ${serviceName}.`);
  }
}

program
  .name('latchkey')
  .description(
    'A command-line tool that injects API credentials to curl requests to known public APIs.'
  )
  .version('0.1.0');

program
  .command('services')
  .description('List known and supported third-party services.')
  .action(() => {
    const serviceNames = REGISTRY.services.map((service) => service.name);
    console.log(JSON.stringify(serviceNames));
  });

program
  .command('clear')
  .description('Clear stored API credentials.')
  .argument('[service_name]', 'Name of the service to clear API credentials for')
  .option('-y, --yes', 'Skip confirmation prompt when clearing all data')
  .action(async (serviceName: string | undefined, options: { yes?: boolean }) => {
    if (serviceName === undefined) {
      await clearAll(options.yes ?? false);
    } else {
      clearService(serviceName);
    }
  });

program
  .command('status')
  .description('Check the API credential status for a service.')
  .argument('<service_name>', 'Name of the service to check status for')
  .action((serviceName: string) => {
    const service = REGISTRY.getByName(serviceName);
    if (service === null) {
      console.error(`Error: Unknown service: ${serviceName}`);
      console.error("Use 'latchkey services' to see available services.");
      process.exit(1);
    }

    const latchkeyStore = getLatchkeyStorePath();
    if (latchkeyStore === null) {
      console.log(ApiCredentialStatus.Missing);
      return;
    }

    const apiCredentialStore = new ApiCredentialStore(latchkeyStore);
    const apiCredentials = apiCredentialStore.get(serviceName);

    if (apiCredentials === null) {
      console.log(ApiCredentialStatus.Missing);
      return;
    }

    const apiCredentialStatus = service.checkApiCredentials(apiCredentials);
    console.log(apiCredentialStatus);
  });

program
  .command('login')
  .description('Login to a service and optionally store the API credentials.')
  .argument('<service_name>', 'Name of the service to login to')
  .action(async (serviceName: string) => {
    const service = REGISTRY.getByName(serviceName);
    if (service === null) {
      console.error(`Error: Unknown service: ${serviceName}`);
      console.error("Use 'latchkey services' to see available services.");
      process.exit(1);
    }

    const latchkeyStore = getLatchkeyStorePath();
    const apiCredentialStore = latchkeyStore ? new ApiCredentialStore(latchkeyStore) : null;

    const browserStatePath = getBrowserStatePath();
    try {
      const apiCredentials = await service.getSession().login(browserStatePath);
      if (apiCredentialStore !== null) {
        apiCredentialStore.save(service.name, apiCredentials);
      }
      console.log('Done');
    } catch (error) {
      if (error instanceof LoginCancelledError) {
        console.error('Login cancelled.');
        process.exit(1);
      }
      if (error instanceof LoginFailedError) {
        console.error(error.message);
        process.exit(1);
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
    const latchkeyStore = getLatchkeyStorePath();

    const url = extractUrlFromCurlArguments(curlArguments);
    if (url === null) {
      console.error('Error: Could not extract URL from curl arguments.');
      process.exit(1);
    }

    const service = REGISTRY.getByUrl(url);
    if (service === null) {
      console.error(`Error: No service matches URL: ${url}`);
      process.exit(1);
    }

    let apiCredentials = null;
    const apiCredentialStore = latchkeyStore ? new ApiCredentialStore(latchkeyStore) : null;

    if (apiCredentialStore !== null) {
      apiCredentials = apiCredentialStore.get(service.name);
    }

    if (apiCredentials === null) {
      const browserStatePath = getBrowserStatePath();
      try {
        apiCredentials = await service.getSession().login(browserStatePath);
        if (apiCredentialStore !== null) {
          apiCredentialStore.save(service.name, apiCredentials);
        }
      } catch (error) {
        if (error instanceof LoginCancelledError) {
          console.error('Login cancelled.');
          process.exit(1);
        }
        if (error instanceof LoginFailedError) {
          console.error(error.message);
          process.exit(1);
        }
        throw error;
      }
    }

    const allArguments = [...apiCredentials.asCurlArguments(), ...curlArguments];
    const result = runCurl(allArguments);
    process.exit(result.returncode);
  });

program.parse();
