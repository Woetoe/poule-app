// ESLint: aanbevolen regels voor alle JavaScript, ook de scripts in de HTML-pagina's.
import js from '@eslint/js';
import globals from 'globals';
import html from 'eslint-plugin-html';

export default [
  { ignores: ['web/xlsx.full.min.js', 'node_modules/**', 'android/**'] },
  js.configs.recommended,
  {
    files: ['web/**/*.js', 'web/**/*.html'],
    plugins: { html },
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals.browser, Poule: 'readonly', XLSX: 'readonly', module: 'readonly' } },
    rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }] }
  },
  {
    files: ['tests/**/*.js', 'tools/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }] }
  },
  {
    files: ['tests/**/*.mjs', '*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node, ...globals.browser, Poule: 'readonly' } }
  }
];
