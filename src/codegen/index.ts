/**
 * Codegen module that records browser actions and generates TypeScript code:
 * - Records user interactions (clicks, fills, navigations, etc.)
 * - Always generates TypeScript code
 * - Records all HTTP request metadata to a file
 * - Includes a custom toolbar with additional buttons
 *
 * The session has three phases:
 * - Pre-login: User interactions are recorded
 * - Logging-in: User is authenticating (no recording, requests marked as logging-in)
 * - Post-login: User has logged in (no recording, requests marked as post-login)
 */

import type { BrowserContext, Page, Request, Response } from 'playwright';
import { chromium } from 'playwright';

import { CodeGenerator } from './codeGenerator.js';
import { createRecorderScript } from './recorderScript.js';
import { RequestMetadataCollector } from './requestMetadataCollector.js';
import { createToolbarScript } from './toolbarScript.js';
import type { CodegenOptions, CodegenResult, RecordedAction, RecordingPhase, SelectorVariant } from './types.js';

// Re-export types for external use
export type { CodegenOptions, CodegenResult, RecordedAction, RecordingPhase, RequestMetadata, SelectorVariant } from './types.js';
export { CodegenError } from './types.js';

/**
 * Run the codegen which opens a browser with recording enabled.
 * Injects a custom toolbar and records user actions and HTTP request metadata.
 *
 * @returns Result containing the API key selector if selected by the user
 */
export async function runCodegen(options: CodegenOptions): Promise<CodegenResult> {
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

  // Session state
  let currentPhase: RecordingPhase = 'pre-login';
  let apiKeySelector: string | undefined;

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
  // Only records actions during pre-login phase
  await context.exposeFunction(
    '__latchkeyRecordAction',
    (action: {
      type: string;
      selector?: string;
      selectorVariants?: SelectorVariant[];
      value?: string;
      key?: string;
      url?: string;
    }) => {
      // Only record actions during pre-login phase
      if (currentPhase !== 'pre-login') {
        return;
      }

      codeGenerator.addAction({
        type: action.type as RecordedAction['type'],
        selector: action.selector,
        selectorVariants: action.selectorVariants,
        value: action.value,
        key: action.key,
        url: action.url,
        timestamp: Date.now(),
      });
    }
  );

  // Expose function to get current phase (called by toolbar)
  await context.exposeFunction('__latchkeyGetPhase', () => {
    return currentPhase;
  });

  // Expose function called when "Logging In" button is clicked
  await context.exposeFunction('__latchkeyTransitionToLoggingIn', () => {
    console.log('[Latchkey] Transitioning to logging-in phase');
    currentPhase = 'logging-in';
    requestCollector.setPhase('logging-in');
  });

  // Expose function called when "Logged In" button is clicked
  await context.exposeFunction('__latchkeyTransitionToPostLogin', () => {
    console.log('[Latchkey] Transitioning to post-login phase');
    currentPhase = 'post-login';
    requestCollector.setPhase('post-login');
  });

  // Expose function called when API key element is selected
  await context.exposeFunction('__latchkeyApiKeyElementSelected', (selector: string) => {
    console.log(`[Latchkey] API key element selected: ${selector}`);
    apiKeySelector = selector;
  });

  const page: Page = await context.newPage();

  // Helper function to inject toolbar after page load
  async function injectToolbarIfNeeded(targetPage: Page): Promise<void> {
    try {
      await targetPage.evaluate(toolbarScript);
    } catch {
      // Ignore errors (e.g., if page is closed or navigating)
    }
  }

  // Record initial navigation if URL provided
  if (options.url) {
    codeGenerator.addAction({
      type: 'navigate',
      url: options.url,
      timestamp: Date.now(),
    });
    await page.goto(options.url);
    // Inject toolbar after page loads
    await injectToolbarIfNeeded(page);
  }

  // Re-inject toolbar after navigations
  page.on('load', () => {
    void injectToolbarIfNeeded(page);
  });

  // Track navigations (only during pre-login phase)
  page.on('framenavigated', (frame) => {
    // Only track main frame navigations during pre-login
    if (frame === page.mainFrame() && currentPhase === 'pre-login') {
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
    const cleanup = () => {
      resolve();
    };

    browser.on('disconnected', cleanup);
    context.on('close', cleanup);
    page.on('close', cleanup);
  });

  // Final flush of collected data
  requestCollector.flush();
  codeGenerator.flush();

  console.log(`Generated code saved to: ${outputFile}`);
  console.log(`Request metadata saved to: ${requestsFile}`);
  if (apiKeySelector) {
    console.log(`API key element selector: ${apiKeySelector}`);
  }

  return { apiKeySelector };
}
