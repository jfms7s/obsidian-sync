import { ManualClock } from '../../src/util/clock';
import { MemoryAdapter } from '../../src/vault/memory';
import { describeAdapterContract } from '../contract/adapter-contract';

for (const caseInsensitive of [false, true]) {
  describeAdapterContract(
    `MemoryAdapter (${caseInsensitive ? 'case-insensitive' : 'case-sensitive'})`,
    async () => {
      const adapter = new MemoryAdapter(caseInsensitive, new ManualClock(Date.UTC(2026, 0, 1)));
      return { adapter, outside: (path, data) => adapter.writeSilently(path, data), settle: async () => undefined };
    },
    { caseInsensitive },
  );
}
