/**
 * Codegen service that mirrors Playwright's codegen functionality with modifications:
 * - Always generates TypeScript code
 * - Records all HTTP request metadata to a file
 * - Outputs generated code to a file
 */

import { writeFileSync } from 'node:fs';
import type { Browser, BrowserContext, Page, Request, Response } from 'playwright';
import { chromium } from 'playwright';

/**
 * Represents HTTP request metadata captured during recording.
 */
export interface RequestMetadata {
  readonly url: string;
  readonly method: string;
  readonly queryParams: Record<string, string>;
  readonly requestHeaders: Record<string, string>;
  readonly responseHeaders: Record<string, string>;
  readonly statusCode: number;
  readonly timestamp: string;
}

/**
 * Options for the codegen service.
 */
export interface CodegenServiceOptions {
  /** Path to the browser executable. */
  readonly executablePath?: string;
  /** Initial URL to navigate to. */
  readonly url?: string;
  /** Path to output the generated TypeScript code. Defaults to 'tmp.js'. */
  readonly outputFile?: string;
  /** Path to output the request metadata JSON. Defaults to 'requests.json'. */
  readonly requestsFile?: string;
}

/**
 * Collects and manages HTTP request metadata.
 */
class RequestMetadataCollector {
  private readonly requests: RequestMetadata[] = [];
  private readonly outputPath: string;

  constructor(outputPath: string) {
    this.outputPath = outputPath;
  }

  addRequest(request: Request, response: Response | null): void {
    const url = new URL(request.url());

    const queryParams: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      queryParams[key] = value;
    });

    const requestHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers())) {
      requestHeaders[key] = value;
    }

    const responseHeaders: Record<string, string> = {};
    if (response) {
      for (const [key, value] of Object.entries(response.headers())) {
        responseHeaders[key] = value;
      }
    }

    const metadata: RequestMetadata = {
      url: request.url(),
      method: request.method(),
      queryParams,
      requestHeaders,
      responseHeaders,
      statusCode: response?.status() ?? 0,
      timestamp: new Date().toISOString(),
    };

    this.requests.push(metadata);
    this.flush();
  }

  flush(): void {
    writeFileSync(this.outputPath, JSON.stringify(this.requests, null, 2), 'utf-8');
  }

  getRequests(): readonly RequestMetadata[] {
    return this.requests;
  }
}

/**
 * Generates TypeScript/JavaScript code from recorded actions.
 * This is a simplified code generator that produces library-style code.
 */
class TypeScriptCodeGenerator {
  private readonly outputPath: string;
  private readonly actions: string[] = [];
  private pageCounter = 0;

  constructor(outputPath: string) {
    this.outputPath = outputPath;
  }

  private generateHeader(): string {
    return `const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();`;
  }

  private generateFooter(): string {
    return `
  // ---------------------
  await context.close();
  await browser.close();
})();`;
  }

  addPageOpen(url: string): void {
    const pageAlias = this.pageCounter === 0 ? 'page' : `page${String(this.pageCounter)}`;
    this.pageCounter++;
    this.actions.push(`  const ${pageAlias} = await context.newPage();`);
    if (url && url !== 'about:blank' && url !== 'chrome://newtab/') {
      this.actions.push(`  await ${pageAlias}.goto(${this.quote(url)});`);
    }
  }

  addNavigation(url: string): void {
    const pageAlias = this.pageCounter === 0 ? 'page' : `page${String(this.pageCounter - 1)}`;
    this.actions.push(`  await ${pageAlias}.goto(${this.quote(url)});`);
  }

  addClick(selector: string): void {
    const pageAlias = this.pageCounter === 0 ? 'page' : `page${String(this.pageCounter - 1)}`;
    this.actions.push(`  await ${pageAlias}.locator(${this.quote(selector)}).click();`);
  }

  addFill(selector: string, text: string): void {
    const pageAlias = this.pageCounter === 0 ? 'page' : `page${String(this.pageCounter - 1)}`;
    this.actions.push(`  await ${pageAlias}.locator(${this.quote(selector)}).fill(${this.quote(text)});`);
  }

  addPress(selector: string, key: string): void {
    const pageAlias = this.pageCounter === 0 ? 'page' : `page${String(this.pageCounter - 1)}`;
    this.actions.push(`  await ${pageAlias}.locator(${this.quote(selector)}).press(${this.quote(key)});`);
  }

  addPageClose(): void {
    const pageAlias = this.pageCounter === 0 ? 'page' : `page${String(this.pageCounter - 1)}`;
    this.actions.push(`  await ${pageAlias}.close();`);
  }

  private quote(text: string): string {
    return "'" + text.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  }

  flush(): void {
    const code = [this.generateHeader(), ...this.actions, this.generateFooter()].join('\n');
    writeFileSync(this.outputPath, code, 'utf-8');
  }

  getCode(): string {
    return [this.generateHeader(), ...this.actions, this.generateFooter()].join('\n');
  }
}

export class CodegenServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodegenServiceError';
  }
}

/**
 * Run the codegen service which opens a browser with recording enabled.
 * The recorder UI is injected via Playwright's built-in recorder mechanism.
 */
export async function runCodegenService(options: CodegenServiceOptions): Promise<void> {
  const outputFile = options.outputFile ?? 'tmp.js';
  const requestsFile = options.requestsFile ?? 'requests.json';

  const launchOptions: Parameters<typeof chromium.launch>[0] = {
    headless: false,
  };

  if (options.executablePath) {
    launchOptions.executablePath = options.executablePath;
  }

  const browser: Browser = await chromium.launch(launchOptions);

  const context: BrowserContext = await browser.newContext();

  const requestCollector = new RequestMetadataCollector(requestsFile);
  const codeGenerator = new TypeScriptCodeGenerator(outputFile);

  // Track requests and responses
  const pendingRequests = new Map<Request, null>();

  context.on('request', (request: Request) => {
    pendingRequests.set(request, null);
  });

  context.on('response', (response: Response) => {
    const request = response.request();
    pendingRequests.delete(request);
    requestCollector.addRequest(request, response);
  });

  context.on('requestfailed', (request: Request) => {
    pendingRequests.delete(request);
    requestCollector.addRequest(request, null);
  });

  // Enable the built-in Playwright recorder
  // This uses the internal _enableRecorder API that powers npx playwright codegen
  // The BrowserContext from playwright has an internal _enableRecorder method
  // that is used by `npx playwright codegen` to enable the recorder UI
  type BrowserContextWithRecorder = BrowserContext & {
    _enableRecorder?: (options: {
      language: string;
      mode: string;
      outputFile: string;
      handleSIGINT: boolean;
    }) => Promise<void>;
  };
  const contextWithRecorder = context as BrowserContextWithRecorder;
  if (typeof contextWithRecorder._enableRecorder === 'function') {
    await contextWithRecorder._enableRecorder({
      language: 'javascript',
      mode: 'recording',
      outputFile: outputFile,
      handleSIGINT: false,
    });
  }

  const page: Page = await context.newPage();

  // Generate initial page open
  const initialUrl = options.url ?? 'about:blank';
  codeGenerator.addPageOpen(initialUrl);

  if (options.url) {
    await page.goto(options.url);
  }

  codeGenerator.flush();

  // Wait for browser to close
  await new Promise<void>((resolve) => {
    browser.on('disconnected', () => {
      resolve();
    });

    context.on('close', () => {
      resolve();
    });
  });

  // Final flush of collected data
  requestCollector.flush();
  codeGenerator.flush();

  console.log(`Generated code saved to: ${outputFile}`);
  console.log(`Request metadata saved to: ${requestsFile}`);
}
