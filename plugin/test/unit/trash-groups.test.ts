import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../../src/services/history';
import { groupTrash, TRASH_GROUP_GAP_MS, type TrashItem } from '../../src/shell/history-controller';

const MIN = 60_000;
const item = (path: string, device: string, deletedAtMs: number): TrashItem => ({ path, device, deletedAtMs, entry: {} as HistoryEntry });
const shape = (items: TrashItem[]) => groupTrash(items).map((g) => `${g.device}:${g.items.map((i) => i.path).join(',')}`);

describe('trash groups', () => {
  it('groups by the deleting device, newest first, items newest first', () => {
    expect(shape([
      item('a1', 'Laptop', 10 * MIN), item('p1', 'Phone', 11 * MIN), item('a2', 'Laptop', 10 * MIN + 30_000), item('a3', 'Laptop', 9 * MIN),
    ])).toEqual(['Phone:p1', 'Laptop:a2,a1,a3']);
  });

  it('starts a new group after a gap longer than TRASH_GROUP_GAP_MS within one device', () => {
    expect(shape([
      item('new', 'Laptop', 100 * MIN), item('old2', 'Laptop', 100 * MIN - TRASH_GROUP_GAP_MS - 1), item('old1', 'Laptop', 100 * MIN - TRASH_GROUP_GAP_MS - 2 * MIN),
    ])).toEqual(['Laptop:new', 'Laptop:old2,old1']);
  });

  it('chains deletions that each follow the previous one within the gap', () => {
    const items = Array.from({ length: 5 }, (_, i) => item(`f${i}`, 'Laptop', i * (TRASH_GROUP_GAP_MS - 1)));
    const [g, ...rest] = groupTrash(items);
    expect(rest).toEqual([]);
    expect(g).toMatchObject({ device: 'Laptop', newestMs: 4 * (TRASH_GROUP_GAP_MS - 1), oldestMs: 0 });
  });

  it('keeps versions that name no device together under the empty name', () => {
    expect(shape([item('x', '', 1), item('y', '', 2)])).toEqual([':y,x']);
    expect(groupTrash([])).toEqual([]);
  });
});
