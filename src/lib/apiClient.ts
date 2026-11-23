/**
 * In-memory Firebase ID token holder (never stored in localStorage)
 * and authenticated fetch wrapper for ClipGenius API calls.
 */

let currentTokenGetter: (() => Promise<string | null>) | null = null;
let cachedInMemoryToken: string | null = null;

export function setAuthTokenProvider(
  getter: (() => Promise<string | null>) | null,
  initialToken: string | null = null
): void {
  currentTokenGetter = getter;
  cachedInMemoryToken = initialToken;
}

export function clearAuthTokenProvider(): void {
  currentTokenGetter = null;
  cachedInMemoryToken = null;
}

export async function getActiveAuthToken(): Promise<string | null> {
  if (currentTokenGetter) {
    try {
      const fresh = await currentTokenGetter();
      cachedInMemoryToken = fresh;
      return fresh;
    } catch {
      return cachedInMemoryToken;
    }
  }
  return cachedInMemoryToken;
}

export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const token = await getActiveAuthToken();
  const headers = new Headers(init.headers ?? {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(input, {
    ...init,
    headers,
  });
}
