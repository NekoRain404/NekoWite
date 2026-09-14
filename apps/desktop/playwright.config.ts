import { defineConfig } from '@playwright/test'

/**
 * The port this run's dev server listens on.
 *
 * Chosen by `scripts/run-e2e.mjs` and handed over in the environment, because
 * `defineConfig` takes an object and not a function — the port cannot be picked
 * here. The fallback is the app's own port (`vite.config.ts`'s `server.port`,
 * which `tauri dev` depends on), so a direct `npx playwright test` behaves
 * exactly as it always has; `pnpm e2e` is the one that moves out of the app's
 * way. WITHOUT this the suite and the app compete for the same port, and the
 * loser is whichever started second — which is how a run took the port out from
 * under the user's open window.
 */
const PORT = Number(process.env.NEKOWITE_E2E_PORT ?? 1420)
const ORIGIN = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: {
    baseURL: ORIGIN,
  },
  webServer: {
    // `e2e/vite.frozen.config.ts`, not the plain dev server: it extends the app's
    // own Vite config with `server.watch: null`, so the page under test cannot be
    // hot-reloaded out from under a run by a source edit. See that file for why
    // a static `vite preview` build is not an option here.
    // The port is passed to Vite (`--port` overrides the config's `server.port`),
    // so the command and `baseURL` above cannot disagree: one value, used twice.
    command: `pnpm dev --config e2e/vite.frozen.config.ts --port ${PORT} --strictPort`,
    url: ORIGIN,
    // NOT `true`. Reusing whatever already answers on the port means a run can be
    // served by a DIFFERENT checkout's app — another worktree, or a `tauri dev`
    // window — and then reports green (or red) for code this tree does not
    // contain. That is a false-positive merge gate, which is worse than a slow
    // one. `false` keeps the intent annotated, and it costs nothing now that
    // the port is this run's own: nothing else can be listening on it.
    // (Observed for real: a `tauri dev` from the main checkout held 1420 while a
    // worktree run was being prepared.)
    reuseExistingServer: false,
    timeout: 120000,
  },
})
