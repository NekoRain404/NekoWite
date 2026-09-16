<script lang="ts">
/**
 * The terminal's copy, handed in rather than reached for — the arrangement every component here
 * uses, and for the same reason: this task does not own `src/i18n/namespaces/agent.ts`, and a
 * sentence printed from a key that does not exist would ship as an English string in a Chinese
 * window. A missing one is a compile error at the composition site.
 */
export interface AgentNativeTerminalLabels {
  /** The region's accessible name. */
  title: string
  /** Prefix of the command line in the header, so a reader knows what is running. */
  program: string
  /** Prefix of the configuration profile the session runs under (§8.1), when there is one. */
  profile: string
  state: {
    running: string
    exited: string
    failed: string
  }
  /** The child's own ending, rendered from its numbers (§4.3 「退出状态」). */
  ended: {
    /** Prefix for an exit code: the number is appended. */
    code: string
    /** Prefix for a signal. */
    signal: string
    /** A terminal whose ending carried no status at all. */
    unknown: string
  }
  /**
   * §4.3's honesty requirement, said once: this is the engine's own interface running with the
   * user's rights, and the app's per-action authorization does not reach inside it.
   */
  rights: string
  /** §3.3/§4.3: a managed installation's lifecycle is the app's, not this entry's. */
  managed: string
  /** Part of a line was cut by the host's column bound. */
  elided: string
  /** The view's own bound dropped earlier lines; the terminal is still running. */
  dropped: string
  copy: string
  copied: string
  copyFailed: string
  close: string
  /** §4.3 「关闭确认」: a running program is asked about, an ended one is not. */
  confirm: {
    title: string
    body: string
    keep: string
    confirm: string
  }
  /** An action the host refused, shown instead of pretending it arrived. */
  unavailable: string
  /**
   * The host's refusals, by the code `native_terminal.rs` refuses with. Keyed rather than
   * enumerated so a new refusal code is a missing sentence rather than a blank one.
   */
  refusal: Record<string, string>
}

/** A size in character cells, the unit a tty counts in. */
export interface AgentNativeTerminalSize {
  cols: number
  rows: number
}

/** One character cell, in CSS pixels — the view's measurement of its own font. */
export interface AgentNativeTerminalCell {
  width: number
  height: number
}

/** What the terminal produced, in the order it happened. */
export type AgentNativeTerminalEvent =
  | { kind: 'output'; text: string; elidedColumns: number }
  | { kind: 'exited'; code: number | null; signal: number | null }
  | { kind: 'failed'; code: string }

/**
 * The terminal's conversation with the host, injected at the composition site (§6.1). The names
 * are the ones the Rust side already speaks: `write` takes the reader's text, `resize` takes
 * cells, `close` is the host's shutdown ladder, and `subscribe` delivers output and the single
 * ending.
 */
export interface AgentNativeTerminalTransport {
  write(sessionId: string, data: string): Promise<void>
  resize(sessionId: string, size: AgentNativeTerminalSize): Promise<void>
  close(sessionId: string): Promise<void>
  /** Returns the release. It is not a cancel: looking away does not stop the program. */
  subscribe(sessionId: string, handler: (event: AgentNativeTerminalEvent) => void): () => void
}

/** The session this component draws. */
export interface AgentNativeTerminalSession {
  sessionId: string
  /** The program the host started, and the argument array it started it with (§3.4). */
  program: string
  args: string[]
  /** §3.4's installation kinds; `bundled` and `managed` are the app's own. */
  install: 'bundled' | 'managed' | 'external'
  /**
   * The profile whose configuration and credentials this terminal runs under (§8.1), when the
   * host knows it. §4.3 asks the entry to be explicit about it: a terminal pointed at a profile
   * the reader did not expect is running with an engine they did not expect.
   */
  profileId?: string | null
  state: 'running' | 'exited' | 'failed'
}
</script>

<script setup lang="ts">
/**
 * The native terminal: §4.3's entry that hands the user the engine's own commands.
 *
 * It draws one terminal session and is unable to do anything else. There is no session store and
 * no prompt gateway: the terminal is a *separate* thing from the conversation (§4.3 keeps its
 * output out of the session record), so a component that could reach a session would be the
 * wrong shape rather than an over-powered one. Everything it does travels through the injected
 * transport, which is this file's one wiring point — the adapter that implements it against the
 * Rust side belongs to the IPC task.
 *
 * What the acceptance is about, and where each half lives:
 *
 *  - **中文** — an input method commits a *string*, not keystrokes. The hidden field below is the
 *    sink (a terminal on the web is a field with no visible caret, which is what every terminal
 *    component does): composition events hold the text still, and the committed text is sent
 *    once, whole. Enter is the input method's key while a candidate is open — and, on WebKitGTK,
 *    for a moment after `compositionend`, the same `COMMIT_GRACE` rule the composer follows.
 *    Sending a bare `\r` in that window would submit half a word into a program that acts on it.
 *  - **resize** — the size is measured, not guessed: the box the view was given divided by a
 *    cell, sent only when it changes, and never sent when the box cannot be measured (a hidden
 *    panel is not a 1-column terminal). The tty is the authority on the other side; this end only
 *    has to stop disagreeing with it, which is why `native_terminal.rs` drops `COLUMNS`/`LINES`
 *    from the child's environment.
 *  - **取消 and 退出** — a running program is asked before it is closed (§4.3 「关闭确认」), and the
 *    ending shown is the child's own code or signal rather than the word "closed". A terminal
 *    that has ended stops accepting keys instead of pretending they went somewhere.
 *  - **受管升级限制** — the refusal arrives from the host as a code and this file renders the
 *    sentence for it. There is deliberately no "run anyway": the host refused *before a pty
 *    existed*, and a control that could undo that would re-open what §4.3 and §3.3 closed.
 *
 * **It is not a VT emulator, and says so rather than implying otherwise.** The viewport draws
 * decoded text and applies a line discipline (carriage return redraws a line, backspace removes
 * a character, escape sequences are removed rather than printed), which is honest for the
 * line-oriented native commands — `auth`, `mcp`, `db`, `stats`, `export` — and is *not* a
 * faithful screen for a full-screen TUI: cursor addressing is not implemented, so a program that
 * paints the whole screen will not paint it here. §4.3 asks for a mature terminal rendering
 * component; that dependency is not approved yet, and `measure` below is the seam it would take
 * over, since a real emulator measures its own font and draws its own screen.
 *
 * The other limitation is not the view's: the terminal runs the engine with the user's rights.
 * §4.3 asks the entry to be explicit about its permissions and its profile, so the header carries
 * both — the notice, the installation it belongs to, and the profile the host named, when it
 * named one.
 *
 * The session arrives as a prop and is read once, like the panel's: a terminal is mounted *per
 * session*, so the composition site keys it rather than re-pointing it at another one. And the
 * terminal is a session of its own — §4.3 allows no sharing with an ACP session until P0 measures
 * whether the two can share one, so nothing here is linked to a conversation.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * How much output the view keeps. Two bounds because either alone is defeated by the other:
 * many short lines, or few enormous ones. What is dropped is *said*, never silent — §6.2's rule
 * about bounds, applied to the half of the output the DOM would otherwise hold.
 */
const MAX_LINES = 2000
const MAX_CHARS = 200_000

/**
 * How long after a composition ends an Enter is still read as the input method's. WebKit — this
 * application's own engine — delivers the Enter that *committed* a candidate after
 * `compositionend`, by which time both flags say the composition is over.
 */
const COMMIT_GRACE = 60

/* `no-control-regex` exists to catch a control character that slipped into a pattern by mistake.
   These two are the opposite: ESC and BEL are the *subject* of the pattern, because matching them
   is how the viewport removes an escape sequence instead of drawing it. The rule is disabled for
   exactly these two lines and re-enabled after them, so a stray control character anywhere else
   in this file is still an error. */
/* eslint-disable no-control-regex -- ESC and BEL are what these patterns are for */
/** Escape sequences the viewport removes rather than draws (see the header). */
const ESCAPE_SEQUENCES =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]/g
/** A sequence still arriving: held for the next chunk, the way a split character is. */
const UNFINISHED_ESCAPE = /\x1b(?:\][^\x07\x1b]*|\[[0-9;?]*[ -/]*)?$/
/* eslint-enable no-control-regex */

const props = defineProps<{
  transport: AgentNativeTerminalTransport
  session: AgentNativeTerminalSession
  labels: AgentNativeTerminalLabels
  /**
   * Cell metrics, when the caller measures better than this component can. `null` means "not
   * measurable yet", and no size is sent from one.
   */
  measure?: () => AgentNativeTerminalCell | null
}>()

const emit = defineEmits<{
  /** The reader closed the terminal. The caller decides what happens to the session. */
  close: []
  /** The program ended on its own, with the ending the host reported. */
  exited: [ending: { code: number | null; signal: number | null }]
}>()

const screen = ref<HTMLElement | null>(null)
const field = ref<HTMLTextAreaElement | null>(null)

const state = ref<AgentNativeTerminalSession['state']>(props.session.state)
const ending = ref<{ code: number | null; signal: number | null } | null>(null)
const failure = ref<string | null>(null)
/** Set once anything was dropped, and left set: a later line does not un-drop an earlier one. */
const elided = ref(false)
const droppedLines = ref(0)
const confirming = ref(false)
const copyNotice = ref<'copied' | 'failed' | null>(null)
const unavailable = ref(false)

/** The retained output, and the same text as the viewport draws it. */
const buffer: string[] = ['']
const lines = ref<string[]>(buffer)
let chars = 0
/** Text held back because it ended inside an escape sequence. */
let pending = ''
let flushing = false
let composing = false
let composedAt = Number.NEGATIVE_INFINITY
let lastSize: AgentNativeTerminalSize | null = null
let observer: ResizeObserver | null = null
let release: (() => void) | null = null

const commandLine = computed(() =>
  [props.session.program, ...props.session.args]
    // Arguments are shown as they were handed over — an array, quoted for reading, never a
    // string a shell could be handed back (§3.4).
    .map((part) => (part.includes(' ') ? `"${part}"` : part))
    .join(' '),
)

const managed = computed(() => props.session.install !== 'external')
const running = computed(() => state.value === 'running')
const refusal = computed(() =>
  failure.value === null ? null : (props.labels.refusal[failure.value] ?? failure.value),
)
const stateWord = computed(() => props.labels.state[state.value])
const copyWord = computed(() => {
  if (copyNotice.value === null) return ''
  // Named rather than indexed by the outcome: `labels` has no key called `failed`, and a lookup
  // that silently rendered nothing is how a failed copy would have looked like a quiet success.
  return copyNotice.value === 'copied' ? props.labels.copied : props.labels.copyFailed
})

const endingWord = computed(() => {
  const held = ending.value
  if (held === null) return ''
  if (held.code !== null) return `${props.labels.ended.code} ${held.code}`
  if (held.signal !== null) return `${props.labels.ended.signal} ${held.signal}`
  return props.labels.ended.unknown
})

/** Remove the escape sequences this viewport cannot draw, holding a trailing partial one. */
function stripEscapes(text: string): string {
  const unfinished = text.match(UNFINISHED_ESCAPE)
  const complete = unfinished === null ? text : text.slice(0, text.length - unfinished[0].length)
  pending = unfinished === null ? '' : unfinished[0]
  return complete.replace(ESCAPE_SEQUENCES, '')
}

/**
 * Apply a piece of output to the retained lines.
 *
 * The line discipline is three rules, and each is about a program that is not a log file: a
 * carriage return redraws the line it is on rather than starting another, a backspace takes the
 * last character off, and escape sequences are removed instead of printed. Text that ends in the
 * middle of one is held until the next chunk, because half an escape sequence printed as text is
 * worse than a moment's delay.
 */
function pushOutput(text: string, elidedColumns: number): void {
  if (elidedColumns > 0) elided.value = true
  for (const character of stripEscapes(pending + text)) {
    const last = buffer.length - 1
    if (character === '\r') {
      chars -= buffer[last].length
      buffer[last] = ''
    } else if (character === '\b') {
      if (buffer[last].length > 0) {
        chars -= 1
        buffer[last] = buffer[last].slice(0, -1)
      }
    } else if (character === '\n') {
      chars += 1
      buffer.push('')
    } else {
      chars += 1
      buffer[last] += character
    }
  }
  trim()
  schedule()
}

/** Drop whole lines from the front until both bounds hold — whole lines, so nothing is cut open. */
function trim(): void {
  let dropped = 0
  while (buffer.length > MAX_LINES || (chars > MAX_CHARS && buffer.length > 1)) {
    dropped += 1
    chars -= buffer[0].length + 1
    buffer.shift()
  }
  droppedLines.value += dropped
}

/**
 * One render per burst of output, not one per chunk (§5.2 「每帧合并文本增量」): a burst that
 * arrives in a microtask batch is a single DOM update, which for a terminal is the difference
 * between a screen that keeps up and one that does not.
 */
function schedule(): void {
  if (flushing) return
  flushing = true
  void Promise.resolve().then(() => {
    flushing = false
    const host = screen.value
    // §5.2: a reader who has scrolled up is not yanked back. The terminal follows only when it
    // was already at the end.
    const follow =
      host === null || host.scrollHeight - host.scrollTop - host.clientHeight < 24
    if (buffer.length === 0) buffer.push('')
    lines.value = buffer.slice()
    if (follow && host !== null && typeof host.scrollTo === 'function') {
      host.scrollTo({ top: host.scrollHeight })
    }
  })
}

/** The component's own measurement: a monospace probe, divided by however many fit. */
function measured(): AgentNativeTerminalCell | null {
  const host = screen.value
  if (host === null) return null
  const probe = document.createElement('span')
  probe.textContent = 'M'.repeat(64)
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre'
  host.appendChild(probe)
  const width = probe.getBoundingClientRect().width / 64
  probe.remove()
  const height = Number.parseFloat(getComputedStyle(host).lineHeight)
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    // Nothing measured — a hidden panel, a font not applied yet: the tty keeps the size it was
    // opened with rather than being told a number this end invented.
    return null
  }
  return { width, height }
}

/** The size a measured box asks the tty for, or `null` when there is nothing honest to say. */
function sizeFor(width: number, height: number): AgentNativeTerminalSize | null {
  const cell = props.measure?.() ?? measured()
  if (cell === null || cell.width <= 0 || cell.height <= 0) return null
  const cols = Math.floor(width / cell.width)
  const rows = Math.floor(height / cell.height)
  // A box too small for a single cell is a box being hidden, not a 1×1 terminal: a tty told it
  // has one column makes programs draw one column, and the reader sees the wreckage.
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return null
  return { cols: Math.min(cols, 65535), rows: Math.min(rows, 65535) }
}

function applyBox(width: number, height: number): void {
  const size = sizeFor(width, height)
  if (size === null) return
  if (lastSize !== null && lastSize.cols === size.cols && lastSize.rows === size.rows) return
  lastSize = size
  void props.transport.resize(props.session.sessionId, size).catch(() => {
    unavailable.value = true
  })
}

function onEvent(event: AgentNativeTerminalEvent): void {
  if (event.kind === 'output') {
    pushOutput(event.text, event.elidedColumns)
    return
  }
  if (event.kind === 'failed') {
    failure.value = event.code
    state.value = 'failed'
    return
  }
  ending.value = { code: event.code, signal: event.signal }
  state.value = 'exited'
  emit('exited', { code: event.code, signal: event.signal })
}

function send(data: string): void {
  // A terminal that has ended takes no keys. The field is disabled, so a reader cannot reach
  // this path anyway — but a keystroke sent to a program that is gone is the one thing that must
  // not quietly happen while a screen still looks alive.
  if (!running.value || data.length === 0) return
  void props.transport.write(props.session.sessionId, data).catch(() => {
    // A keystroke the host refused is reported: typing into a terminal that is not taking input,
    // and being told nothing, is how a reader concludes the program is broken.
    unavailable.value = true
  })
}

/**
 * The keys that are not text: a terminal sends control bytes, and the *tty* — not this component
 * — is what turns Ctrl-C into a signal for the foreground process group. The mappings are the
 * standard ones; anything not listed is left to the field, which is what an input method needs.
 * Ctrl-V is deliberately not one of them: it is this application's paste, and the pasted text
 * arrives through the field like any other text.
 */
function keyBytes(event: KeyboardEvent): string | null {
  const plain = !event.altKey && !event.metaKey
  if (event.ctrlKey && plain && event.key.length === 1 && event.key.toLowerCase() !== 'v') {
    const code = event.key.toUpperCase().charCodeAt(0)
    if (code >= 64 && code < 96) return String.fromCharCode(code - 64)
  }
  if (event.ctrlKey || event.altKey || event.metaKey) return null
  switch (event.key) {
    case 'Enter':
      return '\r'
    case 'Backspace':
      return '\x7f'
    case 'Tab':
      return '\t'
    case 'Escape':
      return '\x1b'
    case 'ArrowUp':
      return '\x1b[A'
    case 'ArrowDown':
      return '\x1b[B'
    case 'ArrowRight':
      return '\x1b[C'
    case 'ArrowLeft':
      return '\x1b[D'
    default:
      return null
  }
}

function onKeydown(event: KeyboardEvent): void {
  const bytes = keyBytes(event)
  if (bytes === null) return
  // Enter during a candidate, and the Enter WebKit delivers just after one, belong to the input
  // method (see COMMIT_GRACE). It is what makes a Chinese reader's Enter safe.
  if (
    event.key === 'Enter' &&
    (composing ||
      event.isComposing ||
      event.keyCode === 229 ||
      performance.now() - composedAt < COMMIT_GRACE)
  ) {
    return
  }
  event.preventDefault()
  send(bytes)
}

/** Send what the input method (or the keyboard) put in the field, and empty it. */
function flushField(): void {
  const element = field.value
  if (element === null) return
  const value = element.value
  if (value.length === 0) return
  // The element's own value, not the ref. `field.value = ''` reads as "empty the field" and does
  // the opposite: it replaces the ref with a string, so the textarea keeps the text it just sent,
  // every later keystroke reads an empty ref and sends nothing, and focus has nothing to point at.
  element.value = ''
  send(value)
}

function onInput(): void {
  // While a composition is open the field holds a *candidate*; the text it settles on is what
  // the reader meant, and `compositionend` is where that is sent.
  if (composing) return
  flushField()
}

function onCompositionStart(): void {
  composing = true
}

function onCompositionEnd(): void {
  composing = false
  composedAt = performance.now()
  // The committed text is in the field now. The `input` that carries it may have already fired
  // while the composition was open — where it was deliberately not sent — so send it here too:
  // both paths read an emptied field the second time and nothing is sent twice.
  flushField()
}

function focusInput(): void {
  field.value?.focus()
}

function close(): void {
  if (running.value && !confirming.value) {
    confirming.value = true
    return
  }
  confirming.value = false
  void props.transport.close(props.session.sessionId).then(
    () => emit('close'),
    // A close the host refused leaves the terminal on screen: hiding a program that is still
    // running would be exactly the disappearance §4.3's confirmation exists to prevent.
    () => {
      unavailable.value = true
    },
  )
}

function keep(): void {
  confirming.value = false
}

/**
 * The copy path for a webview that has no async clipboard: stage the text in an off-screen field
 * and let the engine's own copy command take the selection. Both paths are attempts and neither
 * is assumed — whether either works inside WebKitGTK 4.1 under Tauri is *unmeasured*, so the
 * failure is reported rather than swallowed.
 */
function stagedCopy(text: string): boolean {
  const staged = document.createElement('textarea')
  staged.value = text
  staged.setAttribute('readonly', '')
  staged.style.cssText = 'position:absolute;left:-9999px;top:0'
  document.body.appendChild(staged)
  staged.select()
  const copied = typeof document.execCommand === 'function' && document.execCommand('copy')
  staged.remove()
  return copied
}

async function copy(): Promise<void> {
  copyNotice.value = null
  const text = lines.value.join('\n')
  try {
    // The button copies the whole buffer; copying *part* of the screen is the reader's own
    // selection and the engine's own copy, which the viewport does not interfere with.
    if (navigator.clipboard === undefined) {
      if (!stagedCopy(text)) throw new Error('no clipboard')
    } else {
      await navigator.clipboard.writeText(text)
    }
    copyNotice.value = 'copied'
  } catch {
    copyNotice.value = 'failed'
  }
}

onMounted(() => {
  release = props.transport.subscribe(props.session.sessionId, onEvent)
  const host = screen.value
  // The first size comes from the box the view actually has, so the tty is corrected as soon as
  // there is something to correct it with; until then it keeps the size it was opened with.
  applyBox(host?.clientWidth ?? 0, host?.clientHeight ?? 0)
  if (typeof ResizeObserver === 'function' && host !== null) {
    observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        applyBox(entry.contentRect.width, entry.contentRect.height)
      }
    })
    observer.observe(host)
  }
  field.value?.focus()
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  // Looking away is not a cancel (§5.1 「任务可以在面板收起后继续」): the subscription is released
  // and nothing else is stopped. The program ends when the reader closes it, or when the app does.
  release?.()
  release = null
})
</script>

<template>
  <section
    class="agent-native"
    data-agent-native-terminal
    :aria-label="labels.title"
  >
    <header class="agent-native-bar">
      <span class="agent-native-command">
        <span class="agent-native-program">{{ labels.program }}</span>
        <code data-native-program>{{ commandLine }}</code>
      </span>
      <span
        v-if="session.profileId"
        class="agent-native-state"
        data-native-profile
      >{{ labels.profile }} {{ session.profileId }}</span>
      <span
        class="agent-native-state"
        data-native-state
      >{{ stateWord }}</span>
    </header>

    <!-- §4.3: the entry names what it is. A terminal that ran the engine with the user's rights
         and did not say so would be the failure this notice exists to prevent. -->
    <p
      class="agent-native-notice"
      data-native-rights
    >
      {{ labels.rights }}
    </p>
    <p
      v-if="managed"
      class="agent-native-notice"
      data-native-managed
    >
      {{ labels.managed }}
    </p>
    <p
      v-if="refusal !== null"
      class="agent-native-refusal"
      role="alert"
      data-native-refusal
    >
      {{ refusal }}
    </p>
    <p
      v-if="unavailable"
      class="agent-native-refusal"
      role="alert"
      data-native-unavailable
    >
      {{ labels.unavailable }}
    </p>
    <!-- The ending, once there is one: the child's own code or signal (§4.3 「退出状态」), never
         the word "closed", which would describe the view rather than the program. -->
    <p
      v-if="state === 'exited'"
      class="agent-native-exit"
      data-native-exit
    >
      {{ endingWord }}
    </p>
    <p
      v-if="elided"
      class="agent-native-elided"
      data-native-elided
    >
      {{ labels.elided }}
    </p>
    <p
      v-if="droppedLines > 0"
      class="agent-native-dropped"
      data-native-dropped
    >
      {{ labels.dropped }}
    </p>

    <!-- The screen: one text node (§5.2 — a terminal redraws constantly, and a node per line
         would rebuild the tree on every frame), and the element a real renderer would take
         over. See the header for what this viewport is not. -->
    <!-- `v-text` rather than an interpolation inside the tag: whitespace inside a `pre` is part
         of what it draws, so the text has to be the whole of this element's content and nothing
         around it. -->
    <pre
      ref="screen"
      v-text="lines.join('\n')"
      class="agent-native-screen"
      data-native-screen
      tabindex="0"
      @click="focusInput"
    />

    <!-- The keyboard's sink: invisible, focused, and the only place an input method can attach.
         A terminal has no caret to draw, so the field is off the layout rather than beside it. -->
    <textarea
      ref="field"
      class="agent-native-field"
      data-native-field
      :disabled="!running"
      :aria-label="labels.title"
      autocapitalize="off"
      autocomplete="off"
      spellcheck="false"
      @keydown="onKeydown"
      @input="onInput"
      @compositionstart="onCompositionStart"
      @compositionend="onCompositionEnd"
    />

    <footer class="agent-native-bar">
      <span
        class="agent-native-state"
        data-native-copy-notice
      >{{ copyWord }}</span>
      <button
        class="agent-native-action"
        type="button"
        data-native-copy
        @click="copy"
      >
        {{ labels.copy }}
      </button>
      <button
        class="agent-native-action"
        type="button"
        data-native-close
        @click="close"
      >
        {{ labels.close }}
      </button>
    </footer>

    <!-- §4.3 「关闭确认」: a running program is asked about, because closing one can interrupt a
         write it had started. An ended one is not asked about, because there is nothing left to
         interrupt. -->
    <div
      v-if="confirming"
      class="agent-native-confirm"
      role="alertdialog"
      data-native-confirm
    >
      <p class="agent-native-confirm-title">{{ labels.confirm.title }}</p>
      <p class="agent-native-confirm-body">{{ labels.confirm.body }}</p>
      <button
        class="agent-native-action"
        type="button"
        data-native-keep
        @click="keep"
      >
        {{ labels.confirm.keep }}
      </button>
      <button
        class="agent-native-action"
        type="button"
        data-native-confirm-close
        @click="close"
      >
        {{ labels.confirm.confirm }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.agent-native {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--app-panel);
  color: var(--app-text);
  font-family: var(--app-font);
}
.agent-native-bar {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 28px;
  padding: 0 8px;
  border-bottom: 1px solid var(--app-border);
  font-size: 12px;
}
.agent-native-command {
  display: flex;
  gap: 6px;
  min-width: 0;
}
.agent-native-command code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-native-program,
.agent-native-state {
  color: var(--app-muted);
}
.agent-native-notice,
.agent-native-elided,
.agent-native-dropped {
  flex: none;
  margin: 0;
  padding: 4px 8px;
  color: var(--app-muted);
  font-size: 11px;
}
.agent-native-refusal {
  flex: none;
  margin: 0;
  padding: 4px 8px;
  border-bottom: 1px solid var(--app-border);
  font-size: 12px;
}
/* The screen scrolls; the wrapping decisions in it are the browser's own. */
.agent-native-screen {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 6px 8px;
  overflow: auto;
  background: var(--app-elevated);
  color: var(--app-text);
  font-family: var(--app-mono-font);
  font-size: 12px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-all;
}
/* The screen is `tabindex="0"` — it is the element a keyboard reaches the terminal's own
   scrollback through — and the engine's default ring on it is a fragment: measured in
   WebKitGTK, `outline: auto` paints five pixels down its left edge and nothing on the other
   three. A terminal has no other focus affordance to fall back on (the sink field is off the
   layout by design), so this is the only thing that says where the keyboard is. Same rule as
   the agent transcript's container; INSET because the screen is the full size of the viewport
   it scrolls, and an outside ring would be clipped by the panel around it. */
.agent-native-screen:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -2px;
}
.agent-native-field {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  border: 0;
  opacity: 0;
  resize: none;
}
.agent-native-action {
  min-height: 24px;
  padding: 0 8px;
  border: 1px solid var(--app-border);
  border-radius: var(--app-radius-sm);
  background: var(--app-elevated);
  color: var(--app-text);
  font-family: var(--app-font);
  font-size: 12px;
  cursor: pointer;
}
.agent-native-action:hover {
  background: color-mix(in srgb, var(--app-elevated) 84%, var(--app-accent-soft));
}
.agent-native-action:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 1px;
}
.agent-native-confirm {
  flex: none;
  padding: 8px;
  border-top: 1px solid var(--app-border);
  background: color-mix(in srgb, var(--app-warn) 12%, var(--app-panel));
}
.agent-native-confirm-title {
  margin: 0 0 4px;
  font-size: 12px;
}
.agent-native-confirm-body {
  margin: 0 0 6px;
  color: var(--app-muted);
  font-size: 11px;
}
</style>
