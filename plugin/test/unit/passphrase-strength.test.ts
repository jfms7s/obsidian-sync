// The passphrase strength rule (owner decision 2026-10-09): at least 4 words or 16 characters.
import { describe, expect, it } from 'vitest';
import { isStrongPassphrase, WeakPassphraseError } from '../../src/services/account';
import { describeError } from '../../src/shell/errors';

describe('isStrongPassphrase', () => {
  it('accepts four words or sixteen characters', () => {
    expect(isStrongPassphrase('cat dog sun pie')).toBe(true); // 4 words, 15 characters
    expect(isStrongPassphrase('maple-rocket-tundra-otter')).toBe(true);
    expect(isStrongPassphrase('correct horse battery staple')).toBe(true);
    expect(isStrongPassphrase('abcdefghijklmnop')).toBe(true); // 16 characters
    expect(isStrongPassphrase('a long enough passphrase')).toBe(true);
  });

  it('refuses shorter passphrases with fewer words', () => {
    expect(isStrongPassphrase('short')).toBe(false);
    expect(isStrongPassphrase('password12')).toBe(false);
    expect(isStrongPassphrase('Tr0ub4dor&3')).toBe(false);
    expect(isStrongPassphrase('abcdefghijklmno')).toBe(false); // 15 characters, one word
    expect(isStrongPassphrase('cat dog sun')).toBe(false); // three words
    expect(isStrongPassphrase('a b c d e f g h')).toBe(false); // one-letter "words" do not count
    expect(isStrongPassphrase('   padded      ')).toBe(false); // spaces around do not count
  });

  it('says what to do, with the diceware advice', () => {
    const shown = describeError(new WeakPassphraseError());
    expect(shown.kind).toBe('fix-input');
    expect(shown.message).toMatch(/at least 4 words or 16 characters/);
    expect(shown.message).toMatch(/diceware/);
  });
});
