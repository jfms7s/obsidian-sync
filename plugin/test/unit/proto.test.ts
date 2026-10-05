import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { expect, it } from 'vitest';
import { ErrorCode, FileMetaSchema } from '../../src/gen/obsync/v1/obsync_pb';

it('generates the TypeScript protocol, including FileMeta', () => {
  const m = create(FileMetaSchema, { path: 'a.md', mtimeMs: 5n, size: 3n, contentHash: new Uint8Array([1]), renamedFrom: 'b.md', deviceName: 'Phone' });
  expect(fromBinary(FileMetaSchema, toBinary(FileMetaSchema, m))).toEqual(m);
  expect(ErrorCode.WRONG_PASSWORD).toBe(12);
});
