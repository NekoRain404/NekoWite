/**
 * The command names and argument spellings of the two settings ports, asserted rather than assumed.
 *
 * These two ports are the ones whose Rust commands (`agent_config_document`, `agent_config_edit`,
 * `agent_catalogue_read`) were registered in `lib.rs` and declared in `build.rs` with **no caller in
 * `src/`** — this repository's signature failure, 建好了但够不到. Wiring a page to them makes the
 * names load-bearing, and a name is exactly the kind of thing no other test here can see:
 *
 *  - The agents page's own test mocks `invoke`, so a typo'd command name answers from the mock and
 *    the page renders as though the backend had spoken. The failure that hides is a real one — at
 *    runtime Tauri rejects an undeclared command, and the page draws its unreadable state.
 *  - The argument keys are the camelCase spelling of the Rust parameters. Tauri rejects a key in the
 *    wrong case, and a rejection reads exactly like the command not existing — which is why
 *    `registry.ts`'s own doc calls that out.
 *
 * So this file drives the real ports with a mocked `invoke` and reads back the call. It is the one
 * place where "the window asked for the right thing" is a fact about the source rather than about a
 * page's state.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => vi.fn(async () => null))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

import { createTauriAgentConfigCommands } from './config'
import { createTauriAgentCatalogueCommands } from './catalogue'

beforeEach(() => {
  invokeMock.mockClear()
})

describe('the configuration document port', () => {
  const RELATIVE = 'XDG_CONFIG_HOME/opencode/opencode.json'
  const REVISION = 'a'.repeat(64)

  it('reads with the pair and the path the profile readout named', async () => {
    await createTauriAgentConfigCommands().read('bundled-engine', 'default', RELATIVE)
    expect(invokeMock).toHaveBeenCalledWith('agent_config_document', {
      agentId: 'bundled-engine',
      profileId: 'default',
      relative: RELATIVE,
    })
  })

  it('edits with the revision and the member list, spelled the way the command takes them', async () => {
    const edits = [{ path: ['permission'], value: { edit: 'ask' } }]
    await createTauriAgentConfigCommands().edit({
      agentId: 'bundled-engine',
      profileId: 'default',
      relative: RELATIVE,
      revision: REVISION,
      edits,
    })
    expect(invokeMock).toHaveBeenCalledWith('agent_config_edit', {
      agentId: 'bundled-engine',
      profileId: 'default',
      relative: RELATIVE,
      revision: REVISION,
      edits,
    })
  })
})

describe('the catalogue port', () => {
  it('reads the catalogue with no arguments at all', async () => {
    await createTauriAgentCatalogueCommands().readCatalogue()
    // One argument, and it is nothing: the cache's location is the host's, resolved from the
    // `AppHandle` rather than from anything a window sends. A key here would be a window naming a
    // path on the host.
    expect(invokeMock).toHaveBeenCalledWith('agent_catalogue_read')
  })
})
