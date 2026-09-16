'use strict'

const js = require('@eslint/js')
const globals = require('globals')
const importPlugin = require('eslint-plugin-import')
const tseslint = require('@typescript-eslint/eslint-plugin')
const tsParser = require('@typescript-eslint/parser')
const vuePlugin = require('eslint-plugin-vue')
const vueParser = require('vue-eslint-parser')

// TypeScript and Vue sources carry the full rule set; JS-extension sources
// carry the resolution rule and nothing else (see `JS_FILES` below). Scoping
// every block matters: `eslint <dir>` on flat config lints every file matched
// by at least one overlay, so an unscoped block would pull in CSS/JSON/etc.
// that eslintrc's `--ext .ts,.vue` used to skip.
const TS_FILES = ['**/*.ts', '**/*.mts', '**/*.cts']
const TS_VUE_FILES = [...TS_FILES, '**/*.vue']

// The JS-extension sources. `.mjs` belongs here for a reason that only shows up
// in a report: ESLint walks and parses these files, but no config block matched
// them, so they received zero rules — and nothing else in the chain resolved
// their imports either (`tsconfig.json`'s `include` covers `*.ts`/`*.vue` only,
// so `vue-tsc` never reads them; vite only ever loads the renderer graph).
// `e2e/webkit/perf.mjs` held an import of `./perf-probes.mjs`, a module that has
// never existed in any commit, and every gate was silent about it — a parse
// error in a sibling file is what surfaced the directory at all.
// See `.superpowers/sdd/roadmap/reports/perf-harness-orphan.md`.
const JS_FILES = ['**/*.mjs', '**/*.cjs', '**/*.js']

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
  // Resolution gate, and it is deliberately scoped to one file class.
  //
  // Why only the JS class: the TS/Vue class already has a resolver that knows
  // this project's specifiers — `vue-tsc`, which reports an unresolvable import
  // as TS2307 (a dangling one was verified red before this block was written).
  // Pointing *this* plugin's resolver at that class instead needs a second
  // resolver to re-derive what TypeScript already knows, and without one it
  // reports ~900 errors that are all the same false positive (TypeScript's
  // extensionless `./foo` -> `./foo.ts`). A second resolver that duplicates a
  // working one is a parallel mechanism; the JS files have no resolver at all,
  // which is the actual hole.
  //
  // Why `no-unresolved` and nothing else: it is the rule whose absence let
  // `e2e/webkit/perf.mjs` import a module nobody ever wrote. Enabling the rest
  // of `js.configs.recommended` alongside it is tempting — these files get no
  // other rule — but it reports `sleep` as an unused import in `measure.mjs`,
  // and `measure.mjs` is the named frame-timing instrument and is not a file
  // this change may edit. That would leave a permanent error in the gate. Which
  // rules the harness should otherwise carry is a separate decision.
  //
  // The resolver here is the plugin's bundled node resolver: it understands
  // `node:*` builtins and relative paths, and it resolves an extensionless
  // `./foo` to `foo.mjs` while still rejecting `./foo.js` when only `foo.mjs`
  // exists. `commonjs: true` is what makes it look at `require()` as well, which
  // is the only import syntax `.cjs` has. It reports nothing on the eleven
  // harness files in `e2e/webkit/`, on `run-e2e.mjs`, or on `screenshot.cjs`.
  // The `/src/...` and `/e2e/...` specifiers the harness uses are not imports at
  // all — they are Vite dev-server URLs inside template-literal strings handed
  // to WebDriver's `executeAsync`, so ESLint never parses them. They are covered
  // by `tsconfig.json`'s `"/src/*"` paths mapping for the TS specs that do
  // import them for real.
  //
  // This block keys on a file class, and the lint scripts that reach it are
  // directory-wide (`eslint .`), never a list of paths: a class rule that no
  // directory walk reaches is the same hole with a shorter reach. That is also
  // why `.mjs` had to be added to `JS_FILES` rather than being left matched by
  // nothing — see the note above `JS_FILES`.
  {
    files: JS_FILES,
    plugins: { import: importPlugin },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'import/no-unresolved': ['error', { commonjs: true }],
    },
  },
  {
    // `.cjs` is CommonJS, and saying so is what lets `require` parse as the
    // call it is rather than as an undefined global in module scope.
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/src-tauri/**'],
  },
]