import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:1420',
  },
  webServer: {
    // `e2e/vite.frozen.config.ts`, not the plain dev server: it extends the app's
    // own Vite config with `server.watch: null`, so the page under test cannot be
    // hot-reloaded out from under a run by a source edit. See that file for why
    // a static `vite preview` build is not an option here.
    command: 'pnpm dev --config e2e/vite.frozen.config.ts',
    url: 'http://localhost:1420',
    // NOT `true`. Reusing whatever already answers on 1420 means a run can be
    // served by a DIFFERENT checkout's app — another worktree, or a `tauri dev`
    // window — and then reports green (or red) for code this tree does not
    // contain. That is a false-positive merge gate, which is worse than a slow
    // one. With `false` the suite starts its own server and FAILS LOUDLY when
    // the port is taken, so the ambiguity is impossible rather than silent.
    // (Observed for real: a `tauri dev` from the main checkout held 1420 while a
    // worktree run was being prepared.)
    reuseExistingServer: false,
    timeout: 120000,
  },
})
