// The obsync-cli executable: the network, signals and exit code around run().
import { setDefaultTransport, type FetchLike } from '../src/index';
import { streamLogger } from './log';
import { run } from './main';

const fetchTransport: FetchLike = (url, req) => {
  const init: RequestInit = { method: req.method, headers: req.headers, cache: 'no-store' };
  if (req.body) init.body = req.body;
  return fetch(url, init);
};

async function main(): Promise<number> {
  if (typeof fetch !== 'function' || typeof WebSocket !== 'function') {
    process.stderr.write(`obsync-cli needs Node 22.12 or newer (this is ${process.version})\n`);
    return 1;
  }
  setDefaultTransport(fetchTransport);
  const argv = process.argv.slice(2);
  const daemon = argv[0] === 'sync' && !argv.includes('--once');
  let stopRequested = false;
  const stop = new Promise<void>((resolve) => {
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      process.on(sig, () => {
        // The daemon finishes its cycle and saves its state; anything else, or a second signal, stops at once.
        if (!daemon || stopRequested) process.exit(130);
        stopRequested = true;
        resolve();
      });
    }
  });
  return run(argv, { env: process.env, out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t), log: (verbose) => streamLogger((l) => process.stderr.write(l), verbose), stop });
}

main().then(
  (code) => {
    // Not process.exit(): output still buffered for a pipe would be lost. Whatever might
    // keep the process alive after that (a socket kept open for reuse) gets a second.
    process.exitCode = code;
    setTimeout(() => process.exit(code), 1000).unref();
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
