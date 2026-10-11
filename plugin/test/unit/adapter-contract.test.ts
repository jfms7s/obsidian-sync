import { ManualClock } from '../../src/util/clock';
import { MemoryAdapter } from '../../src/vault/memory';
import { describeAdapterContract } from '../contract/adapter-contract';

for (const caseInsensitive of [false, true]) {
  for (const coarseMtime of [false, true]) {
    describeAdapterContract(
      `MemoryAdapter (${caseInsensitive ? 'case-insensitive' : 'case-sensitive'}, ${coarseMtime ? 'whole-second' : 'millisecond'} mtimes)`,
      async () => {
        const adapter = new MemoryAdapter(caseInsensitive, new ManualClock(Date.UTC(2026, 0, 1)), { coarseMtime });
        return { adapter, outside: (path, data) => adapter.writeSilently(path, data), settle: async () => undefined };
      },
      { caseInsensitive },
    );
  }
}
