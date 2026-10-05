// The surface plan 3 builds on.
import { expect, it } from 'vitest';
import * as engine from '../../src/index';

it('exports the engine, adapter contract, services and errors', () => {
  for (const name of [
    'SyncEngine', 'LocalState', 'MemoryAdapter', 'IgnoreRules', 'ApiClient', 'ApiError', 'NetworkError', 'CryptoError', 'merge3', 'normalizeServerUrl', 'openSyncSession', 'defaultWebSocketFactory', 'fetchTransport', 'DEFAULT_MAX_FILE_BYTES',
    'Argon2TooCostlyError', 'MissingEpochKeyError', 'InvalidIgnorePatternError', 'validateIgnorePattern', 'TruncatedBodyError', 'SetupPassphraseMismatchError', 'DEBOUNCE_MAX_WAIT_MS',
  ]) {
    expect(engine).toHaveProperty(name);
  }
  expect(Object.keys(engine.account)).toEqual(expect.arrayContaining(['login', 'logout', 'keyStatus', 'setupKeys', 'recoveryWordsToConfirm', 'acknowledgeRecoveryWords', 'KeysAlreadySetUpError', 'SetupPassphraseMismatchError', 'unlockWithPassphraseService', 'unlockWithRecoveryService', 'changePassphrase', 'listDevices', 'revokeDevice']));
  expect(Object.keys(engine.vaults)).toEqual(expect.arrayContaining(['listRemoteVaults', 'createVault', 'chooseVault']));
  expect(Object.keys(engine.history)).toEqual(expect.arrayContaining(['fileHistory', 'listTrash', 'readVersion', 'restore', 'UnsyncedChangesError']));
  const needsReupload: engine.account.KeyStatus = 'needs-reupload';
  expect(needsReupload).toBe('needs-reupload');
});
