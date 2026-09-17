/**
 * T7: the permission prompt — the one dialog a user must be able to trust.
 *
 * The three things this file exists to hold down, in the order the task states them:
 * the options are the *request's*, a prompt that is over cannot be answered, and every
 * button is reachable from the keyboard. The first two are the ones a passing exit code
 * will not tell you about on its own, so each is asserted against the DOM the component
 * actually produced rather than against a state it reports.
 *
 * `AgentPermissionPrompt` takes props and emits events; the harness below mounts it the
 * way the panel will, through a reactive props object, so a test can move a status or
 * expire a request under a mounted component — which is the only way to see a live
 * prompt die.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, type App as VueApp } from 'vue'
import AgentPermissionPrompt from './AgentPermissionPrompt.vue'
import { getLocale, setLocale, t } from '../../../i18n'
import type {
  AgentPermissionOption,
  AgentPermissionRequest,
  AgentToolStatus,
} from '../../../platform/gateways/agent-contracts'

/**
 * The options from the frame P0 §7.1 measured on our pinned engine, as the contract
 * spells them: `kind` is the engine's own four values, so the frame's two allows are
 * `allow_once` / `allow_always` and its plain Reject is `reject_once`. The engine's own
 * ids and labels are what the UI renders and what it answers with.
 */
const MEASURED: readonly AgentPermissionOption[] = [
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
]

function request(overrides: Partial<AgentPermissionRequest> = {}): AgentPermissionRequest {
  return {
    requestId: 'req-1',
    // The contract carries it as required (`toolCallId: string`) and the reader refuses a
    // request without one, which is also what lets the panel join a prompt to its row.
    toolCallId: 'call-1',
    title: '/vault/probe-output.txt',
    input: { state: 'text', json: '{"filepath":"/vault/probe-output.txt"}' },
    options: MEASURED.map((option) => ({ ...option })),
    ...overrides,
  }
}

/**
 * The props the panel drives, named rather than left a loose record: the object is spread
 * into the component inside the render function, so `Record<string, unknown>` reaches `h()`
 * as exactly that — which is not the props the prompt declares. The two handlers are the
 * emits the harness counts, in the shape `h()` takes them.
 */
type PromptProps = {
  request: AgentPermissionRequest
  toolStatus?: AgentToolStatus | null
  expired?: boolean
  onAnswer?: (requestId: string, optionId: string) => void
  onCancel?: () => void
}

interface Harness {
  host: HTMLElement
  props: PromptProps
  /** Every answer the component emitted, as `[requestId, optionId]`. */
  answers: Array<[string, string]>
  /** How many times it asked for the turn to be stopped. */
  cancels: number[]
  /** The props object the panel will be driving: `request`, `toolStatus`, `expired`. */
  set: (patch: Partial<PromptProps>) => Promise<void>
}

let mounted: VueApp[] = []

function mount(initial: Partial<PromptProps> = {}): Harness {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const answers: Array<[string, string]> = []
  const cancels: number[] = []
  const props = reactive<PromptProps>({
    request: request(),
    ...initial,
    onAnswer: (requestId: string, optionId: string) => answers.push([requestId, optionId]),
    onCancel: () => cancels.push(cancels.length + 1),
  })
  const app = createApp(
    defineComponent({
      setup() {
        // Spread inside the render function: that read is what subscribes the render
        // effect to the reactive object, so `set` below re-renders the prompt.
        return () => h(AgentPermissionPrompt, { ...props })
      },
    }),
  )
  app.mount(host)
  mounted.push(app)
  return {
    host,
    props,
    answers,
    cancels,
    set: async (patch) => {
      Object.assign(props, patch)
      await nextTick()
    },
  }
}

/** The whole async settle the repo's dialog tests use, for the focus `nextTick`. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
})

const prompt = (host: HTMLElement): HTMLElement => host.querySelector<HTMLElement>('.agent-perm')!
const answerButtons = (host: HTMLElement): HTMLButtonElement[] =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('.agent-perm-options button'))
const optionTexts = (host: HTMLElement): string[] =>
  Array.from(host.querySelectorAll<HTMLElement>('.agent-perm-option')).map(
    (el) => el.textContent?.trim() ?? '',
  )
const cancelButton = (host: HTMLElement): HTMLButtonElement =>
  host.querySelector<HTMLButtonElement>('[data-action="cancel-run"]')!
const click = (el: Element): void => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('AgentPermissionPrompt — the options are the request’s own', () => {
  it('renders the engine’s options in the engine’s order', () => {
    const { host } = mount()
    expect(answerButtons(host).map((el) => el.textContent?.trim())).toEqual([
      'Allow once',
      'Always allow',
      'Reject',
    ])
    expect(answerButtons(host).map((el) => el.dataset.optionId)).toEqual([
      'once',
      'always',
      'reject',
    ])
  })

  it('draws the engine’s refusals apart from its allows, in all four kinds', () => {
    // `kind` is the engine's own four values, so a refusal is `reject_once` or
    // `reject_always`, and a comparison against a collapsed `reject` matches nothing: the
    // class is the only thing this row changes about a refusal, so the comparison being
    // impossible is a refusal drawn exactly like an allow.
    const { host } = mount({
      request: request({
        options: [
          { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          { optionId: 'never', name: 'Always reject', kind: 'reject_always' },
        ],
      }),
    })
    expect(answerButtons(host).map((el) => el.className)).toEqual([
      'btn btn-secondary',
      'btn btn-secondary',
      'btn btn-ghost',
      'btn btn-ghost',
    ])
  })

  it('offers no option the request did not carry', () => {
    // The engine offers `allow_always` in the frame we measured — which is why a button
    // for it is legitimate *there* and illegitimate here. A hardcoded three-button row
    // would show "Always allow" to this request, which never offered one.
    const { host } = mount({
      request: request({
        options: [
          { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      }),
    })
    expect(answerButtons(host).map((el) => el.textContent?.trim())).toEqual([
      'Allow once',
      'Reject',
    ])
    expect(host.textContent).not.toContain('Always allow')
  })

  it('renders a request that offers nothing as a prompt with nothing to answer', () => {
    // Not a defect: the engine is the one that decides what it will accept as an answer,
    // and the only answer left is stopping the turn.
    const { host, answers } = mount({ request: request({ options: [] }) })
    expect(answerButtons(host)).toHaveLength(0)
    expect(optionTexts(host)).toHaveLength(0)
    click(cancelButton(host))
    expect(answers).toEqual([])
  })

  it('answers with the engine’s option id, under the request it came from', async () => {
    const { host, answers } = mount()
    click(answerButtons(host)[1])
    await nextTick()
    expect(answers).toEqual([['req-1', 'always']])
  })
})

describe('AgentPermissionPrompt — a repeated click is not a second answer', () => {
  it('emits once for two clicks in the same tick, then leaves nothing to click', async () => {
    const { host, answers } = mount()
    const button = answerButtons(host)[0]
    // Both clicks land before Vue has re-rendered, so the second one reaches the same
    // listener the first one did (§6.3: 重复点击幂等).
    click(button)
    click(button)
    expect(answers).toEqual([['req-1', 'once']])

    await nextTick()
    expect(answerButtons(host)).toHaveLength(0)
    expect(optionTexts(host)).toEqual(['Allow once', 'Always allow', 'Reject'])
  })

  it('emits nothing for a click that arrives on the button it stopped rendering', async () => {
    // The element is detached but keeps the listener it was given, so the guard has to
    // be the phase and not the DOM.
    const { host, answers } = mount()
    const button = answerButtons(host)[0]
    click(button)
    await nextTick()
    expect(host.contains(button)).toBe(false)
    click(button)
    expect(answers).toEqual([['req-1', 'once']])
  })

  it('treats a different request in the same instance as a new question', async () => {
    const harness = mount()
    click(answerButtons(harness.host)[0])
    await nextTick()
    expect(harness.answers).toHaveLength(1)

    await harness.set({ request: request({ requestId: 'req-2', title: '/vault/other.txt' }) })
    expect(prompt(harness.host).dataset.phase).toBe('open')
    click(answerButtons(harness.host)[2])
    expect(harness.answers).toEqual([
      ['req-1', 'once'],
      ['req-2', 'reject'],
    ])
  })
})

describe('AgentPermissionPrompt — a dead prompt is structurally inert', () => {
  it('renders an expired request with no buttons and answers nothing', () => {
    const { host, answers, cancels } = mount({
      request: request({ input: { state: 'absent' } }),
      expired: true,
    })
    expect(prompt(host).dataset.phase).toBe('dead')
    // Not "disabled": absent. A greyed-out button is still a button, and a stale answer
    // in that shape is exactly what §10.2 「过期响应拒绝」 exists for.
    expect(host.querySelectorAll('button, a[href], input, select, textarea')).toHaveLength(0)
    // This one has no arguments to read, so nothing inside it is focusable at all.
    // (With arguments, the read-only block they scroll in is the one tab stop left —
    // see the test that expires a live prompt.)
    expect(host.querySelectorAll('[tabindex]:not([tabindex="-1"])')).toHaveLength(0)
    // What was offered is still on screen — as a record, not as a choice.
    expect(optionTexts(host)).toEqual(['Allow once', 'Always allow', 'Reject'])

    click(prompt(host))
    host.querySelectorAll('.agent-perm-option').forEach(click)
    expect(answers).toEqual([])
    expect(cancels).toEqual([])
  })

  it('goes inert when a live prompt is expired under it, and stays inert', async () => {
    const harness = mount()
    const button = answerButtons(harness.host)[1]
    expect(button).toBeTruthy()

    await harness.set({ expired: true })
    expect(prompt(harness.host).dataset.phase).toBe('dead')
    expect(harness.host.querySelectorAll('button')).toHaveLength(0)
    // What stays focusable is the arguments block and nothing else: it is read-only and
    // scrolls, so a keyboard user can still read what the request was about, while
    // nothing in the prompt can answer for them.
    const tabStops = Array.from(
      harness.host.querySelectorAll<HTMLElement>('[tabindex]:not([tabindex="-1"])'),
    )
    expect(tabStops.map((el) => el.className)).toEqual(['agent-perm-args'])

    // The button the user could have pressed a tick ago, pressed now.
    click(button)
    click(prompt(harness.host))
    expect(harness.answers).toEqual([])
    expect(harness.cancels).toEqual([])
  })

  it('keeps a prompt answerable across a status change that is not an ending', async () => {
    // A tool call moving `pending -> in_progress` while the user is still reading is not
    // an ending, and an ecosystem survey found a client that dropped its prompt on
    // exactly that transition. Only a settled status ends it.
    const harness = mount({ toolStatus: 'pending' })
    expect(prompt(harness.host).dataset.phase).toBe('open')

    await harness.set({ toolStatus: 'in_progress' })
    expect(prompt(harness.host).dataset.phase).toBe('open')
    expect(answerButtons(harness.host)).toHaveLength(3)
    click(answerButtons(harness.host)[0])
    expect(harness.answers).toEqual([['req-1', 'once']])
  })

  it('treats only a settled tool status as an ending', () => {
    const settled: AgentToolStatus[] = ['completed', 'failed', 'cancelled']
    for (const toolStatus of settled) {
      const { host } = mount({ toolStatus })
      expect(prompt(host).dataset.phase, toolStatus).toBe('dead')
      expect(host.querySelectorAll('button'), toolStatus).toHaveLength(0)
      mounted.forEach((app) => app.unmount())
      mounted = []
      document.body.innerHTML = ''
    }
    // Unknown is not ended: the request carries no tool call id, so a panel that cannot
    // join it to its tool row passes nothing — and that must not kill the prompt.
    const { host } = mount({ toolStatus: null })
    expect(prompt(host).dataset.phase).toBe('open')
  })
})

describe('AgentPermissionPrompt — cancelling the run is not a denial', () => {
  it('emits cancel, which carries no option id', () => {
    const { host, answers, cancels } = mount()
    click(cancelButton(host))
    expect(cancels).toEqual([1])
    // A refusal is `selected` with a `reject_*` id; a cancelled turn is answered
    // `cancelled` by the host (§6.2). Conflating them would tell the engine the user
    // refused an action they never ruled on.
    expect(answers).toEqual([])
  })

  it('goes inert once the cancelled run has ended, and stops offering the stop', async () => {
    const harness = mount()
    click(cancelButton(harness.host))
    // The host is the one that knows the turn ended; until it says so the prompt stays
    // as it was, because a cancel that failed must not strand the user with a dead
    // prompt and no way back.
    expect(prompt(harness.host).dataset.phase).toBe('open')

    await harness.set({ expired: true })
    expect(prompt(harness.host).dataset.phase).toBe('dead')
    expect(harness.host.querySelectorAll('button')).toHaveLength(0)
    expect(harness.cancels).toEqual([1])
  })

  it('cannot be cancelled from a dead prompt', async () => {
    const harness = mount()
    await harness.set({ toolStatus: 'failed' })
    click(prompt(harness.host))
    expect(harness.cancels).toEqual([])
    expect(harness.answers).toEqual([])
  })
})

describe('AgentPermissionPrompt — keyboard', () => {
  it('takes focus on arrival, on the prompt rather than on an answer', async () => {
    // Focus on "Allow once" would let one Enter — often the tail of what the user was
    // typing when the prompt appeared — answer a permission nobody has read.
    const { host } = mount()
    await nextTick()
    await flush()
    expect(document.activeElement).toBe(prompt(host))
    expect(document.activeElement).not.toBe(answerButtons(host)[0])
  })

  it('answers from the keyboard, through native buttons', () => {
    const { host } = mount()
    for (const button of answerButtons(host)) {
      expect(button.tagName).toBe('BUTTON')
      expect(button.getAttribute('type')).toBe('button')
    }
  })

  it('treats Escape as the dismissive control, and never as an answer', async () => {
    const { host, answers, cancels } = mount()
    answerButtons(host)[0].dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    expect(cancels).toEqual([1])
    expect(answers).toEqual([])
  })

  it('does not cancel on Escape once the prompt is dead', async () => {
    const harness = mount()
    await harness.set({ expired: true })
    prompt(harness.host).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    expect(harness.cancels).toEqual([])
  })
})

describe('AgentPermissionPrompt — what the user is approving', () => {
  it('shows the engine’s own sentence for the call, and pretty-prints the arguments', () => {
    const { host } = mount({
      request: request({ input: { state: 'text', json: '{"filepath":"/vault/a.md"}' } }),
    })
    expect(host.querySelector('.agent-perm-title')?.textContent).toBe('/vault/probe-output.txt')
    expect(host.querySelector('.agent-perm-args')?.textContent).toBe(
      '{\n  "filepath": "/vault/a.md"\n}',
    )
  })

  it('shows unparseable arguments as they arrived rather than as a parser message', () => {
    const { host } = mount({ request: request({ input: { state: 'text', json: 'not json' } }) })
    expect(host.querySelector('.agent-perm-args')?.textContent).toBe('not json')
  })

  it('marks “no arguments yet” and “arguments this host could not read” apart', () => {
    // They arrive identically on the wire (ACP deserializes `rawInput` default-on-error),
    // and §6.3 makes this the surface where the user judges what they are approving.
    const absent = mount({ request: request({ input: { state: 'absent' } }) })
    const unreadable = mount({ request: request({ input: { state: 'unreadable' } }) })
    expect(prompt(absent.host).dataset.inputState).toBe('absent')
    expect(prompt(unreadable.host).dataset.inputState).toBe('unreadable')
    expect(absent.host.querySelector('.agent-perm-args')).toBeNull()
    expect(unreadable.host.querySelector('.agent-perm-args')).toBeNull()
    expect(absent.host.querySelector('.agent-perm-args-none')).toBeTruthy()
    expect(unreadable.host.querySelector('.agent-perm-args-none')).toBeTruthy()
  })

  it('gains the arguments when a later update fills them in', async () => {
    // The engine may ask before it has the arguments to show (the plan's rule: render
    // from what you have and re-render when a later update fills them in) — or the user
    // consents blind.
    const harness = mount({ request: request({ input: { state: 'absent' } }) })
    expect(harness.host.querySelector('.agent-perm-args')).toBeNull()

    await harness.set({
      request: request({ input: { state: 'text', json: '{"filepath":"/vault/a.md"}' } }),
    })
    expect(prompt(harness.host).dataset.inputState).toBe('text')
    expect(harness.host.querySelector('.agent-perm-args')?.textContent).toContain('/vault/a.md')
  })
})

/**
 * The three names the lasting-grant sentence is built from, read from the catalogue itself.
 *
 * They are the settings rail's own row, the permission page's own heading and the grants list's
 * own heading — the same three keys those surfaces draw their names from. Nothing here is a copy
 * of a string in the sentence: the guarantee being held is that a reader sent to look for what
 * "always allow" wrote arrives at a place wearing the name the sentence used.
 */
const GRANT_PLACES = {
  section: t('settings.section.agents'),
  page: t('agent.settings.permission.section.title'),
  surface: t('agent.settings.permission.grants.title'),
}

describe('AgentPermissionPrompt — what a lasting answer commits the user to', () => {
  it('says what “Always allow” does, when the engine offered one', () => {
    // The engine's own label for the option does not say how long the grant lasts, and the answer
    // outlives the prompt: the engine stops asking, this app is never told again, and nothing later
    // arrives to tell the user either. This sentence is the only place that gap is closed.
    const { host } = mount()
    const note = host.querySelector('[data-test="permission-lasting-note"]')
    expect(note?.textContent?.trim()).toBe(t('agent.permission.lastingGrant', GRANT_PLACES))
    // An undefined key renders as the key, so equality alone would hold for a string the catalogue
    // never had — which is the failure this block exists to prevent.
    expect(note?.textContent?.trim()).not.toBe('agent.permission.lastingGrant')
  })

  it('names the page that lists and takes a lasting grant back, instead of denying one', async () => {
    // The sentence this replaced said, in **both** languages, that this app «has no surface that
    // lists or takes it back» — which stopped being true when the grants page landed, and it is
    // drawn at the exact moment the reader decides whether to give the grant. So the note is read
    // in both languages here: a correction that reached one catalogue and not the other is exactly
    // how the false sentence was written twice in the first place.
    const { host } = mount()
    const note = (): string =>
      host.querySelector('[data-test="permission-lasting-note"]')?.textContent ?? ''
    // The claim itself, as the phrases the two sentences shipped: the English said the app «has no
    // surface that lists or takes it back», the Chinese said 「也没有任何地方能列出或收回它」.
    // Matched on the phrase rather than the whole sentence, so the warning may be reworded for any
    // other reason without this assertion being about wording.
    const gaveUpOn = /has no surface|没有任何地方/

    // The default this file's other cases read: restored at the end of the loop below, because a
    // locale left switched is a change to what every later case asserts.
    const before = getLocale()
    for (const locale of ['zh', 'en'] as const) {
      setLocale(locale)
      await nextTick()
      const places = {
        section: t('settings.section.agents'),
        page: t('agent.settings.permission.section.title'),
        surface: t('agent.settings.permission.grants.title'),
      }
      const text = note()
      expect(text).toContain(places.section)
      expect(text).toContain(places.page)
      expect(text).toContain(places.surface)
      expect(text).not.toMatch(gaveUpOn)
      // The slots are the page's own names, so a sentence that rendered them literally — or one
      // that named a place by a name nothing else in the app uses — fails here rather than
      // pointing the reader at a heading they will not find.
      expect(text).not.toMatch(/\{(section|page|surface)\}/)
    }
    setLocale(before)
  })

  it('says nothing about it when the request offers no lasting answer', () => {
    // §6.3: the options are the request's own. A request with no `allow_always` has no lasting
    // grant to warn about, and a sentence that appeared anyway would be about a button that is
    // not on screen.
    const { host } = mount({
      request: request({
        options: [
          { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      }),
    })
    expect(host.querySelector('[data-test="permission-lasting-note"]')).toBeNull()
  })

  it('gives the two allows different glyphs, so the pair is not told apart by colour', () => {
    // The two allow buttons are the pair a reader is most likely to confuse, and Zed's mapping —
    // one check for the answer that covers this call, a double check for the one that covers every
    // later one — is the signal that survives not being read.
    const { host } = mount()
    const icons = [...host.querySelectorAll('.agent-perm-options button')].map((button) => ({
      kind: (button as HTMLElement).dataset.optionKind,
      glyph: button.querySelector('svg')?.getAttribute('class') ?? '',
    }))
    expect(icons.map((entry) => entry.kind)).toEqual(['allow_once', 'allow_always', 'reject_once'])
    // Lucide names each icon in its class list, so two different names is two different glyphs.
    expect(icons[0]?.glyph).not.toBe(icons[1]?.glyph)
    expect(icons[0]?.glyph).not.toBe(icons[2]?.glyph)
  })
})

describe('AgentPermissionPrompt — the strings on the chrome', () => {
  it('labels the stop control with a key the catalogue already defines', () => {
    // No `agent.*` namespace exists yet, so the component uses none: the only chrome
    // string is the one the catalogue has for it. See the task report for the copy this
    // prompt still needs (the absent/unreadable/dead states).
    const { host } = mount()
    const label = cancelButton(host).textContent?.trim()
    expect(label).toBe(t('common.cancel'))
    // An undefined key renders as the key, so equality alone would hold for a string the
    // catalogue never had — which is the failure this whole block exists to prevent.
    expect(label).not.toBe('common.cancel')
  })
})
