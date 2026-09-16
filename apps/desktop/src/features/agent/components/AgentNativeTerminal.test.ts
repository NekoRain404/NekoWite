/**
 * The native terminal: the one entry in §4 that hands the user an arbitrary tool, and the five
 * things its acceptance is about — 中文 input, resize, 取消, 退出, and the managed-installation
 * limit.
 *
 * The transport is a double this file drives by hand, because the questions here are about what
 * the view *does*: which bytes a Chinese composition turns into, when a resize is sent and when
 * it must not be, what the header says about an installation the app packaged, and whether a
 * refusal from the host can be walked around from the UI. The other half — that the pty really
 * carries those bytes, really delivers SIGWINCH, and really ends the process group — is
 * `agent_native_terminal_test.rs`, against a real child.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, reactive, type App as VueApp } from 'vue'
import AgentNativeTerminal, {
  type AgentNativeTerminalEvent,
  type AgentNativeTerminalLabels,
  type AgentNativeTerminalSession,
  type AgentNativeTerminalSize,
  type AgentNativeTerminalTransport,
} from './AgentNativeTerminal.vue'

const LABELS: AgentNativeTerminalLabels = {
  title: 'Native terminal',
  program: 'Started',
  profile: 'Profile',
  state: { running: 'Running', exited: 'Finished', failed: 'Refused' },
  ended: { code: 'Exit code', signal: 'Stopped by signal', unknown: 'Finished without a status' },
  rights: 'This terminal runs the engine with your own rights',
  managed: 'Upgrade and uninstall are managed by the app',
  elided: 'A line was cut at the column bound',
  dropped: 'Earlier output is no longer kept',
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: 'Copy failed',
  close: 'Close',
  confirm: {
    title: 'Close this terminal?',
    body: 'The program is still running',
    keep: 'Keep running',
    confirm: 'Close it',
  },
  unavailable: 'The host refused that',
  refusal: {
    'managed-lifecycle': 'This installation is managed by the app and cannot upgrade itself',
    'shell-command': 'This entry does not run command strings',
  },
}

const SESSION: AgentNativeTerminalSession = {
  sessionId: 'terminal-1',
  program: '/usr/lib/nekowite/opencode',
  args: ['run', 'the plan'],
  install: 'bundled',
  profileId: 'default',
  state: 'running',
}

type TerminalProps = {
  transport: AgentNativeTerminalTransport
  session: AgentNativeTerminalSession
  labels: AgentNativeTerminalLabels
  measure?: () => { width: number; height: number } | null
  onClose?: () => void
  onExited?: (ending: { code: number | null; signal: number | null }) => void
}

interface Harness {
  host: HTMLElement
  props: TerminalProps
  /** Everything the view sent to the program. */
  writes: string[]
  /** Every size it asked the tty for, in order. */
  sizes: AgentNativeTerminalSize[]
  /**
   * Every close the *transport* was asked for, as `1`, and every `close` the component emitted,
   * as `-1`. One array so that "the host was asked" and "the caller was told" are one assertion:
   * a component that did only one of the two would satisfy neither list on its own.
   */
  closes: number[]
  /** How many times the subscription was released. */
  releases: number[]
  endings: Array<{ code: number | null; signal: number | null }>
  /** The subscription id the view took, so "it subscribed to this session" is an assertion. */
  subscribers: string[]
  emit: (event: AgentNativeTerminalEvent) => Promise<void>
  /** The box the observer would report: a real measurement, delivered by hand. */
  box: (width: number, height: number) => Promise<void>
  field: () => HTMLTextAreaElement
  el: (selector: string) => HTMLElement | null
  text: (selector: string) => string
  screen: () => string
  click: (selector: string) => Promise<void>
  unmount: () => void
}

/** The observer the view installs, kept here so a test can hand it a box. */
const observers: ResizeObserverStub[] = []

class ResizeObserverStub {
  callback: ResizeObserverCallback
  targets: Element[] = []

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    observers.push(this)
  }

  observe(target: Element): void {
    this.targets.push(target)
  }

  unobserve(): void {}

  disconnect(): void {
    this.targets = []
  }

  /** Deliver one measured box, the way the platform would after a drag. */
  fire(width: number, height: number): void {
    const entry = { contentRect: { width, height } } as unknown as ResizeObserverEntry
    this.callback([entry], this as unknown as ResizeObserver)
  }
}

let mounted: VueApp[] = []
let original: typeof globalThis.ResizeObserver | undefined

/** The whole async settle these tests use: the view flushes on a microtask, then Vue renders. */
const flush = async (): Promise<void> => {
  await Promise.resolve()
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  original = globalThis.ResizeObserver
  observers.length = 0
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver
})

afterEach(() => {
  mounted.forEach((app) => app.unmount())
  mounted = []
  document.body.innerHTML = ''
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = original
})

function mount(overrides: Partial<TerminalProps> = {}): Harness {
  const host = document.createElement('div')
  document.body.appendChild(host)

  const writes: string[] = []
  const sizes: AgentNativeTerminalSize[] = []
  const closes: number[] = []
  const releases: number[] = []
  const endings: Harness['endings'] = []
  const subscribers: string[] = []
  let handler: ((event: AgentNativeTerminalEvent) => void) | null = null

  const transport: AgentNativeTerminalTransport = {
    write: async (_sessionId, data) => {
      writes.push(data)
    },
    resize: async (_sessionId, size) => {
      sizes.push(size)
    },
    close: async () => {
      closes.push(closes.length + 1)
    },
    subscribe: (sessionId, next) => {
      subscribers.push(sessionId)
      handler = next
      return () => {
        releases.push(releases.length + 1)
      }
    },
  }

  const props = reactive<TerminalProps>({
    transport,
    session: SESSION,
    labels: LABELS,
    // The cell metrics a real renderer would report; the component's own probe measures nothing
    // in this environment, which is the case its "do not invent a size" rule covers.
    measure: () => ({ width: 8, height: 16 }),
    onClose: () => closes.push(-1),
    onExited: (ending) => endings.push(ending),
    ...overrides,
  })

  const app = createApp(
    defineComponent({
      setup() {
        return () => h(AgentNativeTerminal, { ...props })
      },
    }),
  )
  app.mount(host)
  mounted.push(app)

  const el = (selector: string): HTMLElement | null => host.querySelector(selector)
  return {
    host,
    props,
    writes,
    sizes,
    closes,
    releases,
    endings,
    subscribers,
    emit: async (event) => {
      handler?.(event)
      await flush()
    },
    box: async (width, height) => {
      for (const observer of observers) observer.fire(width, height)
      await flush()
    },
    field: () => {
      const field = el('[data-native-field]') as HTMLTextAreaElement | null
      if (field === null) throw new Error('the terminal has no keyboard sink')
      return field
    },
    el,
    text: (selector) => el(selector)?.textContent?.trim() ?? '',
    screen: () => el('[data-native-screen]')?.textContent ?? '',
    click: async (selector) => {
      const target = el(selector)
      if (target === null) throw new Error(`nothing matches ${selector}`)
      target.click()
      await flush()
    },
    unmount: () => {
      app.unmount()
    },
  }
}

function key(field: HTMLTextAreaElement, name: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', {
    key: name,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  field.dispatchEvent(event)
  return event.defaultPrevented
}

function type(field: HTMLTextAreaElement, value: string): void {
  field.value = value
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('AgentNativeTerminal — the keyboard a Chinese reader has', () => {
  it('sends a committed composition once, whole, and not its Enter', async () => {
    const harness = mount()
    const field = harness.field()

    field.dispatchEvent(new CompositionEvent('compositionstart'))
    type(field, 'ni')
    // A candidate is not the word: the field is holding what the input method is offering.
    expect(harness.writes).toEqual([])

    // The Enter that settles a candidate belongs to the input method — sending it would submit
    // half a word into a program that acts on what it reads.
    expect(key(field, 'Enter', { isComposing: true })).toBe(false)
    expect(harness.writes).toEqual([])

    field.value = '你好，世界'
    field.dispatchEvent(new CompositionEvent('compositionend'))
    await flush()
    // One write, the whole word, in one piece (§4.3 「中文输入」).
    expect(harness.writes).toEqual(['你好，世界'])

    // The `input` the browser fires behind `compositionend` finds an emptied field: the committed
    // word is not sent a second time.
    type(field, '')
    await flush()
    expect(harness.writes).toEqual(['你好，世界'])
  })

  it('turns the keys that are not text into the bytes a terminal sends', async () => {
    const harness = mount()
    const field = harness.field()

    // Enter is a carriage return, which the tty's own line discipline turns into a newline.
    expect(key(field, 'Enter')).toBe(true)
    expect(key(field, 'Backspace')).toBe(true)
    expect(key(field, 'ArrowUp')).toBe(true)
    // Ctrl-C is three, and the tty — not this component — is what turns it into SIGINT for the
    // foreground process group. This is the cancel path a TUI is stopped with.
    expect(key(field, 'c', { ctrlKey: true })).toBe(true)
    await flush()
    expect(harness.writes).toEqual(['\r', '', '[A', ''])

    // Ctrl-V is this application's paste, not a control byte: the text appears in the field and
    // travels the ordinary way.
    expect(key(field, 'v', { ctrlKey: true })).toBe(false)
    type(field, '粘贴的文字')
    await flush()
    expect(harness.writes).toEqual(['\r', '', '[A', '', '粘贴的文字'])
  })

  it('refuses to send keys at all once the program has ended', async () => {
    const harness = mount()
    await harness.emit({ kind: 'exited', code: 0, signal: null })

    expect(harness.field().disabled).toBe(true)
    key(harness.field(), 'Enter')
    await flush()
    expect(harness.writes).toEqual([])
  })
})

describe('AgentNativeTerminal — the window size', () => {
  it('asks for one size per measured box and nothing when the box is unchanged', async () => {
    const harness = mount()

    await harness.box(800, 320)
    expect(harness.sizes).toEqual([{ cols: 100, rows: 20 }])

    // A drag is dozens of callbacks and one size: §4.3's requirement is that the two ends agree,
    // not that the tty be told about every pixel.
    await harness.box(800, 320)
    expect(harness.sizes).toHaveLength(1)

    await harness.box(400, 320)
    expect(harness.sizes).toEqual([
      { cols: 100, rows: 20 },
      { cols: 50, rows: 20 },
    ])
  })

  it('says nothing at all when the box cannot be measured', async () => {
    const harness = mount({ measure: () => null })
    await harness.box(0, 0)
    await harness.box(800, 320)
    // A hidden panel is not an 80×24 terminal and is certainly not a one-column one: a tty told
    // it has one column makes programs draw one column. The tty keeps what it was opened with.
    expect(harness.sizes).toEqual([])

    const tiny = mount()
    await tiny.box(4, 4)
    expect(tiny.sizes).toEqual([])
  })

  it('keeps the output that was arriving while a resize was sent', async () => {
    const harness = mount()
    await harness.box(800, 320)

    await harness.emit({ kind: 'output', text: '第一行\n', elidedColumns: 0 })
    await harness.box(400, 320)
    await harness.emit({ kind: 'output', text: '第二行\n', elidedColumns: 0 })

    expect(harness.sizes).toHaveLength(2)
    // Nothing was dropped, and the lines are in the order they were written: a resize is not a
    // reason to lose what a program printed around it.
    expect(harness.screen()).toBe('第一行\n第二行\n')
  })
})

describe('AgentNativeTerminal — what the screen draws', () => {
  it('draws lines, redraws the one a carriage return returns to, and drops escapes', async () => {
    const harness = mount()

    await harness.emit({ kind: 'output', text: '第一行\n', elidedColumns: 0 })
    // A program that draws progress with carriage returns is redrawing one line, not adding one.
    await harness.emit({ kind: 'output', text: '10%\r100%\n', elidedColumns: 0 })
    await harness.emit({ kind: 'output', text: '[32mgreen[0m\n', elidedColumns: 0 })
    // An escape sequence split across two chunks is held rather than printed as text.
    await harness.emit({ kind: 'output', text: '[3', elidedColumns: 0 })
    await harness.emit({ kind: 'output', text: '1mred\n', elidedColumns: 0 })

    expect(harness.screen()).toBe('第一行\n100%\ngreen\nred\n')
  })

  it('keeps the view bounded and says what it stopped keeping', async () => {
    // Many short lines: the bound that matters is the number of lines.
    const many = mount()
    const lines = Array.from({ length: 2500 }, (_, index) => `第${index}行`).join('\n')
    await many.emit({ kind: 'output', text: `${lines}\n`, elidedColumns: 0 })

    const rows = many.screen().split('\n')
    expect(rows.length).toBeLessThanOrEqual(2000)
    // The oldest went, the newest stayed, and the reader was told instead of being shown a short
    // screen as if it were the whole one (§6.2's rule about bounds).
    expect(many.screen()).not.toContain('第0行')
    expect(many.screen()).toContain('第2499行')
    expect(many.text('[data-native-dropped]')).toContain('no longer kept')

    // Few enormous lines: the line bound alone would keep all twenty, so the character bound is
    // the one that has to hold. (The host caps a line at its column bound, so in practice this is
    // the belt behind that brace — and it is the half a hostile program would aim at.)
    const few = mount()
    const huge = Array.from({ length: 20 }, () => '中'.repeat(20_000)).join('\n')
    await few.emit({ kind: 'output', text: `${huge}\n`, elidedColumns: 0 })
    expect(few.screen().split('\n').length).toBeLessThan(20)
    expect(few.text('[data-native-dropped]')).toContain('no longer kept')
  })

  it('says when a line was cut at the host’s column bound', async () => {
    const harness = mount()
    expect(harness.el('[data-native-elided]')).toBeNull()
    await harness.emit({ kind: 'output', text: 'a very long line', elidedColumns: 400 })
    expect(harness.text('[data-native-elided]')).toContain('column bound')
  })
})

describe('AgentNativeTerminal — ending it', () => {
  it('shows the child’s own ending rather than the word "closed"', async () => {
    const harness = mount()
    await harness.emit({ kind: 'exited', code: 7, signal: null })
    expect(harness.text('[data-native-state]')).toBe('Finished')
    expect(harness.text('[data-native-exit]')).toContain('Exit code 7')
    expect(harness.endings).toEqual([{ code: 7, signal: null }])

    const signalled = mount()
    await signalled.emit({ kind: 'exited', code: null, signal: 15 })
    expect(signalled.text('[data-native-exit]')).toContain('Stopped by signal 15')

    const unknown = mount()
    await unknown.emit({ kind: 'exited', code: null, signal: null })
    // A terminal whose ending carried no status is not an exit code of zero, and is not shown as
    // one: §4.3 keeps the two apart.
    expect(unknown.text('[data-native-exit]')).toBe('Finished without a status')
  })

  it('asks before closing a running program, and does not ask about one that ended', async () => {
    const harness = mount()
    await harness.click('[data-native-close]')
    // §4.3 「关闭确认」: closing a running program can interrupt a write it had started.
    expect(harness.closes).toEqual([])
    expect(harness.el('[data-native-confirm]')).not.toBeNull()

    await harness.click('[data-native-keep]')
    expect(harness.el('[data-native-confirm]')).toBeNull()
    expect(harness.closes).toEqual([])

    await harness.click('[data-native-close]')
    await harness.click('[data-native-confirm-close]')
    expect(harness.closes).toEqual([1, -1])

    const ended = mount()
    await ended.emit({ kind: 'exited', code: 0, signal: null })
    await ended.click('[data-native-close]')
    // Nothing left to interrupt, so nothing to ask about.
    expect(ended.closes).toEqual([1, -1])
  })

  it('releases its subscription on unmount and does not stop the program', async () => {
    const harness = mount()
    expect(harness.subscribers).toEqual(['terminal-1'])
    harness.unmount()
    await flush()
    // §5.1 「任务可以在面板收起后继续」: looking away is not a cancel.
    expect(harness.releases).toEqual([1])
    expect(harness.closes).toEqual([])
  })
})

describe('AgentNativeTerminal — what it is, and what it will not do', () => {
  it('says what is running and that it runs with the user’s own rights', async () => {
    const harness = mount()
    expect(harness.text('[data-native-program]')).toContain('/usr/lib/nekowite/opencode')
    // The argument array as it was handed over, quoted for reading: an argument with a space is
    // one argument, and a header that printed it bare would misreport the command (§3.4).
    expect(harness.text('[data-native-program]')).toContain('run "the plan"')
    // §4.3 「入口必须明确其权限和 profile」: the notice that is always on screen, and the profile
    // when the host named one — a terminal running under a profile the reader did not expect is
    // running with an engine they did not expect.
    expect(harness.text('[data-native-rights]')).toContain('your own rights')
    expect(harness.text('[data-native-profile]')).toBe('Profile default')

    const unnamed = mount({ session: { ...SESSION, profileId: null } })
    expect(unnamed.el('[data-native-profile]')).toBeNull()
  })

  it('names the managed limit, and renders a refusal as the host’s sentence', async () => {
    const managed = mount()
    expect(managed.text('[data-native-managed]')).toContain('managed by the app')

    const external = mount({
      session: { ...SESSION, install: 'external' },
    })
    expect(external.el('[data-native-managed]')).toBeNull()

    // A refusal is the host's, keyed by the code `native_terminal.rs` refused with — and there is
    // no control here that could walk around it, because the host refused before a pty existed.
    const refused = mount()
    await refused.emit({ kind: 'failed', code: 'managed-lifecycle' })
    expect(refused.text('[data-native-refusal]')).toContain('managed by the app and cannot upgrade')
    expect(refused.text('[data-native-state]')).toBe('Refused')
    expect(refused.field().disabled).toBe(true)
    expect(refused.screen()).not.toContain('run anyway')
  })

  it('hands the buffer to the clipboard, and says so when it cannot', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const harness = mount()
    await harness.emit({ kind: 'output', text: '复制我\n', elidedColumns: 0 })
    await harness.click('[data-native-copy]')
    expect(writeText).toHaveBeenCalledWith('复制我\n')
    expect(harness.text('[data-native-copy-notice]')).toBe('Copied')

    // A clipboard that refuses is reported: a copy button that silently does nothing leaves the
    // reader pasting a stale buffer.
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    await harness.click('[data-native-copy]')
    expect(harness.text('[data-native-copy-notice]')).toBe('Copy failed')
  })

  it('falls back to the engine’s own copy when there is no async clipboard', async () => {
    // WebKitGTK under Tauri is not measured for `navigator.clipboard`, so the second path is the
    // one that may carry the acceptance — and when neither works the reader is told.
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: undefined })
    const exec = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec })

    const harness = mount()
    await harness.emit({ kind: 'output', text: '复制我\n', elidedColumns: 0 })
    await harness.click('[data-native-copy]')
    expect(exec).toHaveBeenCalledWith('copy')
    expect(harness.text('[data-native-copy-notice]')).toBe('Copied')

    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    })
    await harness.click('[data-native-copy]')
    expect(harness.text('[data-native-copy-notice]')).toBe('Copy failed')
  })

  it('reports input the host refused instead of pretending the keystroke arrived', async () => {
    const harness = mount()
    harness.props.transport.write = async () => {
      throw new Error('the program has ended')
    }
    type(harness.field(), 'x')
    await flush()
    expect(harness.text('[data-native-unavailable]')).toContain('refused')
  })
})
