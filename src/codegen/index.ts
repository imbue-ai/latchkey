/**
 * Codegen module that records browser actions and generates TypeScript code:
 * - Records user interactions (clicks, fills, navigations, etc.)
 * - Always generates TypeScript code
 * - Records all HTTP request metadata to a file
 * - Includes a custom toolbar with additional buttons
 */

import type { BrowserContext, Page, Request, Response } from 'playwright';
import { chromium } from 'playwright';

import { CodeGenerator } from './codeGenerator.js';
import { createRecorderScript } from './recorderScript.js';
import { RequestMetadataCollector } from './requestMetadataCollector.js';
import { createToolbarScript } from './toolbarScript.js';
import type { CodegenOptions, RecordedAction } from './types.js';

// Re-export types for external use
export type { CodegenOptions, RecordedAction, RequestMetadata } from './types.js';
export { CodegenError } from './types.js';

/**
 * Run the codegen which opens a browser with recording enabled.
 * Injects a custom toolbar and records user actions and HTTP request metadata.
 */
export async function runCodegen(options: CodegenOptions): Promise<void> {
  const outputFile = options.outputFile ?? 'tmp.js';
  const requestsFile = options.requestsFile ?? 'requests.json';

  const launchOptions: Parameters<typeof chromium.launch>[0] = {
    headless: false,
  };

  if (options.executablePath) {
    launchOptions.executablePath = options.executablePath;
  }

  const browser = await chromium.launch(launchOptions);
  const context: BrowserContext = await browser.newContext();

  const requestCollector = new RequestMetadataCollector(requestsFile);
  const codeGenerator = new CodeGenerator(outputFile);

  // Track HTTP requests and responses
  context.on('response', (response: Response) => {
    const request = response.request();
    requestCollector.addRequest(request, response);
  });

  context.on('requestfailed', (request: Request) => {
    requestCollector.addRequest(request, null);
  });

  // Inject our recorder script into every page
  const recorderScript = createRecorderScript();
  const toolbarScript = createToolbarScript();

  await context.addInitScript(recorderScript + toolbarScript);

  // Expose function to receive recorded actions from the page
  await context.exposeFunction(
    '__latchkeyRecordAction',
    (action: { type: string; selector?: string; value?: string; key?: string; url?: string }) => {
      codeGenerator.addAction({
        type: action.type as RecordedAction['type'],
        selector: action.selector,
        value: action.value,
        key: action.key,
        url: action.url,
        timestamp: Date.now(),
      });
    }
  );

  // Expose toolbar button callbacks
  await context.exposeFunction('__latchkeyToggleRecording', () => {
    console.log('[Latchkey] Toggle recording clicked');
  });

  await context.exposeFunction('__latchkeyInspect', () => {
    console.log('[Latchkey] Inspect clicked');
  });

  await context.exposeFunction('__latchkeyFoo', () => {
    console.log('[Latchkey] Foo clicked');
  });

  const page: Page = await context.newPage();

  // Record initial navigation if URL provided
  if (options.url) {
    codeGenerator.addAction({
      type: 'navigate',
      url: options.url,
      timestamp: Date.now(),
    });
    await page.goto(options.url);
  }

  // Track navigations
  page.on('framenavigated', (frame) => {
    // Only track main frame navigations
    if (frame === page.mainFrame()) {
      const url = frame.url();
      // Don't record about:blank or the initial navigation (already recorded above)
      if (url && url !== 'about:blank' && url !== options.url) {
        codeGenerator.addAction({
          type: 'navigate',
          url: url,
          timestamp: Date.now(),
        });
      }
    }
  });

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
