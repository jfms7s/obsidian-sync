// src/ must run in Obsidian on mobile: no Node built-ins or globals.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

it('src/ imports no Node modules and uses no Node globals', () => {
  const src = fileURLToPath(new URL('../../src', import.meta.url));
  const offenders: string[] = [];
  const builtins = /from\s+['"](node:|fs|path|os|crypto|buffer|child_process|net|http|https|stream|url|util|events|worker_threads)['"/]/;
  const globals = /\b(Buffer|process|require|__dirname|__filename|setImmediate)\b\s*[.(]/;
  for (const f of files(src)) {
    const text = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    if (builtins.test(text) || globals.test(text)) offenders.push(f);
  }
  expect(offenders).toEqual([]);
});
