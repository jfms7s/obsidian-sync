export class InsecureServerUrlError extends Error {
  constructor(url: string) {
    super(`the server URL must use https:// (http:// is allowed only for localhost): ${url}`);
    this.name = 'InsecureServerUrlError';
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Validates a server URL typed by the user and returns it without a trailing slash. */
export function normalizeServerUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new Error(`not a URL: ${input}`);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))) {
    throw new InsecureServerUrlError(input);
  }
  if (u.search || u.hash || u.username || u.password) throw new Error('the server URL must not have a query, fragment or credentials');
  return u.toString().replace(/\/+$/, '');
}

/** The hub's WebSocket URL for a normalized server URL. */
export function hubUrl(serverUrl: string): string {
  return serverUrl.replace(/^http/, 'ws') + '/v1/ws';
}
