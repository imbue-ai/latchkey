/**
 * Collects and manages HTTP request metadata.
 */

import { writeFileSync } from 'node:fs';
import type { Request, Response } from 'playwright';
import type { RecordingPhase, RequestMetadata } from './types.js';

export class RequestMetadataCollector {
  private readonly requests: RequestMetadata[] = [];
  private readonly outputPath: string;
  private currentPhase: RecordingPhase = 'pre-login';

  constructor(outputPath: string) {
    this.outputPath = outputPath;
  }

  setPhase(phase: RecordingPhase): void {
    this.currentPhase = phase;
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
      phase: this.currentPhase,
    };

    this.requests.push(metadata);
    this.flush();
  }

  flush(): void {
    writeFileSync(this.outputPath, JSON.stringify(this.requests, null, 2), 'utf-8');
  }
}
