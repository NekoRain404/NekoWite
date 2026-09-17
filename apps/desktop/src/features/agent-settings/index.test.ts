/**
 * N11: the agents tree's registry, held to the rule it already states for everything else.
 *
 * `features/agent-settings/index.ts` had two fields on each entry beyond the id —
 * `needsRuntime` and `mounts` — and neither was read by anything. `needsRuntime` was the one the
 * audit recorded, and it was worse than an unused field: it was a *claim* ("whether the section
 * can do anything at all when the runtime is not running") whose answer is written in the opposite
 * direction by the pages themselves. The permission page, which the flag marked `true`, draws the
 * backend's own "no engine is running" sentence rather than a gap
 * (`AgentPermissionGrants.vue`: `notRunning`, asserted at `SettingsPanel.agents.test.ts:442`), and
 * `skills` is `false` for the same reason in the opposite direction — the section's own note says
 * a navigation that hid it while the rail was off "would be hiding the page in the state it is
 * built for". The navigation both fields were furniture for does not exist and, by that note,
 * must not.
 *
 * So the fields went, and this is the line that keeps them gone. It is a shape assertion on
 * purpose: the defect it guards is a field that *nothing* fails on, and a test that reads a
 * behaviour cannot see a thing that has no behaviour. A field added here fails this, and the fix
 * is to say which reader wants it — which is the review §13.11's own rule asks for ("a name is
 * exported when a second real caller exists, rather than in case one appears") applied to a
 * field.
 */
import { describe, expect, it } from 'vitest'
import { AGENT_SETTINGS_SECTIONS } from './index'

describe('the agent settings registry', () => {
  it('declares each section as its id and nothing else', () => {
    for (const section of AGENT_SETTINGS_SECTIONS) {
      // `id` is what a navigation binds and what the section's own list of mounted pages is
      // keyed by (`AgentSettingsSection.vue`'s `MOUNTED`), which is a reader that exists.
      expect(Object.keys(section)).toEqual(['id'])
    }
  })

  it('names each section once', () => {
    const ids = AGENT_SETTINGS_SECTIONS.map((section) => section.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
