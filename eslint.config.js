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

// Gateway-migration guard (P1.5). Feature/UI/store code must not reach for the
// removed legacy gateway forwarders (`services/fs`, `services/gateways/index`).
// Business code gets its ports contractually via `createGateways(deps)` / the
// injected `DesktopRuntime`, or imports the narrow ports from the platform layer.
// Flat-config `files` patterns are relative to this config file (repo root), so
// scope the ban to the desktop feature/UI layers under apps/desktop/src.
//
// No `chat/**` entry: there has never been an `apps/desktop/src/chat/` in this
// repository. The chat panel came from `ui/ChatPanel.vue` and lives in
// `features/chat/**` now, which the `features` globs in the list already match —
// so the entry that named `chat/` protected nothing for as long as it existed.
// This list is an enumeration of layers, and it is not the whole set: `app/`,
// `view/` and `composables/` under src/ are the same kind of code and are
// outside it.
const LEGACY_GATEWAY_BANNED_FILES = [
  'apps/desktop/src/ui/**/*.ts',
  'apps/desktop/src/ui/**/*.vue',
  'apps/desktop/src/stores/**/*.ts',
  'apps/desktop/src/stores/**/*.vue',
  'apps/desktop/src/features/**/*.ts',
  'apps/desktop/src/features/**/*.vue',
  'apps/desktop/src/components/**/*.ts',
  'apps/desktop/src/components/**/*.vue',
  'apps/desktop/src/plugins/**/*.ts',
  'apps/desktop/src/plugins/**/*.vue',
]

const noLegacyGatewayImport = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'bans importing the removed legacy gateway forwarders (services/fs, services/gateways/index) from feature/UI code',
    },
    schema: [],
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const src = node.source.value
        // Matches `services/fs` and `services/gateways/index`, optionally behind
        // relative `../`/`../../` prefixes. Never matches `platform/gateways/*`.
        if (/(?:^|[/])services[/](?:fs|gateways[/]index)(?:$|[/])/.test(src)) {
          context.report({
            node,
            message:
              'Legacy gateway forwarder is banned here. Use createGateways(deps) / the injected DesktopRuntime, or import the narrow ports from platform/gateways.',
          })
        }
      },
    }
  },
}

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
    files: LEGACY_GATEWAY_BANNED_FILES,
    plugins: {
      nekowite: {
        meta: { name: 'nekowite-inline', version: '1.0.0' },
        rules: { 'no-legacy-gateway-import': noLegacyGatewayImport },
      },
    },
    rules: {
      'nekowite/no-legacy-gateway-import': 'error',
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/src-tauri/**'],
  },
]