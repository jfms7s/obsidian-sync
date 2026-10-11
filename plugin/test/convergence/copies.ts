// Which conflict and collision copies an event reported, and whether each is
// still there at the end or a user operation removed it (harness.ts header).
//
// File ids come from names (fileIdFor), so a copy is told apart by its name
// and by the step at which that name appeared: a name can repeat once its
// copy is gone. A removal of the name excuses a copy only when it came after
// the copy appeared.
//
// A copy is there while some device holds it or the server holds it live. A
// device can push a copy and remove it before any other device pulls it;
// until its next sync only the server holds the copy, and the copy another
// device then pulls is the same file, not a new one.

export type CopyKind = 'conflict' | 'collision';

/** A copy an event named: the copy's path, the device that reported it and the step it was seen at. */
export interface ReportedCopy {
  path: string;
  device: string;
  step: number;
  kind: CopyKind;
}

export class CopyTracker {
  private readonly reported: ReportedCopy[] = [];
  /** The steps at which each name (folded) appeared, having been nowhere. */
  private readonly appearances = new Map<string, number[]>();
  private present = new Set<string>();
  /** The spellings each present name (folded) had when a device last held it. */
  private spellings = new Map<string, string[]>();
  private readonly removals: Array<{ path: string; step: number }> = [];

  /** fold: how names compare (case-folded on a case-insensitive fleet). */
  constructor(private readonly fold: (path: string) => string) {}

  /** An event named the copy at path. */
  report(copy: ReportedCopy): void {
    this.reported.push(copy);
  }

  /** The harness deleted or renamed away the copy name path at step. */
  removed(path: string, step: number): void {
    this.removals.push({ path, step });
  }

  /**
   * The copies there after step: those on the devices, and those that left
   * every device but that the server still holds live (liveOnServer: whether
   * the server holds a live file at one of these paths). The names that were
   * nowhere before appear at step.
   */
  async scan(step: number, onDevices: Iterable<string>, liveOnServer: (paths: string[]) => Promise<boolean>): Promise<void> {
    const spellings = new Map<string, string[]>();
    for (const p of onDevices) {
      const n = this.fold(p);
      const known = spellings.get(n) ?? [];
      if (!known.includes(p)) spellings.set(n, [...known, p]);
    }
    for (const n of this.present) {
      if (spellings.has(n)) continue;
      const last = this.spellings.get(n)!;
      if (await liveOnServer(last)) spellings.set(n, last);
    }
    for (const n of spellings.keys()) if (!this.present.has(n)) this.appearances.set(n, [...(this.appearances.get(n) ?? []), step]);
    this.present = new Set(spellings.keys());
    this.spellings = spellings;
  }

  /** The reported copies not among finalPaths that no later removal explains. */
  missing(finalPaths: Iterable<string>): ReportedCopy[] {
    const names = new Set([...finalPaths].map(this.fold));
    return this.reported.filter((cp) => {
      if (names.has(this.fold(cp.path))) return false;
      const appeared = this.appearedAt(cp.path, cp.step);
      return !this.removals.some((r) => this.fold(r.path) === this.fold(cp.path) && r.step > appeared);
    });
  }

  /**
   * The step at which the copy reported at step `seen` appeared: its last
   * appearance up to then, or its first after, for an event ahead of the
   * scan. An event can name a copy later than it appeared (a device that was
   * offline reports it when it meets it), so a removal counts from when the
   * copy was there, not from when it was reported.
   */
  private appearedAt(path: string, seen: number): number {
    const steps = this.appearances.get(this.fold(path)) ?? [seen];
    return steps.filter((x) => x <= seen).pop() ?? steps[0]!;
  }
}
