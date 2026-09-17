/**
 * The catalogue IPC: one read, and the reason it takes nothing.
 *
 * This is the window's half of `R/src/commands/agent_catalogue.rs`'s `agent_catalogue_read`. The
 * command answers from the cache when it is fresh and fetches when it is not, so it has no
 * arguments — the cache's location is the app's own data directory, which the host resolves from
 * the `AppHandle` rather than from anything a window sends. A key here would be a window naming a
 * path on the host, which is the shape this adapter has no business offering.
 *
 * ## Why the answer is `unknown` like every other port here
 *
 * `platform` may not import from `features` (plan §6.1), so the shape of a readout is the feature's
 * vocabulary and lives in `features/agent-settings/services/agent-catalogue-{policy,ipc}.ts`. This
 * file passes the answer through, and the composition site is where a drift between the two sides
 * becomes a compile error.
 *
 * ## What it can answer
 *
 * The command answers `Ok` on **every** path, including "the registry could not be reached" — that
 * is a `freshness` arm with a note, not a rejection, because a page has to draw something and an
 * error it can only render as a blank section is worse than a stale list. So a rejection from this
 * port means the invoke itself did not complete: no handler, no window permission, or the host was
 * shut down mid-call. The page's unreadable state with a retry is the answer to that.
 */

import { invoke } from '@tauri-apps/api/core'

/** The one call, as the backend answers it. */
export interface AgentCatalogueCommands {
  readCatalogue(): Promise<unknown>
}

/**
 * The port implemented by the running app.
 *
 * A port rather than a free function, for the reason `AgentRegistryCommands` is one: a test can
 * drive the client without a window, and the composition site chooses which implementation a build
 * gets.
 */
export function createTauriAgentCatalogueCommands(): AgentCatalogueCommands {
  return {
    readCatalogue: () => invoke('agent_catalogue_read'),
  }
}
