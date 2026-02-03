/**
 * Type declarations for internal playwright-core modules.
 */
declare module 'playwright-core/lib/server/registry/index' {
  export interface Executable {
    name: string;
    directory: string | undefined;
    downloadURLs?: string[];
    executablePath(sdkLanguage: string): string | undefined;
  }

  export interface Registry {
    findExecutable(name: string): Executable | undefined;
  }

  export const registry: Registry;

  export function installBrowsersForNpmInstall(browsers: string[]): Promise<void>;
}

declare module 'playwright-core/lib/zipBundle' {
  export function extract(zipPath: string, options: { dir: string }): Promise<void>;
}
