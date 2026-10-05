import { describe, expect, it } from 'vitest';
import { IgnoreRules, InvalidIgnorePatternError, validateIgnorePattern } from '../../src/vault/ignore';

describe('ignore rules', () => {
  const rules = new IgnoreRules(['Private/', '*.pdf', 'drafts/**/*.md', 'Templates/Daily.md'], { configDir: '.obsidian' });
  it.each([
    ['.obsidian/app.json', true],
    ['.obsidian/plugins/x/main.js', true],
    ['sub/.git/config', true],
    ['.trash/old.md', true],
    ['Photos/.DS_Store', true],
    ['._resource.md', true],
    ['Private/diary.md', true],
    ['Work/Private/x.md', true],
    ['paper.pdf', true],
    ['a/b/paper.pdf', true],
    ['drafts/x.md', true],
    ['drafts/a/b/x.md', true],
    ['other/drafts/x.md', false],
    ['Templates/Daily.md', true],
    ['x/Templates/Daily.md', false],
    ['Notes/obsidian.md', false],
    ['Notes/Private.md', false],
    ['Notes/pdf.md', false],
    ['.obsidian.md', false],
  ])('%s → %s', (path, ignored) => {
    expect(rules.matches(path)).toBe(ignored);
  });
  it('skips blank lines and comments', () => {
    expect(new IgnoreRules(['', '# comment']).matches('# comment')).toBe(false);
  });

  it('matches regardless of case on a case-insensitive vault', () => {
    expect(new IgnoreRules(['Private/']).matches('private/x.md')).toBe(false);
    const ci = new IgnoreRules(['Private/', '*.pdf'], { caseInsensitive: true, configDir: '.obsidian' });
    expect(ci.matches('private/x.md')).toBe(true);
    expect(ci.matches('Paper.PDF')).toBe(true);
    expect(ci.matches('.OBSIDIAN/app.json')).toBe(true);
    expect(ci.matches('Notes/x.md')).toBe(false);
  });
  it('refuses negation and character classes, which it does not support', () => {
    expect(() => new IgnoreRules(['!keep.md'])).toThrow(InvalidIgnorePatternError);
    expect(() => new IgnoreRules(['[abc].md'])).toThrow(/not supported/);
    expect(validateIgnorePattern('notes/*.md')).toBeNull();
    expect(validateIgnorePattern('!x')).toMatch(/not supported/);
  });
});

describe('the configuration folder', () => {
  it('is ignored under whatever name the vault gives it, and under no other', () => {
    const custom = new IgnoreRules([], { configDir: '.obsidian-mobile' });
    expect(custom.matches('.obsidian-mobile/plugins/obsync/data.json')).toBe(true);
    expect(custom.matches('.obsidian/app.json')).toBe(false);
    expect(new IgnoreRules([], { configDir: '/.config-x/' }).matches('.config-x/app.json')).toBe(true);
    expect(new IgnoreRules().matches('.obsidian/app.json')).toBe(false); // no name given, none assumed
  });
});
