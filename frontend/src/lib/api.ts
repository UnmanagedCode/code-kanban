// The one place the UI calls fetch. Every path is relative: the page's origin is
// code-conductor's when embedded, so a `/`-led path would reach cc's API.

/** A failed request: the HTTP status, and the backend's `{error, code}` body when it sent one. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface ApiInit {
  method?: string;
  /** Sent as JSON. */
  body?: unknown;
}

/**
 * A JSON request to this plugin's backend. A non-2xx response throws `ApiError`; a
 * 2xx one is returned parsed, so a domain refusal (`{ok:false}` at HTTP 200) is a
 * normal result for the caller to read.
 */
export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  if (path.startsWith('/')) throw new Error(`api('${path}'): root-relative, so it would reach cc, not this plugin`);
  const request: RequestInit = { method: init.method ?? 'GET' };
  if (init.body !== undefined) {
    request.headers = { 'content-type': 'application/json' };
    request.body = JSON.stringify(init.body);
  }
  const res = await globalThis.fetch(path, request);
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const b = (body ?? {}) as { error?: unknown; code?: unknown };
    throw new ApiError(
      res.status,
      typeof b.error === 'string' ? b.error : `HTTP ${res.status}`,
      typeof b.code === 'string' ? b.code : undefined,
    );
  }
  if (body === undefined) throw new ApiError(res.status, `non-JSON ${res.status}`);
  return body as T;
}
