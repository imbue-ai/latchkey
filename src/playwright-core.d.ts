/**
 * Type declarations for internal playwright-core modules.
 */
declare module 'playwright-core/lib/coreBundle' {
  export interface Executable {
    name: string;
    directory: string | undefined;
    downloadURLs?: string[];
    executablePath(sdkLanguage: string): string | undefined;
  }

  export interface Registry {
    findExecutable(name: string): Executable | undefined;
  }

  export interface CoreBundle {
    registry: {
      registry: Registry;
    };
    utils: {
      extractZip: (zipPath: string, options: { dir: string }) => Promise<void>;
    };
  }

  const coreBundle: CoreBundle;
  export default coreBundle;
}
