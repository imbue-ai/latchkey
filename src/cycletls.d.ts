/**
 * Minimal type declarations for the cycletls package (optional dependency).
 */
declare module 'cycletls' {
  interface CycleTLSRequestOptions {
    ja3?: string;
    userAgent?: string;
    headers?: Record<string, string>;
    body?: string;
    disableRedirect?: boolean;
  }

  interface CycleTLSResponse {
    status: number;
    body: unknown;
    data?: unknown;
    headers?: Record<string, string | string[]>;
  }

  type CycleTLSClient = ((
    url: string,
    options: CycleTLSRequestOptions,
    method?: string
  ) => Promise<CycleTLSResponse>) & {
    exit(): Promise<void>;
  };

  export default function initCycleTLS(): Promise<CycleTLSClient>;
}
