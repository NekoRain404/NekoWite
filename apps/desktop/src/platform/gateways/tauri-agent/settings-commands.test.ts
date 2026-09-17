/**
 * The command names and argument spellings of the settings ports, asserted rather than assumed.
 *
 * These are the ports whose Rust commands (`agent_config_document`, `agent_config_edit`,
 * `agent_catalogue_read`, and the four `agent_skills_*`) were registered in `lib.rs` and declared in
 * `build.rs` with **no caller in `src/`** — this repository's signature failure, 建好了但够不到.
 * Wiring a page to them makes the names load-bearing, and a name is exactly the kind of thing no
 * other test here can see:
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
import { createTauriAgentSkillsCommands } from './skills'

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

describe('the skills port', () => {
  const AGENT = 'bundled-engine'
  const PROFILE = 'default'
  const SKILL = 'demo'
  const SCOPE = 'engine-global'

  it('reads with the pair the page was built for', async () => {
    await createTauriAgentSkillsCommands().read(AGENT, PROFILE)
    expect(invokeMock).toHaveBeenCalledWith('agent_skills_read', {
      agentId: AGENT,
      profileId: PROFILE,
    })
  })

  it('reads a folder with the pair and the path, and writes nothing by asking', async () => {
    await createTauriAgentSkillsCommands().preview(AGENT, PROFILE, '/home/someone/incoming/demo')
    expect(invokeMock).toHaveBeenCalledWith('agent_skills_preview', {
      agentId: AGENT,
      profileId: PROFILE,
      source: '/home/someone/incoming/demo',
    })
  })

  it('imports with the confirmation as its own argument', async () => {
    // §8.2's 「覆盖必须确认」 read at the wire: `replace` is a separate call, so the first press of
    // *Import* can never be the one that replaces something — there is no default for it to take.
    await createTauriAgentSkillsCommands().import(AGENT, PROFILE, '/home/someone/incoming/demo', false)
    expect(invokeMock).toHaveBeenLastCalledWith('agent_skills_import', {
      agentId: AGENT,
      profileId: PROFILE,
      source: '/home/someone/incoming/demo',
      replace: false,
    })
    await createTauriAgentSkillsCommands().import(AGENT, PROFILE, '/home/someone/incoming/demo', true)
    expect(invokeMock).toHaveBeenLastCalledWith('agent_skills_import', {
      agentId: AGENT,
      profileId: PROFILE,
      source: '/home/someone/incoming/demo',
      replace: true,
    })
  })

  it('switches a skill by scope and name, and never by a path', async () => {
    await createTauriAgentSkillsCommands().setEnabled(AGENT, PROFILE, SKILL, SCOPE, false)
    // The directory a row showed is deliberately *not* here: it is what the backend's move acts on,
    // and a window that could send one could move a directory out of anywhere.
    expect(invokeMock).toHaveBeenCalledWith('agent_skills_set_enabled', {
      agentId: AGENT,
      profileId: PROFILE,
      name: SKILL,
      scope: SCOPE,
      enabled: false,
    })
  })
})
