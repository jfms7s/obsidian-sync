// Tests talk to a real server over the platform's fetch; Obsidian code uses requestUrl instead.
import { setDefaultTransport, type FetchLike } from '../../src/api/client';

export const fetchTransport: FetchLike = (url, req) => {
  const init: RequestInit = { method: req.method, headers: req.headers, cache: 'no-store' };
  if (req.body) init.body = req.body;
  return fetch(url, init);
};

setDefaultTransport(fetchTransport);
