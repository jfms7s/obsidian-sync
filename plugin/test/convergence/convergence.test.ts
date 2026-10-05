import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { startServer, type TestServer } from '../helpers/server';
import { runSeed, seedsFromEnv } from './harness';

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer(inject('obsyncBin'));
});
afterAll(() => srv?.stop());

const steps = Number(process.env['OBSYNC_CONVERGENCE_STEPS'] ?? '60');

it.each(seedsFromEnv(process.env))('seed %i converges with no lost edit', async (seed) => {
  const report = await runSeed(srv, { seed, clients: 3, steps });
  expect(report.tokens).toBeGreaterThan(0);
});
