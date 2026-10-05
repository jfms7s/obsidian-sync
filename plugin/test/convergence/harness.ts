// The convergence suite (spec §8): N simulated devices run the real engine
// against the real server, doing random operations from a seed, then must
// end with byte-identical vaults and no lost edit.
//
// "No edit lost" is checked with tokens. Every operation that writes
// content writes a fresh, unique token (a line in text files, a marker in
// binary files). A token may legitimately disappear only through an
// operation that removed it on a device that could see it: a delete of the
// file holding it, a line replacement, or a binary overwrite. Such tokens go
// into `removed`. At the end, every token ever written and not in `removed`
// must appear in some file of the final vault, possibly a conflict copy.
//
// The settled vaults must also match the server: every live head (its path
// and content hash, decrypted with a device's keys) is on every device with
// that content, and no device has a file the server does not hold live.
//
// Conflict copies are checked both ways. Every copy in the final vault must
// come from a conflict event, and every conflict event's copy must still be
// there unless the harness itself later deleted or renamed that copy (the
// random operations pick any existing file, copies included). Copy names
// can repeat (the name is free again once a copy is gone), so a removal
// only excuses the conflict events for that name seen before it.
import type { ApiClient } from '../../src/api/client';
import { decryptMeta } from '../../src/crypto/objects';
import type { VaultKeyring } from '../../src/crypto/vaultkeys';
import { hashHex } from '../../src/sync/content';
import { equalBytes, toHex } from '../../src/util/bytes';
import { ManualClock } from '../../src/util/clock';
import { CONFLICT_COPY_PATTERN } from '../../src/util/path';
import { seededRandom } from '../../src/util/random';
import { makeClient, settle, type SimClient } from '../helpers/client';
import type { User } from '../helpers/fixture';
import type { TestServer } from '../helpers/server';

export interface SeedOptions {
  seed: number;
  clients?: number;
  steps?: number;
}

export interface SeedReport {
  seed: number;
  files: number;
  conflictCopies: number;
  tokens: number;
  log: string[];
}

const TEXT_PATHS = ['a.md', 'b.md', 'c.md', 'Notes/d.md', 'Notes/e.md', 'Notes/Deep/f.md', 'g.txt', 'h.canvas'];
const BINARY_PATHS = ['img.png', 'Notes/doc.pdf'];
const ALL_PATHS = [...TEXT_PATHS, ...BINARY_PATHS];

const enc = new TextEncoder();
const latin1 = new TextDecoder('latin1');

export async function runSeed(srv: TestServer, o: SeedOptions): Promise<SeedReport> {
  const rnd = seededRandom(o.seed);
  const n = o.clients ?? 3;
  const steps = o.steps ?? 60;
  const clock = new ManualClock(Date.UTC(2026, 0, 1));
  const user: User = { username: `conv${o.seed}x${Math.floor(rnd.float() * 1e9)}`, password: 'password123' };
  await srv.createUser(user.username, user.password);

  const clients: SimClient[] = [];
  // Clients are stopped and their state closed however the seed ends, so a
  // failing seed does not leave engines running into the next one.
  let ok = false;
  try {
    for (let i = 0; i < n; i++) {
      clients.push(await makeClient(srv, user, {
        name: `dev${i}`, vault: i === 0 ? 'create' : clients[0]!.vaultId,
        random: seededRandom(o.seed * 1000 + i + 1), clock,
        // A mixed fleet: the last device has a case-insensitive file system (macOS, Windows).
        caseInsensitive: i === n - 1,
      }));
    }

    const log: string[] = [];
    const written = new Set<string>();
    const removed = new Set<string>();
    let tokenN = 0;
    const token = (c: number) => {
      const t = `<<s${o.seed}.c${c}.t${tokenN++}>>`;
      written.add(t);
      return t;
    };
    const tokensIn = (data: Uint8Array) => latin1.decode(data).match(/<<s\d+\.c\d+\.t\d+>>/g) ?? [];
    // Conflict copy path → number of conflict events for it when the harness last deleted or renamed it.
  const copyRemovedAfter = new Map<string, number>();
  const conflictEventsFor = (p: string) => clients.reduce((k, c) => k + c.events.filter((e) => e.type === 'conflict' && e.conflictPath === p).length, 0);
  const noteRemoval = (p: string) => {
    if (CONFLICT_COPY_PATTERN.test(p)) copyRemovedAfter.set(p, conflictEventsFor(p));
  };
  const isBinary = (p: string) => BINARY_PATHS.includes(p) || /\.(png|pdf)$/.test(p);

    for (let step = 0; step < steps; step++) {
      clock.advance(rnd.int(120_000));
      const ci = rnd.int(n);
      const c = clients[ci]!;
      const existing = (await c.adapter.list()).filter((p) => !p.startsWith('.'));
      const roll = rnd.float();
      if (roll < 0.22) {
        const free = ALL_PATHS.filter((p) => !existing.includes(p));
        if (free.length === 0) continue;
        const p = rnd.pick(free);
        const t = token(ci);
        const data = isBinary(p) ? new Uint8Array([...rnd.bytes(8), ...enc.encode(t), ...rnd.bytes(8)]) : enc.encode(`# ${p}\n${t}\n`);
        await c.adapter.write(p, data);
        log.push(`${step} ${c.name} create ${p} ${t}`);
      } else if (roll < 0.52) {
        if (existing.length === 0) continue;
        const p = rnd.pick(existing);
        const old = (await c.adapter.read(p))!;
        const t = token(ci);
        if (isBinary(p)) {
          for (const x of tokensIn(old)) removed.add(x);
          await c.adapter.write(p, new Uint8Array([...rnd.bytes(8), ...enc.encode(t), ...rnd.bytes(8)]));
          log.push(`${step} ${c.name} overwrite ${p} ${t}`);
        } else {
          const lines = new TextDecoder().decode(old).split('\n');
          const at = rnd.int(lines.length);
          const tokenLines = lines.map((l, i) => (/^<<s/.test(l) ? i : -1)).filter((i) => i >= 0);
          if (tokenLines.length > 0 && rnd.float() < 0.3) {
            const i = rnd.pick(tokenLines);
            removed.add(lines[i]!);
            lines[i] = t;
            log.push(`${step} ${c.name} replace-line ${p} ${t}`);
          } else {
            lines.splice(at, 0, t);
            log.push(`${step} ${c.name} insert ${p}@${at} ${t}`);
          }
          await c.adapter.write(p, enc.encode(lines.join('\n')));
        }
      } else if (roll < 0.60) {
        // Renames keep the kind (text or binary), so token checks stay meaningful.
        if (existing.length === 0) continue;
        const src = rnd.pick(existing);
        const free = ALL_PATHS.filter((p) => !existing.includes(p) && isBinary(p) === isBinary(src));
        if (free.length === 0) continue;
        const dst = rnd.pick(free);
        noteRemoval(src);
        await c.adapter.rename(src, dst);
        log.push(`${step} ${c.name} rename ${src} -> ${dst}`);
      } else if (roll < 0.68) {
        if (existing.length === 0) continue;
        const p = rnd.pick(existing);
        for (const x of tokensIn((await c.adapter.read(p))!)) removed.add(x);
        noteRemoval(p);
        await c.adapter.remove(p);
        log.push(`${step} ${c.name} delete ${p}`);
      } else if (roll < 0.76) {
        c.net.setOnline(!c.net.online);
        log.push(`${step} ${c.name} ${c.net.online ? 'online' : 'offline'}`);
      } else if (roll < 0.79) {
        c.net.loseNextResponse('POST', '/commit');
        log.push(`${step} ${c.name} will lose a commit response`);
      } else if (roll < 0.82) {
        await c.restart();
        log.push(`${step} ${c.name} restart`);
      } else {
        await c.engine.runCycle();
        log.push(`${step} ${c.name} sync`);
      }
    }

    for (const c of clients) c.net.setOnline(true);
    await settle(clients, 30);

    const snaps = clients.map((c) => c.adapter.snapshot());
    const first = snaps[0]!;
    const describe = (m: Map<string, Uint8Array>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, d]) => `${p} ${latin1.decode(d)}`).join('\n');
    for (let i = 1; i < snaps.length; i++) {
      if (describe(snaps[i]!) !== describe(first)) {
        throw new Error(`seed ${o.seed}: ${clients[i]!.name} differs from dev0\n--- dev0\n${describe(first)}\n--- ${clients[i]!.name}\n${describe(snaps[i]!)}\n--- log\n${log.join('\n')}`);
      }
    }
    const seqs = await Promise.all(clients.map((c) => c.state.getCursor()));
    const serverSeq = (await clients[0]!.api.changes(clients[0]!.vaultId, 0, 1)).vaultSeq;
    if (seqs.some((s) => s !== serverSeq)) throw new Error(`seed ${o.seed}: cursors ${seqs} != server seq ${serverSeq}`);

    const present = new Set([...first.values()].flatMap((d) => tokensIn(d)));
    const lost = [...written].filter((t) => !present.has(t) && !removed.has(t));
    if (lost.length > 0) throw new Error(`seed ${o.seed}: lost edits ${lost.join(', ')}\n--- final\n${describe(first)}\n--- log\n${log.join('\n')}`);

    const copies = [...first.keys()].filter((p) => CONFLICT_COPY_PATTERN.test(p));
    const reported = new Set(clients.flatMap((c) => c.events.flatMap((e) => (e.type === 'conflict' ? [e.conflictPath] : []))));
    const unexplained = copies.filter((p) => !reported.has(p));
    if (unexplained.length > 0) throw new Error(`seed ${o.seed}: conflict copies without a conflict event: ${unexplained.join(', ')}`);

    const missingCopies = [...new Set(clients.flatMap((c) => c.events.flatMap((e) => (e.type === 'conflict' ? [e.conflictPath] : []))))]
      .filter((p) => !first.has(p) && (copyRemovedAfter.get(p) ?? -1) < conflictEventsFor(p));
    if (missingCopies.length > 0) throw new Error(`seed ${o.seed}: conflict events whose copy is gone: ${missingCopies.join(', ')}\n--- final\n${describe(first)}\n--- log\n${log.join('\n')}`);

    const server = await serverFiles(clients[0]!.api, clients[0]!.ring);
    const describeHashes = (m: Map<string, string>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, h]) => `${p} ${h}`).join('\n');
    for (let i = 0; i < snaps.length; i++) {
      const local = new Map<string, string>();
      for (const [p, d] of snaps[i]!) local.set(p, await hashHex(d));
      if (describeHashes(local) !== describeHashes(server)) {
        throw new Error(`seed ${o.seed}: ${clients[i]!.name} differs from the server's live heads\n--- server\n${describeHashes(server)}\n--- ${clients[i]!.name}\n${describeHashes(local)}\n--- log\n${log.join('\n')}`);
      }
    }

    ok = true;
    return { seed: o.seed, files: first.size, conflictCopies: copies.length, tokens: written.size, log };
  } finally {
    let stopError: unknown = null;
    for (const c of clients) {
      try {
        await c.engine.stop();
      } catch (err) {
        stopError ??= err;
      } finally {
        c.state.close();
      }
    }
    if (ok && stopError) throw stopError;
  }
}

/** The server's live files: path → content hash (hex), from each live head's decrypted metadata. */
async function serverFiles(api: ApiClient, ring: VaultKeyring): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let after: Uint8Array | null = null;
  for (;;) {
    const page = await api.heads(ring.vaultId, after);
    for (const h of page.heads) {
      if (h.deleted) continue;
      const v = (await api.history(ring.vaultId, h.fileId)).find((x) => equalBytes(x.versionId, h.versionId));
      if (!v) throw new Error(`head ${toHex(h.versionId)} of ${toHex(h.fileId)} is not in its history`);
      const meta = await decryptMeta(ring, v.epoch, v.fileId, v.versionId, v.encMeta);
      if (out.has(meta.path)) throw new Error(`two live heads claim ${meta.path}`);
      out.set(meta.path, toHex(meta.contentHash));
    }
    if (!page.more || page.heads.length === 0) return out;
    after = page.heads[page.heads.length - 1]!.fileId;
  }
}

/** Seeds to run: OBSYNC_CONVERGENCE_SEED replays one; else OBSYNC_CONVERGENCE_SEEDS (default 20) starting at 1. */
export function seedsFromEnv(env: Record<string, string | undefined>): number[] {
  if (env['OBSYNC_CONVERGENCE_SEED']) return [Number(env['OBSYNC_CONVERGENCE_SEED'])];
  const count = Number(env['OBSYNC_CONVERGENCE_SEEDS'] ?? '20');
  const start = Number(env['OBSYNC_CONVERGENCE_FIRST_SEED'] ?? '1');
  return Array.from({ length: count }, (_, i) => start + i);
}
