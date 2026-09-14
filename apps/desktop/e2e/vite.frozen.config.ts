import { defineConfig, mergeConfig } from 'vite'
import base from '../vite.config'

/**
 * The dev server the e2e suite runs against, with file watching switched off.
 *
 * Why this exists: a Vite dev server HOT-RELOADS. A source edit landing in the
 * checkout while a run is in flight can therefore replace the page under a test,
 * and the result is indistinguishable from a product defect — the investigation
 * of the IME failures recorded exactly that, reading `received === "alpha  one"`
 * from a page a reload had just reset. No assertion can tell the two apart, so
 * the page under test has to be immune to it instead.
 *
 * A static `vite preview` build would also be immune, and is what this would be
 * if it stood alone. It cannot be used here: the specs reach into the running
 * app's own modules (`/src/features/editor/session-manager.ts`,
 * `/src/services/source-view.ts`, `/src/i18n/index.ts`, `/src/stores/tabs.ts`)
 * and into workspace sources over `/@fs/` (`e2e/support/repoFs.ts`). Those are
 * dev-server URLs, and module IDENTITY is load-bearing — a second copy of
 * `session-manager` is a different editor, which is the failure `repoFs.ts`
 * already documents. So the suite keeps the dev server and freezes it instead.
 *
 * `server.watch: null` is Vite's own switch for this: the server runs with a
 * no-op watcher, so a save can no longer send an HMR update, a full reload or
 * an optimizer restart. Everything else — including `port`/`strictPort` from
 * the base config, so a taken port still fails loudly — is unchanged.
 *
 * The cost is that the server no longer reflects edits made after it starts;
 * `playwright.config.ts` starts a fresh one per run, so a run always serves the
 * tree as of its own start, which is the property the suite actually wants.
 */
export default mergeConfig(
  base,
  defineConfig({
    server: { watch: null },
  }),
)
