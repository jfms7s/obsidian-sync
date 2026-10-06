// Which setup screen the settings tab shows next. The answer comes from what
// is stored here and what the server says, never from what the tab did last,
// so it is right after a restart in the middle of setup.
import { NetworkError } from '../api/errors';
import { apiFor, keyStatus, recoveryWordsToConfirm, type ClientDeps } from '../services/account';
import type { LocalState } from '../state/store';

export type SetupStep =
  | { kind: 'login' }
  /** The recovery words, to be written down and confirmed with account.acknowledgeRecoveryWords. */
  | { kind: 'confirm-recovery'; words: string }
  /** First device: choose a passphrase (reupload: this device holds the keys but the server lost them; same call). */
  | { kind: 'setup-keys'; reupload: boolean }
  | { kind: 'unlock' }
  | { kind: 'choose-vault' }
  | { kind: 'ready' };

export async function nextStep(state: LocalState, deps: ClientDeps = {}): Promise<SetupStep> {
  const session = await state.getSession();
  if (!session) return { kind: 'login' };
  const vault = await state.getVault();
  const vaultReady = !!vault && vault.userId === session.userId;
  let status: Awaited<ReturnType<typeof keyStatus>>;
  try {
    status = await keyStatus(state, apiFor(session, deps), session);
  } catch (err) {
    // Offline: a device that was set up keeps syncing (and reports being offline itself).
    const keys = await state.getUserKeys();
    if (err instanceof NetworkError && keys?.userId === session.userId && vaultReady) return { kind: 'ready' };
    throw err;
  }
  const words = await recoveryWordsToConfirm(state, session);
  if (words !== null) return { kind: 'confirm-recovery', words };
  if (status === 'needs-setup') return { kind: 'setup-keys', reupload: false };
  if (status === 'needs-reupload') return { kind: 'setup-keys', reupload: true };
  if (status === 'needs-unlock') return { kind: 'unlock' };
  return vaultReady ? { kind: 'ready' } : { kind: 'choose-vault' };
}
