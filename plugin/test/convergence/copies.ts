// Which conflict and collision copies an event reported, and whether each is
// still there at the end or a user operation removed it (harness.ts header).
//
// File ids come from names (fileIdFor), so a copy is told apart by its name
// and by the step at which that name appeared on some device: a name can
// repeat once its copy is gone. A removal of the name excuses a copy only
// when it came after the copy appeared.

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

  /** The copies on the devices after step: the names that were nowhere before appear at step. */
  scan(step: number, onDevices: Iterable<string>): void {
    const now = new Set<string>();
    for (const p of onDevices) now.add(this.fold(p));
    for (const n of now) if (!this.present.has(n)) this.appearances.set(n, [...(this.appearances.get(n) ?? []), step]);
    this.present = now;
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
