/**
 * Centralized persistence for config.json.
 *
 * All reads and writes to the config file go through this module,
 * ensuring consistent handling of the file format, directory creation,
 * and data merging.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from './atomicWrite.js';

const RegisteredServiceEntrySchema = z.object({
  baseApiUrl: z.string(),
  serviceFamily: z.string().optional(),
  loginUrl: z.string().optional(),
});

export type RegisteredServiceEntry = z.infer<typeof RegisteredServiceEntrySchema>;

const RegisteredServicesSchema = z.record(z.string(), RegisteredServiceEntrySchema);

const BrowserConfigSchema = z.object({
  executablePath: z.string(),
  source: z.enum(['system', 'playwright', 'downloaded']),
  discoveredAt: z.string().datetime(),
});

export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

const ConfigFileSchema = z.object({
  browser: BrowserConfigSchema.optional(),
  registeredServices: RegisteredServicesSchema.optional(),
});

/**
 * Read the raw config object from disk.
 * Returns an empty object if the file doesn't exist or is unparseable.
 */
function readConfigFile(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const content = readFileSync(configPath, 'utf-8');
    const data = JSON.parse(content) as unknown;
    if (typeof data !== 'object' || data === null) {
      return {};
    }
    return data as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Write a config object to disk, creating the directory if needed.
 */
function writeConfigFile(configPath: string, config: Record<string, unknown>): void {
  const directory = dirname(configPath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const content = JSON.stringify(config, null, 2);
  writeFileAtomic(configPath, content, { encoding: 'utf-8', mode: 0o600 });
}

export function loadRegisteredServices(
  configPath: string
): ReadonlyMap<string, RegisteredServiceEntry> {
  const raw = readConfigFile(configPath);
  try {
    const registeredServices = RegisteredServicesSchema.parse(raw.registeredServices ?? {});
    return new Map(Object.entries(registeredServices));
  } catch {
    return new Map();
  }
}

export function saveRegisteredService(
  configPath: string,
  name: string,
  entry: RegisteredServiceEntry
): void {
  const existingConfig = readConfigFile(configPath);

  const registeredServices =
    typeof existingConfig.registeredServices === 'object' &&
    existingConfig.registeredServices !== null
      ? (existingConfig.registeredServices as Record<string, unknown>)
      : {};

  registeredServices[name] = entry;
  existingConfig.registeredServices = registeredServices;

  writeConfigFile(configPath, existingConfig);
}

export function deleteRegisteredService(configPath: string, name: string): void {
  const existingConfig = readConfigFile(configPath);

  const registeredServices =
    typeof existingConfig.registeredServices === 'object' &&
    existingConfig.registeredServices !== null
      ? (existingConfig.registeredServices as Record<string, unknown>)
      : {};

  const { [name]: _, ...rest } = registeredServices;
  existingConfig.registeredServices = rest;

  writeConfigFile(configPath, existingConfig);
}

export function loadBrowserConfig(configPath: string): BrowserConfig | null {
  const raw = readConfigFile(configPath);
  try {
    const configFile = ConfigFileSchema.parse(raw);
    if (!configFile.browser) {
      return null;
    }
    if (!existsSync(configFile.browser.executablePath)) {
      return null;
    }
    return configFile.browser;
  } catch {
    return null;
  }
}

export function saveBrowserConfig(configPath: string, config: BrowserConfig): void {
  const existingConfig = readConfigFile(configPath);
  existingConfig.browser = config;
  writeConfigFile(configPath, existingConfig);
}
