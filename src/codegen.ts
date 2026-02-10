/**
 * Codegen module that records browser actions and generates TypeScript code:
 * - Records user interactions (clicks, fills, navigations, etc.)
 * - Always generates TypeScript code
 * - Records all HTTP request metadata to a file
 * - Includes a custom toolbar with additional buttons
 */

import { writeFileSync } from 'node:fs';
import type { BrowserContext, Page, Request, Response } from 'playwright';
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
 * Options for the codegen runner.
 */
export interface CodegenOptions {
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
 * Represents a recorded action.
 */
interface RecordedAction {
  readonly type:
    | 'navigate'
    | 'click'
    | 'fill'
    | 'press'
    | 'select'
    | 'check'
    | 'uncheck';
  readonly selector?: string;
  readonly url?: string;
  readonly value?: string;
  readonly key?: string;
  readonly timestamp: number;
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
}

/**
 * Generates TypeScript code from recorded actions.
 */
class CodeGenerator {
  private readonly actions: RecordedAction[] = [];
  private readonly outputPath: string;

  constructor(outputPath: string) {
    this.outputPath = outputPath;
  }

  addAction(action: RecordedAction): void {
    this.actions.push(action);
    this.flush();
  }

  private escapeString(str: string): string {
    return str
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
  }

  private generateActionCode(action: RecordedAction): string {
    switch (action.type) {
      case 'navigate':
        return `  await page.goto('${this.escapeString(action.url ?? '')}');`;
      case 'click':
        return `  await page.locator('${this.escapeString(action.selector ?? '')}').click();`;
      case 'fill':
        return `  await page.locator('${this.escapeString(action.selector ?? '')}').fill('${this.escapeString(action.value ?? '')}');`;
      case 'press':
        return `  await page.locator('${this.escapeString(action.selector ?? '')}').press('${this.escapeString(action.key ?? '')}');`;
      case 'select':
        return `  await page.locator('${this.escapeString(action.selector ?? '')}').selectOption('${this.escapeString(action.value ?? '')}');`;
      case 'check':
        return `  await page.locator('${this.escapeString(action.selector ?? '')}').check();`;
      case 'uncheck':
        return `  await page.locator('${this.escapeString(action.selector ?? '')}').uncheck();`;
      default: {
        const unknownType: never = action.type;
        return `  // Unknown action: ${String(unknownType)}`;
      }
    }
  }

  generateCode(): string {
    const header = `const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

`;

    const footer = `
  // ---------------------
  await context.close();
  await browser.close();
})();
`;

    const actionLines = this.actions.map((action) => this.generateActionCode(action));
    return header + actionLines.join('\n') + footer;
  }

  flush(): void {
    writeFileSync(this.outputPath, this.generateCode(), 'utf-8');
  }
}

export class CodegenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodegenError';
  }
}

/**
 * Creates the recorder script that captures user interactions.
 * This script is injected into every page and listens for clicks, inputs, etc.
 */
function createRecorderScript(): string {
  return `
(function() {
  // Don't inject twice
  if (window.__latchkeyRecorderInstalled) return;
  window.__latchkeyRecorderInstalled = true;

  // Helper to generate a simple selector for an element
  function generateSelector(element) {
    // Try data-testid first
    if (element.dataset && element.dataset.testid) {
      return '[data-testid="' + element.dataset.testid + '"]';
    }

    // Try id
    if (element.id) {
      return '#' + CSS.escape(element.id);
    }

    // Try unique class combination
    if (element.className && typeof element.className === 'string') {
      const classes = element.className.trim().split(/\\s+/).filter(c => c.length > 0);
      if (classes.length > 0) {
        const selector = '.' + classes.map(c => CSS.escape(c)).join('.');
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }
      }
    }

    // Try tag + nth-child
    const parent = element.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children);
      const index = siblings.indexOf(element);
      const tagName = element.tagName.toLowerCase();
      const parentSelector = parent === document.body ? 'body' : generateSelector(parent);
      return parentSelector + ' > ' + tagName + ':nth-child(' + (index + 1) + ')';
    }

    // Fallback to tag name
    return element.tagName.toLowerCase();
  }

  // Check if element is part of our toolbar
  function isToolbarElement(element) {
    return element.closest && element.closest('#latchkey-recorder-toolbar');
  }

  // Track clicks
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || isToolbarElement(target)) return;

    const selector = generateSelector(target);

    // Check if it's a checkbox or radio
    if (target.tagName === 'INPUT') {
      const inputType = target.type.toLowerCase();
      if (inputType === 'checkbox') {
        if (target.checked) {
          window.__latchkeyRecordAction && window.__latchkeyRecordAction({
            type: 'check',
            selector: selector
          });
        } else {
          window.__latchkeyRecordAction && window.__latchkeyRecordAction({
            type: 'uncheck',
            selector: selector
          });
        }
        return;
      }
    }

    window.__latchkeyRecordAction && window.__latchkeyRecordAction({
      type: 'click',
      selector: selector
    });
  }, true);

  // Track input/change for fill actions
  let lastInputElement = null;
  let lastInputValue = '';
  let inputTimeout = null;

  document.addEventListener('input', (event) => {
    const target = event.target;
    if (!target || isToolbarElement(target)) return;

    const tagName = target.tagName;
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || target.isContentEditable) {
      const inputType = target.type ? target.type.toLowerCase() : 'text';

      // Skip checkboxes and radios (handled by click)
      if (inputType === 'checkbox' || inputType === 'radio') return;

      lastInputElement = target;
      lastInputValue = target.value || target.innerText || '';

      // Debounce the recording to capture the final value
      if (inputTimeout) clearTimeout(inputTimeout);
      inputTimeout = setTimeout(() => {
        if (lastInputElement) {
          const selector = generateSelector(lastInputElement);
          window.__latchkeyRecordAction && window.__latchkeyRecordAction({
            type: 'fill',
            selector: selector,
            value: lastInputValue
          });
          lastInputElement = null;
          lastInputValue = '';
        }
      }, 500);
    }
  }, true);

  // Track select changes
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!target || isToolbarElement(target)) return;

    if (target.tagName === 'SELECT') {
      const selector = generateSelector(target);
      const selectedValue = target.value;
      window.__latchkeyRecordAction && window.__latchkeyRecordAction({
        type: 'select',
        selector: selector,
        value: selectedValue
      });
    }
  }, true);

  // Track key presses (for special keys like Enter, Tab, etc.)
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (!target || isToolbarElement(target)) return;

    // Only record special keys
    const specialKeys = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (specialKeys.includes(event.key)) {
      const selector = generateSelector(target);
      window.__latchkeyRecordAction && window.__latchkeyRecordAction({
        type: 'press',
        selector: selector,
        key: event.key
      });
    }
  }, true);
})();
`;
}

/**
 * Creates the toolbar overlay script to be injected into pages.
 */
function createToolbarScript(): string {
  return `
(function() {
  // Don't inject twice
  if (document.getElementById('latchkey-recorder-toolbar')) return;

  // Create styles
  const style = document.createElement('style');
  style.textContent = \`
    #latchkey-recorder-toolbar {
      position: fixed;
      top: 0;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      background: #1a1a1a;
      border-radius: 0 0 8px 8px;
      padding: 8px 16px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
      user-select: none;
    }

    #latchkey-recorder-toolbar * {
      box-sizing: border-box;
    }

    .latchkey-toolbar-button {
      background: #333;
      border: 1px solid #555;
      border-radius: 4px;
      color: #fff;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: background 0.15s, border-color 0.15s;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .latchkey-toolbar-button:hover {
      background: #444;
      border-color: #666;
    }

    .latchkey-toolbar-button:active {
      background: #555;
    }

    .latchkey-toolbar-button.recording {
      background: #dc3545;
      border-color: #dc3545;
    }

    .latchkey-toolbar-button.recording:hover {
      background: #c82333;
      border-color: #bd2130;
    }

    .latchkey-toolbar-separator {
      width: 1px;
      height: 24px;
      background: #444;
      margin: 0 4px;
    }

    .latchkey-toolbar-status {
      color: #aaa;
      font-size: 11px;
      margin-left: 8px;
    }

    .latchkey-toolbar-status.recording {
      color: #ff6b6b;
    }

    .latchkey-recording-dot {
      width: 8px;
      height: 8px;
      background: #ff4444;
      border-radius: 50%;
      animation: latchkey-pulse 1.5s infinite;
    }

    @keyframes latchkey-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .latchkey-toolbar-gripper {
      color: #666;
      cursor: move;
      padding: 4px;
      display: flex;
      align-items: center;
    }

    .latchkey-toolbar-gripper svg {
      width: 16px;
      height: 16px;
    }
  \`;
  document.head.appendChild(style);

  // Create toolbar
  const toolbar = document.createElement('div');
  toolbar.id = 'latchkey-recorder-toolbar';

  // Gripper for dragging
  const gripper = document.createElement('div');
  gripper.className = 'latchkey-toolbar-gripper';
  gripper.innerHTML = \`
    <svg viewBox="0 0 16 16" fill="currentColor">
      <path d="M5 3h2v2H5zm0 4h2v2H5zm0 4h2v2H5zm4-8h2v2H9zm0 4h2v2H9zm0 4h2v2H9z"/>
    </svg>
  \`;
  toolbar.appendChild(gripper);

  // Recording indicator
  const recordingDot = document.createElement('div');
  recordingDot.className = 'latchkey-recording-dot';
  toolbar.appendChild(recordingDot);

  // Status text
  const status = document.createElement('span');
  status.className = 'latchkey-toolbar-status recording';
  status.textContent = 'Recording';
  toolbar.appendChild(status);

  // Separator
  const sep1 = document.createElement('div');
  sep1.className = 'latchkey-toolbar-separator';
  toolbar.appendChild(sep1);

  // Record button (toggle)
  const recordBtn = document.createElement('button');
  recordBtn.className = 'latchkey-toolbar-button recording';
  recordBtn.innerHTML = \`
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <circle cx="8" cy="8" r="6"/>
    </svg>
    Record
  \`;
  recordBtn.title = 'Toggle recording';
  recordBtn.onclick = () => {
    window.__latchkeyToggleRecording && window.__latchkeyToggleRecording();
  };
  toolbar.appendChild(recordBtn);

  // Inspect button
  const inspectBtn = document.createElement('button');
  inspectBtn.className = 'latchkey-toolbar-button';
  inspectBtn.innerHTML = \`
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path fill-rule="evenodd" clip-rule="evenodd" d="M1 3l1-1h12l1 1v6h-1V3H2v8h5v1H2l-1-1V3zm14.707 9.707L9 6v9.414l2.707-2.707h4zM10 13V8.414l3.293 3.293h-2L10 13z"/>
    </svg>
    Inspect
  \`;
  inspectBtn.title = 'Pick locator';
  inspectBtn.onclick = () => {
    window.__latchkeyInspect && window.__latchkeyInspect();
  };
  toolbar.appendChild(inspectBtn);

  // Separator
  const sep2 = document.createElement('div');
  sep2.className = 'latchkey-toolbar-separator';
  toolbar.appendChild(sep2);

  // Foo button (custom)
  const fooBtn = document.createElement('button');
  fooBtn.className = 'latchkey-toolbar-button';
  fooBtn.innerHTML = \`
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM7 4h2v5H7V4zm0 6h2v2H7v-2z"/>
    </svg>
    Foo
  \`;
  fooBtn.title = 'Foo button (placeholder)';
  fooBtn.onclick = () => {
    window.__latchkeyFoo && window.__latchkeyFoo();
  };
  toolbar.appendChild(fooBtn);

  document.body.appendChild(toolbar);

  // Make toolbar draggable
  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;

  gripper.addEventListener('mousedown', (e) => {
    isDragging = true;
    const rect = toolbar.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    toolbar.style.transition = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const x = e.clientX - offsetX;
    const y = e.clientY - offsetY;
    toolbar.style.left = x + 'px';
    toolbar.style.top = y + 'px';
    toolbar.style.transform = 'none';
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
  });
})();
`;
}

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
