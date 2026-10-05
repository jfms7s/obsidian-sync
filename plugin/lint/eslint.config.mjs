// Obsidian's own plugin rules (eslint-plugin-obsidianmd, which includes
// typescript-eslint's type-checked set) over plugin/src. Run from the
// repository root, where manifest.json is: that plugin reads it from the
// working directory to check the manifest rules.
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  { ignores: ['plugin/src/gen/**'] }, // generated protobuf code
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: false, project: ['plugin/lint/tsconfig.json'], tsconfigRootDir: new URL('../..', import.meta.url).pathname },
    },
  },
  {
    // The declarative settings API (getSettingDefinitions) exists from Obsidian 1.13; the plugin supports 1.8.7 and up.
    files: ['plugin/src/shell/settings-tab.ts'],
    rules: { 'obsidianmd/settings-tab/prefer-setting-definitions': 'off' },
  },
]);
