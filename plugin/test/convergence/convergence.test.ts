import { writeFileSync } from 'node:fs';
import { afterAll, expect, inject, it } from 'vitest';
import { startServer } from '../helpers/server';
import { coverageShortfalls, runSeed, seedsFromEnv, type SeedReport } from './harness';

const obsyncBin = inject('obsyncBin');

const steps = Number(process.env['OBSYNC_CONVERGENCE_STEPS'] ?? '60');
const seeds = seedsFromEnv(process.env);
const reports: SeedReport[] = [];
const failed: number[] = [];

const sum = (key: 'ops' | 'effects') => {
  const total: Record<string, number> = {};
  for (const r of reports) for (const [op, k] of Object.entries(r[key])) total[op] = (total[op] ?? 0) + k;
  return Object.fromEntries(Object.entries(total).sort(([a], [b]) => (a < b ? -1 : 1)));
};

// The summary goes to stdout directly, which the default reporter shows, and
// OBSYNC_CONVERGENCE_REPORT=file.json writes it with what every seed did
// (without the logs, which a failing seed prints itself), for CI to keep.
// Then a run of 20 seeds or more fails if some kind of operation had far
// fewer effects than usual (MIN_EFFECTS_PER_100_SEEDS): a suite that stopped
// exercising something would otherwise stay green.
afterAll(() => {
  const summary = { seeds: seeds.length, passed: reports.length, failed, ops: sum('ops'), effects: sum('effects') };
  const path = process.env['OBSYNC_CONVERGENCE_REPORT'];
  if (path) writeFileSync(path, JSON.stringify({ summary, seeds: reports.map(({ log: _log, ...r }) => r) }, null, 2));
  process.stdout.write(
    `convergence: ${summary.seeds} seeds run, ${summary.passed} passed, ${failed.length} failed${failed.length > 0 ? ` (${failed.join(', ')})` : ''}\n` +
      `convergence: operations run: ${JSON.stringify(summary.ops)}\n` +
      `convergence: effects: ${JSON.stringify(summary.effects)}\n`,
  );
  if (failed.length === 0 && seeds.length >= 20) {
    const short = coverageShortfalls(summary.effects, reports.length);
    if (short.length > 0) throw new Error(`convergence: operations barely exercised in ${reports.length} seeds:\n${short.join('\n')}`);
  }
});

// A server of its own for every seed: a backup of its data directory then
// holds one seed's data, and a seed that breaks its server cannot take the
// next ones with it.
it.each(seeds)('seed %i converges with no lost edit', async (seed) => {
  const srv = await startServer(obsyncBin);
  try {
    const report = await runSeed(srv, { seed, clients: 3, steps });
    reports.push(report);
    expect(report.tokens).toBeGreaterThan(0);
  } catch (err) {
    failed.push(seed);
    throw err;
  } finally {
    await srv.stop();
  }
});
