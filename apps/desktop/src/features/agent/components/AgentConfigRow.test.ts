/**
 * The composer's control row: what the session's own options draw as, and what a choice reports.
 *
 * The four things this file exists to hold down, in the order the row's job states them: the
 * controls are the *engine's* (names, values and order as they arrived, and nothing at all when
 * nothing arrived), a choice leaves as an event and never as a value this component wrote, a
 * control this build cannot move says so instead of looking usable, and the engine's own
 * `config-changed` value is what the trigger reads.
 *
 * `AgentConfigRow` takes props and emits; the harness mounts it through a reactive props object,
 * so a test can move the engine's value under a mounted row — which is the only way to see the
 * display follow a frame.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, type App as VueApp } from 'vue'
import AgentConfigRow from './AgentConfigRow.vue'
import { configControls, type AgentConfigControl } from '../services/agent-config-options'
import { t } from '../../../i18n'
import type { AgentConfigOption, AgentSession } from '../../../platform/gateways/agent-contracts'

/** The two options the pinned engine reports, measured on a real session. */
const REPORTED: AgentConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    value: {
      kind: 'select',
      current: 'opencode/big-pickle',
      choices: [
        { value: 'opencode/big-pickle', name: 'Big Pickle', description: 'The engine’s default' },
        { value: 'iapp/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      ],
    },
  },
  {
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
  },
]

/** A handle with no options of its own: every control in these tests comes from a report. */
const SESSION = { options: [], models: [], initialModelId: '' } as unknown as AgentSession

type RowProps = {
  controls: readonly AgentConfigControl[]
  busy: string | null
  failure: { key: string; message: string } | null
  onSet?: (key: string, value: string | boolean) => void
}

interface Harness {
  host: HTMLElement
  props: RowProps
  /** Every choice the row emitted, as `[key, value]`. */
  choices: Array<[string, string | boolean]>
  /** Replace the engine's report, the way a `config-changed` frame does. */
  report: (options: AgentConfigOption[]) => Promise<void>
}

let mounted: VueApp[] = []

/**
 * `where.shell` mounts the row where the app mounts it — inside `AppShell.vue`'s element, the one
 * that carries the user's appearance (the four `data-*` axes and the eight inline `--app-*`
 * properties). Left off, the row is in a page the product does not have: a page with no shell,
 * which is worth one case of its own, for the fallback, and not for the rest.
 */
function mount(
  options: AgentConfigOption[] = REPORTED,
  where: { shell?: boolean } = {},
): Harness {
  const shell = document.createElement('div')
  if (where.shell === true) {
    shell.className = 'shell'
    shell.dataset.theme = 'dark'
    shell.style.setProperty('--app-text', '#e8f3e2')
  }
  document.body.appendChild(shell)
  const host = document.createElement('div')
  shell.appendChild(host)
  const choices: Array<[string, string | boolean]> = []
  const props = reactive<RowProps>({
    controls: configControls(SESSION, options),
    busy: null,
    failure: null,
    onSet: (key: string, value: string | boolean) => choices.push([key, value]),
  })
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(AgentConfigRow, { ...props })
      },
    }),
  )
  app.mount(host)
  mounted.push(app)
  return {
    host,
    props,
    choices,
    report: async (next) => {
      props.controls = configControls(SESSION, next)
      await nextTick()
    },
  }
}

/** The whole async settle the repo's component tests use, for the popup's placement pass. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

const triggers = (host: HTMLElement): HTMLButtonElement[] =>
  [...host.querySelectorAll<HTMLButtonElement>('.agent-config-trigger')]
const optionRows = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('.agent-config-option'),
]

describe('what the row draws', () => {
  it('draws one control per option the session reported, in the engine’s order', () => {
    const { host } = mount()
    expect(triggers(host).map((trigger) => trigger.dataset.option)).toEqual(['model', 'mode'])
  })

  it('reads each trigger as the current value’s own name', () => {
    const { host } = mount()
    const labels = triggers(host).map((trigger) => trigger.textContent?.trim())
    expect(labels[0]).toContain('Big Pickle')
    expect(labels[1]).toContain('Build')
  })

  it('draws nothing at all when the session reported no options', () => {
    const { host } = mount([])
    expect(host.querySelector('.agent-config-row')).toBeNull()
  })

  it('names each control by its option and its value, for a screen reader', () => {
    const { host } = mount()
    expect(triggers(host)[1].getAttribute('aria-label')).toBe('Session Mode: Build')
  })
})

describe('opening a control', () => {
  it('lists the engine’s own values in the engine’s order', async () => {
    const { host } = mount()
    triggers(host)[0].click()
    await flush()
    expect(optionRows().map((row) => row.dataset.value)).toEqual([
      'opencode/big-pickle',
      'iapp/deepseek-v4-flash',
    ])
  })

  it('shows the engine’s description for a value that carried one', async () => {
    const { host } = mount()
    triggers(host)[0].click()
    await flush()
    const note = optionRows()[0].querySelector('.agent-config-option-note')
    expect(note?.textContent?.trim()).toBe('The engine’s default')
  })

  it('marks the value the engine says is current', async () => {
    const { host } = mount()
    triggers(host)[1].click()
    await flush()
    expect(optionRows()[0].getAttribute('aria-selected')).toBe('true')
    expect(optionRows()[1].getAttribute('aria-selected')).toBe('false')
  })

  it('filters by name, without reordering what is left', async () => {
    const { host } = mount([
      {
        id: 'model',
        name: 'Model',
        value: {
          kind: 'select',
          current: 'a',
          choices: Array.from({ length: 6 }, (_, index) => ({
            value: `m${index}`,
            name: index === 4 ? 'Special' : `Model ${index}`,
          })),
        },
      },
    ])
    triggers(host)[0].click()
    await flush()
    const filter = document.querySelector<HTMLInputElement>('.agent-config-filter')
    expect(filter).not.toBeNull()
    filter!.value = 'spec'
    filter!.dispatchEvent(new Event('input'))
    await nextTick()
    expect(optionRows().map((row) => row.dataset.value)).toEqual(['m4'])
  })

  it('offers no filter for a short list', async () => {
    const { host } = mount()
    triggers(host)[0].click()
    await flush()
    expect(document.querySelector('.agent-config-filter')).toBeNull()
  })

  it('reports the chosen value and closes', async () => {
    const harness = mount()
    triggers(harness.host)[1].click()
    await flush()
    optionRows()[1].click()
    await nextTick()
    expect(harness.choices).toEqual([['mode', 'plan']])
    // Closed, asserted on the state the component owns: the popup element itself leaves on the
    // leave transition, which a test environment never runs (`components/SelectMenu.test.ts`
    // asserts the same way, and for the same reason).
    expect(triggers(harness.host)[1].getAttribute('aria-expanded')).toBe('false')
  })
})

describe('a control this build cannot move', () => {
  it('is drawn unusable, and says why', () => {
    const { host } = mount([
      { id: 'thinking', name: 'Thinking Effort', value: { kind: 'toggle', current: true } },
    ])
    const toggle = host.querySelector<HTMLButtonElement>('.agent-config-toggle')!
    expect(toggle.disabled).toBe(true)
    expect(toggle.getAttribute('title')).toContain(t('agent.panel.composer.config.unavailable'))
  })

  it('is drawn all the same: the session reported it', () => {
    const { host } = mount([
      { id: 'thinking', name: 'Thinking Effort', value: { kind: 'toggle', current: true } },
    ])
    expect(host.querySelector('.agent-config-toggle')).not.toBeNull()
  })
})

describe('a boolean option', () => {
  it('draws the option’s own name and the engine’s own whether-or-not', () => {
    const harness = mount([
      { id: 'thinking', name: 'Thinking Effort', value: { kind: 'toggle', current: false } },
    ])
    const toggle = harness.host.querySelector<HTMLButtonElement>('.agent-config-toggle')!
    expect(toggle.textContent?.trim()).toBe('Thinking Effort')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.getAttribute('role')).toBe('switch')
  })

  it('cannot be flipped, because the transport has no shape for a boolean', async () => {
    // The boundary the service documents: a select's value travels as a value id and a boolean
    // has none. So the switch is drawn — the session reported the option — and drawn plainly
    // unusable, rather than accepting a press that nothing would carry.
    const harness = mount([
      { id: 'thinking', name: 'Thinking Effort', value: { kind: 'toggle', current: false } },
    ])
    const toggle = harness.host.querySelector<HTMLButtonElement>('.agent-config-toggle')!
    expect(toggle.disabled).toBe(true)
    toggle.click()
    await nextTick()
    expect(harness.choices).toEqual([])
  })
})

describe('a set in flight and a set that failed', () => {
  it('takes no second press while its value is being set', async () => {
    const harness = mount()
    harness.props.busy = 'model'
    await nextTick()
    expect(triggers(harness.host)[0].disabled).toBe(true)
    // …and only the control that is mid-call: the other one still works.
    expect(triggers(harness.host)[1].disabled).toBe(false)
  })

  it('marks the control and announces the reason, keeping the engine’s value', async () => {
    const harness = mount()
    harness.props.failure = { key: 'mode', message: 'the engine said no' }
    await nextTick()
    expect(triggers(harness.host)[1].dataset.failed).toBe('true')
    expect(triggers(harness.host)[0].dataset.failed).toBeUndefined()
    const status = harness.host.querySelector('.agent-config-status')
    expect(status?.getAttribute('role')).toBe('status')
    expect(status?.textContent).toContain('the engine said no')
    // The value on screen is still the engine's: a set that did not take leaves it in force.
    expect(triggers(harness.host)[1].textContent).toContain('Build')
  })
})

describe('a frame that changes the engine’s own value', () => {
  it('moves the trigger’s reading to the value the engine reported', async () => {
    const harness = mount()
    await harness.report([
      { ...REPORTED[0], value: { kind: 'select', current: 'iapp/deepseek-v4-flash', choices: [{ value: 'iapp/deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] } },
      REPORTED[1],
    ])
    expect(triggers(harness.host)[0].textContent).toContain('DeepSeek V4 Flash')
  })

  it('gains a control for an option the engine reported for the first time', async () => {
    const harness = mount([REPORTED[0]])
    expect(triggers(harness.host)).toHaveLength(1)
    await harness.report(REPORTED)
    expect(triggers(harness.host)).toHaveLength(2)
  })

  it('drops a control the engine stopped reporting', async () => {
    const harness = mount()
    await harness.report([REPORTED[1]])
    expect(triggers(harness.host).map((trigger) => trigger.dataset.option)).toEqual(['mode'])
  })
})

/** The list's host, which is the picker's half of the defect and not the row's: `AgentConfigRow`
 *  only draws the control, and `AgentConfigPicker` decides where the list it opens is rendered. */
describe('where the list is rendered', () => {
  const popup = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('.agent-config-popup')

  it('renders it inside the element that carries the appearance', async () => {
    const { host } = mount(REPORTED, { shell: true })
    triggers(host)[0].click()
    await flush()

    // The list is teleported — it has to be, so that no ancestor can become the containing block
    // of a `position: fixed` box and answer its coordinates from somewhere else — but *where* it
    // is teleported to is the whole of this case. `.shell` is `AppShell.vue`'s element and the
    // only place `data-theme` and the inline `--app-*` properties live; `body` is outside it, so a
    // list left there resolves `palettes.css`'s `:root` block and draws the light palette in a
    // dark theme (measured for every select in the app by `780ec5c`).
    const shell = document.body.querySelector('.shell')
    expect(shell).not.toBeNull()
    expect(popup()?.parentElement).toBe(shell)
    expect(popup()?.parentElement).not.toBe(document.body)
  })

  it('falls back to the body on a page that has no shell', async () => {
    // The pet window's page is the shape: it publishes the appearance on the document element
    // (`pet-page-appearance.ts`), so everything under `body` there is inside the scope — and a
    // `Teleport` aimed at a selector that matched nothing would render *nothing* rather than an
    // unthemed list. This is the case that says the fallback is deliberate.
    const { host } = mount()
    triggers(host)[0].click()
    await flush()
    expect(popup()?.parentElement).toBe(document.body)
  })
})
