// The *With helpers and wrapPrivateKeys take a caller-supplied nonce (or
// ephemeral key) so the known-answer tests can reproduce the Go vectors.
// Reusing a nonce under one AES-GCM key is fatal, so production code must
// go through the wrappers that draw them from Random: only the defining
// module may call these.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const HELPERS: Record<string, string> = {
  sealKeyWith: 'crypto/vaultkeys.ts',
  encryptChunkWith: 'crypto/objects.ts',
  encryptMetaWith: 'crypto/objects.ts',
  encryptVaultNameWith: 'crypto/objects.ts',
  wrapPrivateKeys: 'crypto/userkeys.ts',
};

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

it('nonce-taking helpers are used only inside their defining module', () => {
  const offenders: string[] = [];
  for (const f of files(SRC)) {
    const rel = relative(SRC, f).split('\\').join('/');
    const text = stripComments(readFileSync(f, 'utf8'));
    for (const [name, home] of Object.entries(HELPERS)) {
      if (rel !== home && new RegExp(`\\b${name}\\b`).test(text)) offenders.push(`${rel} uses ${name}`);
    }
  }
  expect(offenders).toEqual([]);
});

it('each nonce-taking helper is marked @internal', () => {
  for (const [name, home] of Object.entries(HELPERS)) {
    const text = readFileSync(join(SRC, home), 'utf8');
    expect(text, name).toMatch(new RegExp(`/\\*\\* @internal test-only: caller supplies nonce \\*/\\s*export (async )?function ${name}\\b`));
  }
});
