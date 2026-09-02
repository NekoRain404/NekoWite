# ESLint eslintrc → flat config migration

## Status
Done. All three workspaces lint clean with zero errors and **zero deprecation warnings**.

## What changed
- **Created** root `eslint.config.js` (flat config, CommonJS — root `package.json` has no `"type": "module"`).
- **Removed** root `.eslintrc.cjs` (the deprecated eslintrc config).
- **Removed** `ESLINT_USE_FLAT_CONFIG=false` from all three `lint` scripts:
  - `packages/editor-core`: `eslint src --ext .ts` → `eslint src`
  - `packages/plugin-host`: `eslint src --ext .ts` → `eslint src`
  - `apps/desktop`: `eslint src --ext .ts,.vue` → `eslint src`
  - `--ext` is no longer needed in flat config; file selection is done via the `files` patterns in `eslint.config.js`.
- **Root `package.json`**: added `@eslint/js` (^9) and `globals` (^14) devDependencies (required by flat config for `eslint:recommended` and `env` globals). `pnpm-lock.yaml` updated accordingly.

## Flat config structure (`eslint.config.js`)
```
js.configs.recommended                    → legacy `eslint:recommended`
globals block (browser+node+es2021)       → legacy `env: { browser, es2022, node }`
tseslint.configs['flat/recommended']      → legacy `plugin:@typescript-eslint/recommended`
vuePlugin.configs['flat/recommended']     → legacy `plugin:vue/vue3-recommended`
explicit vue parser block (`**/*.vue`)    → vue-eslint-parser + nested @typescript-eslint/parser
ignores: dist / node_modules / src-tauri  → legacy `ignorePatterns`
```

### Rule-set mapping details
| Legacy (eslintrc) | Flat (eslint.config.js) |
|---|---|
| `extends: eslint:recommended` | `@eslint/js` → `js.configs.recommended` |
| `extends: plugin:vue/vue3-recommended` | `eslint-plugin-vue` → `configs['flat/recommended']` |
| `extends: plugin:@typescript-eslint/recommended` | `@typescript-eslint/eslint-plugin` → `configs['flat/recommended']` |
| `parser: vue-eslint-parser` | explicit block for `**/*.vue` |
| `parserOptions.parser: '@typescript-eslint/parser'` | nested via `parserOptions.parser` on the `.vue` block; `@typescript-eslint/parser` for `.ts` |
| `env: browser / es2022 / node` | `globals.browser` + `globals.node` + `globals.es2021` (`es2022` has no extra globals beyond `es2021`; ESLint 9's own `es2022` env maps to the same global set) |
| `ignorePatterns: dist, node_modules, src-tauri` | `ignores: ['**/dist/**', '**/node_modules/**', '**/src-tauri/**']` |

Notes / gotchas handled:
- `tseslint.configs['flat/recommended']` is an **array** of 3 overlays; the legacy string config referenced the same rules. The plugin-registration overlay was scoped to `**/*.ts` only, which caused "could not find plugin @typescript-eslint" on `.vue` files — fixed by an explicit `plugins` block covering `**/*.{ts,vue}`.
- `eslint-plugin-vue`'s flat `recommended` sets `parser: vue-eslint-parser` for `.vue` but does **not** wire the nested TS parser; a dedicated `.vue` block adds `parserOptions.parser = @typescript-eslint/parser` so `<script setup lang="ts">` parses correctly.
- Every block is scoped to `**/*.{ts,vue}` so `eslint src` (no `--ext`) does not pull in `.css`/`.json` files the way unscoped overlays would.
- Verified equivalence by diffing resolved rules (legacy `--print-config` vs flat `--print-config`) for a `.ts` and a `.vue` file — only cosmetic severity-representation differences (e.g. `"error"` vs `2`, explicit default options) remain; effective severities and rule set match.

## Verification evidence
### `pnpm -r lint` — no ESLintRCWarning / deprecation
```
Scope: 3 of 4 workspace projects
packages/editor-core lint$ eslint src
packages/editor-core lint: Done
packages/plugin-host lint$ eslint src
packages/plugin-host lint: Done
apps/desktop lint$ eslint src
apps/desktop lint: Done
```
`rg -i "warning|deprecat|eslintrc"` on the full captured output → **no matches** (exit 1). The previous `ESLintRCWarning: You are using an eslintrc configuration file, which is deprecated...` messages are gone.

### Rules still live
- `.ts` probe with an unused var → `@typescript-eslint/no-unused-vars` error reported.
- `.vue` probe (`<script setup lang="ts">`) with an unused var → `@typescript-eslint/no-unused-vars` error reported (proves vue parser + nested TS parser work).

### No regression
- `pnpm -r test` → all pass (editor-core, plugin-host, desktop: 19 files / 96 tests).
- `pnpm -r typecheck` → all pass (editor-core, plugin-host `tsc --noEmit`, desktop `vue-tsc -b`).
- `vue-tsc` untouched (this migration only affects ESLint).

## Commit
`37d8cb0` — see git log on branch `opt/eslint-flat`.

## Concerns
- Added `@eslint/js` and `globals` as new root devDependencies (flat-config equivalents of `eslint:recommended` and `env` globals). This is the standard migration path per the ESLint docs.
- `globals` v14 dropped the standalone `es2022` key; since ES2022 adds no globals beyond the ES2021 set (ESLint 9's own `es2022` env reuses the ES2021 globals), `globals.es2021` is equivalent.
- `vue/comment-directive` and `vue/jsx-uses-vars` (vue plugin setup rules) are scoped to `.vue` files only in flat config; they are inert on `.ts` files anyway, so no behavior change.
