// Builds the real obsync server once per test run. Tests that need a server
// read the binary's path with inject('obsyncBin').
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    obsyncBin: string;
  }
}

export default function setup(project: TestProject): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'obsync-bin-'));
  const bin = join(dir, 'obsync');
  const serverDir = fileURLToPath(new URL('../../../server', import.meta.url));
  execFileSync('go', ['build', '-o', bin, './cmd/obsync'], {
    cwd: serverDir,
    env: { ...process.env, CGO_ENABLED: '1', GOTOOLCHAIN: 'auto' },
    stdio: 'inherit',
  });
  project.provide('obsyncBin', bin);
  return () => rmSync(dir, { recursive: true, force: true });
}
