import { describe, expect, it } from 'vitest';
import { IgnoreRules } from '../../src/vault/ignore';

describe('ignore rules', () => {
  const rules = new IgnoreRules(['Private/', '*.pdf', 'drafts/**/*.md', 'Templates/Daily.md']);
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
});
