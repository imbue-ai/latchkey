/**
 * Persistence for user-registered services in config.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { RegisteredService } from './registeredService.js';
import type { Registry } from './registry.js';

const RegisteredServiceEntrySchema = z.object({
  baseApiUrl: z.string(),
  serviceFamily: z.string(),
  loginUrl: z.string().optional(),
});

export type RegisteredServiceEntry = z.infer<typeof RegisteredServiceEntrySchema>;

const RegisteredServicesSchema = z.record(z.string(), RegisteredServiceEntrySchema);

export function loadRegisteredServices(
  configPath: string
): ReadonlyMap<string, RegisteredServiceEntry> {
  if (!existsSync(configPath)) {
    return new Map();
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const data = JSON.parse(content) as unknown;
    if (typeof data !== 'object' || data === null) {
      return new Map();
    }
    const record = data as Record<string, unknown>;
    const registeredServices = RegisteredServicesSchema.parse(record.registeredServices ?? {});
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
  const directory = dirname(configPath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  let existingConfig: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const existingContent = readFileSync(configPath, 'utf-8');
      existingConfig = JSON.parse(existingContent) as Record<string, unknown>;
    } catch {
      // Ignore parse errors, start fresh
    }
  }

  const registeredServices =
    typeof existingConfig.registeredServices === 'object' &&
    existingConfig.registeredServices !== null
      ? (existingConfig.registeredServices as Record<string, unknown>)
      : {};

  registeredServices[name] = entry;
  existingConfig.registeredServices = registeredServices;

  const content = JSON.stringify(existingConfig, null, 2);
  writeFileSync(configPath, content, { encoding: 'utf-8' });
}

export function loadRegisteredServicesIntoRegistry(configPath: string, registry: Registry): void {
  const entries = loadRegisteredServices(configPath);
  for (const [name, entry] of entries) {
    const familyService = registry.getByName(entry.serviceFamily);
    if (familyService === null) {
      continue;
    }
    if (registry.getByName(name) !== null) {
      continue;
    }
    const registeredService = new RegisteredService(
      name,
      entry.baseApiUrl,
      familyService,
      entry.loginUrl
    );
    registry.addService(registeredService);
  }
}
