'use strict'

const js = require('@eslint/js')
const globals = require('globals')
const tseslint = require('@typescript-eslint/eslint-plugin')
const tsParser = require('@typescript-eslint/parser')
const vuePlugin = require('eslint-plugin-vue')
const vueParser = require('vue-eslint-parser')

// Only TypeScript and Vue sources are linted. Scoping every block matters:
// `eslint <dir>` on flat config lints every file matched by at least one
// overlay, so an unscoped block would pull in CSS/JSON/etc. that eslintrc's
// `--ext .ts,.vue` used to skip.
const TS_FILES = ['**/*.ts', '**/*.mts', '**/*.cts']
const TS_VUE_FILES = [...TS_FILES, '**/*.vue']

const tsFlat = tseslint.configs['flat/recommended']

module.exports = [
  {
    ...js.configs.recommended,
    files: TS_VUE_FILES,
  },
  {
    files: TS_VUE_FILES,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
      },
    },
  },
  {
    files: TS_VUE_FILES,
    plugins: {
      vue: vuePlugin,
      '@typescript-eslint': tseslint,
    },
  },
  {
    ...tsFlat[0],
    files: TS_FILES,
  },
  tsFlat[1],
  {
    ...tsFlat[2],
    files: TS_VUE_FILES,
  },
  ...vuePlugin.configs['flat/recommended'].map((block, i) => {
    const files = i === 1 ? ['**/*.vue'] : TS_VUE_FILES
    return { ...block, files }
  }),
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tsParser,
      },
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/src-tauri/**'],
  },
]