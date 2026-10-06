import { afterEach, expect, it } from 'vitest';
import { ApiClient, setDefaultTransport, type FetchLike } from '../../src/api/client';
import { NetworkError } from '../../src/api/errors';
import { fetchTransport } from '../helpers/setup-transport';

afterEach(() => setDefaultTransport(fetchTransport));

it('uses the transport the host registered when none is passed', async () => {
  const seen: string[] = [];
  const registered: FetchLike = async (url) => {
    seen.push(url);
    throw new TypeError('offline');
  };
  setDefaultTransport(registered);
  await expect(new ApiClient({ baseUrl: 'https://s', token: 't' }).listDevices()).rejects.toBeInstanceOf(NetworkError);
  expect(seen).toEqual(['https://s/v1/devices']);
});

it('fails clearly, as being offline, when no transport was configured', async () => {
  setDefaultTransport(null);
  await expect(new ApiClient({ baseUrl: 'https://s', token: 't' }).listDevices()).rejects.toThrow(/no HTTP transport/);
});
