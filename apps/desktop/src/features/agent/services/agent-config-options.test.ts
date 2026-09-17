/**
 * The control row's data path: what a session's options reduce to, and where a choice goes.
 *
 * The two halves this file holds apart are the two the module does: which report a control came
 * from — the session's opening answer or the engine's later `config-changed` frame — and which
 * call a choice travels on. Neither is a rendering question, which is why the tests are here
 * rather than on the component.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MEMORY_MODE_OPTION,
  MEMORY_MODEL_ID,
  MEMORY_OPTIONS,
  createMemoryAgentGateway,
  type MemoryAgentGateway,
} from '../../../platform/gateways/memory-agent'
import type {
  AgentConfigOption,
  AgentGateway,
  AgentSession,
} from '../../../platform/gateways/agent-contracts'
import {
  AGENT_CONFIG_FILTER_THRESHOLD,
  configControls,
  setConfigOption,
} from './agent-config-options'

let gateway: MemoryAgentGateway
let session: AgentSession

beforeEach(async () => {
  gateway = createMemoryAgentGateway({ agentId: 'memory', profileId: 'test' })
  await gateway.start()
  session = await gateway.openSession({ vaultId: 'vault', cwd: '/vault' })
})

/** What the pinned engine reports, as a `config-changed` payload — measured against a real
 *  session (`agent_session_lifecycle_test.rs`'s probe): a model selector with a large catalog
 *  and a session mode of two values, in that order. */
function engineReportedOptions(): AgentConfigOption[] {
  return [
    {
      id: 'model',
      name: 'Model',
      value: {
        kind: 'select',
        current: 'opencode/big-pickle',
        choices: [
          { value: 'opencode/big-pickle', name: 'Big Pickle' },
          { value: 'iapp/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        ],
      },
    },
    MEDIA_MODE,
  ]
}

/** The mode option the pinned engine reports, under the names it reports them with. */
const MEDIA_MODE: AgentConfigOption = {
  id: 'mode',
  name: 'Session Mode',
  value: {
    kind: 'select',
    current: 'build',
    choices: [
      { value: 'build', name: 'Build' },
      { value: 'plan', name: 'Plan' },
    ],
  },
}

describe('what the row draws', () => {
  it('draws the options the session opened with, in the engine’s order', () => {
    const controls = configControls(session, [])
    expect(controls.map((control) => control.key)).toEqual(
      MEMORY_OPTIONS.map((option) => option.id),
    )
    // The engine's own names, not this app's: the handle carries what `session/new` answered.
    expect(controls.map((control) => control.name)).toEqual(['Model', 'Session Mode'])
  })

  it('names the current value with the engine’s own word for it', () => {
    const [, mode] = configControls(session, [])
    expect(mode.kind === 'select' ? mode.currentName : null).toBe('Build')
  })

  it('shows a value the engine named no choice for as the value itself', () => {
    const [control] = configControls(session, [
      {
        id: 'mode',
        name: 'Session Mode',
        value: { kind: 'select', current: 'unlisted', choices: [{ value: 'build', name: 'Build' }] },
      },
    ])
    expect(control.kind === 'select' ? control.currentName : null).toBe('unlisted')
  })

  it('draws the engine’s later frame instead of the list the session opened with', () => {
    const controls = configControls(session, engineReportedOptions())
    expect(controls.map((control) => control.key)).toEqual(['model', 'mode'])
    // The frame's current value, not the seed: the engine's latest word is the one shown.
    expect(controls[0].kind === 'select' ? controls[0].current : null).toBe('opencode/big-pickle')
    expect(controls[1].kind === 'select' ? controls[1].current : null).toBe('build')
  })

  it('draws an engine option this build never saw before, with no per-option code', () => {
    const controls = configControls(session, [
      ...engineReportedOptions(),
      { id: 'thinking', name: 'Thinking Effort', value: { kind: 'toggle', current: true } },
    ])
    expect(controls.map((control) => control.name)).toEqual([
      'Model',
      'Session Mode',
      'Thinking Effort',
    ])
  })

  it('draws a boolean option as a switch that this build cannot move', () => {
    const [control] = configControls(session, [
      { id: 'thinking', name: 'Thinking Effort', value: { kind: 'toggle', current: true } },
    ])
    expect(control.kind).toBe('toggle')
    expect(control.movable).toBe(false)
    expect(control.kind === 'toggle' ? control.current : null).toBe(true)
  })

  it('offers a filter only once the choice list is long enough to need one', () => {
    const choices = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ value: `v${index}`, name: `Value ${index}` }))
    const [short] = configControls(session, [
      { id: 'mode', name: 'Session Mode', value: { kind: 'select', current: 'v0', choices: choices(AGENT_CONFIG_FILTER_THRESHOLD - 1) } },
    ])
    const [long] = configControls(session, [
      { id: 'mode', name: 'Session Mode', value: { kind: 'select', current: 'v0', choices: choices(AGENT_CONFIG_FILTER_THRESHOLD) } },
    ])
    expect(short.kind === 'select' ? short.filterable : null).toBe(false)
    expect(long.kind === 'select' ? long.filterable : null).toBe(true)
  })

  it('draws nothing at all when the session reports no options', () => {
    const bare = { ...session, options: [] } as AgentSession
    expect(configControls(bare, [])).toEqual([])
  })
})

describe('where a choice goes', () => {
  it('moves an option through the general call, by the engine’s own id', async () => {
    const calls: Array<[string, string]> = []
    const spy = {
      ...gateway,
      setConfigOption: async (_session: AgentSession, configId: string, value: string) => {
        calls.push([configId, value])
      },
    } as AgentGateway
    const controls = configControls(session, engineReportedOptions())
    expect(await setConfigOption(spy, session, controls[1], 'plan')).toEqual({ accepted: true })
    expect(calls).toEqual([['mode', 'plan']])
  })

  it('addresses the model option like any other — one path, no per-option branch', async () => {
    const calls: Array<[string, string]> = []
    const spy = {
      ...gateway,
      setConfigOption: async (_session: AgentSession, configId: string, value: string) => {
        calls.push([configId, value])
      },
    } as AgentGateway
    const [model] = configControls(session, engineReportedOptions())
    expect(await setConfigOption(spy, session, model, 'iapp/deepseek-v4-flash')).toEqual({
      accepted: true,
    })
    expect(calls).toEqual([['model', 'iapp/deepseek-v4-flash']])
  })

  it('refuses a boolean rather than sending it as a value id', async () => {
    const calls: string[] = []
    const spy = {
      ...gateway,
      setConfigOption: async () => {
        calls.push('set')
      },
    } as unknown as AgentGateway
    const [control] = configControls(session, [
      { id: 'thinking', name: 'Thinking Effort', value: { kind: 'toggle', current: true } },
    ])
    expect(await setConfigOption(spy, session, control, false)).toEqual({
      accepted: false,
      reason: 'not-movable',
    })
    expect(calls).toEqual([])
  })

  it('reports a refusal with the host’s own code and its sentence', async () => {
    const spy = {
      ...gateway,
      setConfigOption: async () => {
        throw new Error('the engine said no')
      },
    } as unknown as AgentGateway
    const controls = configControls(session, engineReportedOptions())
    expect(await setConfigOption(spy, session, controls[1], 'plan')).toMatchObject({
      accepted: false,
      reason: 'refused',
      code: 'invalid-response',
    })
  })
})

describe('the frame an engine sends back', () => {
  it('publishes the moved option list, which is what the row follows', async () => {
    // The double announces a change the way the pinned engine does — `config_option_update` after
    // `session/set_config_option` — so the path this test walks is the path the product walks:
    // the call moves the option, the frame carries the new list, and the view reduces it into
    // `config`, which the row draws in preference to the session's opening answer.
    const controls = configControls(session, engineReportedOptions())
    expect(await setConfigOption(gateway, session, controls[1], 'plan')).toEqual({ accepted: true })
    const snapshot = await gateway.snapshot(session)
    const frame = snapshot.events.filter((event) => event.kind === 'config-changed').at(-1)
    const options = frame?.kind === 'config-changed' ? frame.payload.options : []
    expect(options.map((option) => option.id)).toEqual(['model', 'mode'])
    expect(options[1].value).toEqual({
      kind: 'select',
      current: 'plan',
      choices: [
        { value: 'build', name: 'Build' },
        { value: 'plan', name: 'Plan' },
      ],
    })
  })

  it('moves the model option through the same call a model switch uses', async () => {
    // `selectModel` is the model's narrower spelling of one protocol call; both end in the same
    // frame, which is what keeps a model switch and a mode switch one path in the view.
    await gateway.selectModel(session, session.models[1].id)
    const snapshot = await gateway.snapshot(session)
    const frame = snapshot.events.filter((event) => event.kind === 'config-changed').at(-1)
    const options = frame?.kind === 'config-changed' ? frame.payload.options : []
    expect(options[0]).toMatchObject({
      id: MEMORY_MODEL_ID,
      value: { kind: 'select', current: session.models[1].id },
    })
  })
})

/** The double's own `mode` option, exported so the parity above is held to the fixture rather
 *  than to a copy of it. */
expect(MEMORY_MODE_OPTION.id).toBe(MEDIA_MODE.id)
