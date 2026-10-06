import { writeFileSync } from 'node:fs';
import { afterAll, expect, inject, it } from 'vitest';
import { startServer } from '../helpers/server';
import { runSeed, seedsFromEnv, type SeedReport } from './harness';

const obsyncBin = inject('obsyncBin');

const steps = Number(process.env['OBSYNC_CONVERGENCE_STEPS'] ?? '60');
const reports: SeedReport[] = [];

// OBSYNC_CONVERGENCE_REPORT=file.json writes what every seed did (without the
// logs, which a failing seed prints itself), for CI to keep.
afterAll(() => {
  const path = process.env['OBSYNC_CONVERGENCE_REPORT'];
  if (path) writeFileSync(path, JSON.stringify(reports.map(({ log: _log, ...r }) => r), null, 2));
  const total: Record<string, number> = {};
  for (const r of reports) for (const [op, k] of Object.entries(r.ops)) total[op] = (total[op] ?? 0) + k;
  console.log(`convergence: ${reports.length} seeds ok; operations run: ${JSON.stringify(total)}`);
});

// A server of its own for every seed: a backup of its data directory then
// holds one seed's data, and a seed that breaks its server cannot take the
// next ones with it.
it.each(seedsFromEnv(process.env))('seed %i converges with no lost edit', async (seed) => {
  const srv = await startServer(obsyncBin);
  try {
    const report = await runSeed(srv, { seed, clients: 3, steps });
    reports.push(report);
    expect(report.tokens).toBeGreaterThan(0);
  } finally {
    await srv.stop();
  }
});
