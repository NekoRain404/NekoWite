/**
 * The command menu, both halves: the composable that decides what it offers and
 * the popup that draws it.
 *
 * Everything here is one behaviour or one rule, and four of them are the task's
 * acceptance criteria. Replacement: a frame is the engine's whole list, so a
 * command a later frame drops stops being offered. Conflicts: one row per name,
 * and nothing the engine did not publish. Verbatim arguments: what the user
 * typed after the command name reaches the engine as typed. IME: a real
 * `compositionstart`/`compositionend` sequence around a real keydown, not a flag
 * this file sets on the composable.
 *
 * The two halves share a mount because the behaviours that matter span them — an
 * IME episode ends in a row being chosen, and a replacement frame has to reach
 * the rows. The panel that will own this pair is T6's; the wiring below is the
 * one it will use, with the same key and composition handlers on the composer's
 * own element.
 */

/* eslint-disable vue/one-component-per-file -- the two mount helpers below are
 * throwaway hosts that exist to give the composable a real element to receive
 * the DOM's events on; neither is a component of the app. */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp } from 'vue'

import AgentCommandMenu, { type AgentCommandMenuLabels } from '../components/AgentCommandMenu.vue'
import {
  useAgentCommands,
  type AgentCommandKeyResult,
  type UseAgentCommands,
} from './use-agent-commands'
import type {
  AgentCommand,
  AgentEvent,
  AgentFailureCode,
  AgentIdentity,
} from '../../../platform/gateways/agent-contracts'

/** The session every frame in this file is about, unless a test says otherwise. */
const IDENTITY: AgentIdentity = {
  agentId: 'opencode',
  profileId: 'default',
  runtimeEpoch: 'epoch-1',
  vaultId: 'vault-a',
  sessionId: 'ses-1',
}

const REVIEW: AgentCommand = { name: 'review', description: 'Review the pending change' }
const INIT: AgentCommand = { name: 'init', description: 'Create an AGENTS.md' }
/** Advertised without a description: §4.1 gives the field as optional. */
const CUSTOMIZE: AgentCommand = { name: 'customize-opencode' }

const LABELS: AgentCommandMenuLabels = {
  aria: 'Engine commands',
  waiting: 'Waiting for the engine to publish its commands…',
  empty: 'This engine publishes no commands.',
  noMatch: 'No published command matches.',
  unavailable: 'The command list could not be received.',
}

function commandsFrame(
  identity: AgentIdentity,
  // Mutable, as the frame's own payload declares it (`'commands-changed':
  // { commands: AgentCommand[] }`): the helper hands the list straight to the frame
  // rather than copying it, so a readonly one is not what it takes. Every call site
  // passes an array literal.
  commands: AgentCommand[],
  sequence = 1,
): AgentEvent {
  return { ...identity, runId: null, sequence, kind: 'commands-changed', payload: { commands } }
}

function failureFrame(
  identity: AgentIdentity,
  code: AgentFailureCode,
  sequence = 2,
): AgentEvent {
  return {
    ...identity,
    runId: 'run-1',
    sequence,
    kind: 'run-failed',
    payload: { code, message: `${code} (test)` },
  }
}

function names(commands: readonly AgentCommand[]): string[] {
  return commands.map((command) => command.name)
}

let mounted: VueApp[] = []

afterEach(() => {
  for (const app of mounted) app.unmount()
  mounted = []
  document.body.innerHTML = ''
})

interface Pair {
  api: UseAgentCommands
  /** What the menu reported, in order — a click or an Enter on a row. */
  selected: AgentCommand[]
  /** The composer's text, the way a panel would hold it. */
  text: { value: string }
  /** The bound session, the way a panel would hold it. */
  identity: { value: AgentIdentity | null }
  /** Types `value` and lets the menu catch up. */
  type: (value: string) => Promise<void>
  /** Dispatches one keydown at the composer and reports what the menu made of it. */
  press: (key: string, init?: KeyboardEventInit) => AgentCommandKeyResult
  /** A real composition event on the composer's element. */
  compose: (type: 'compositionstart' | 'compositionend') => Promise<void>
  composer: HTMLTextAreaElement
  menu: () => HTMLElement | null
  rows: () => HTMLElement[]
  notice: () => HTMLElement | null
}

/**
 * A composer and the menu, wired the way the panel will wire them: the menu's
 * key and composition handlers listen on the composer's own textarea, and the
 * menu draws whatever the composable decides.
 */
function mountPair(initialText = '/'): Pair {
  const text = ref(initialText)
  const identity = ref<AgentIdentity | null>(IDENTITY)
  const selected: AgentCommand[] = []
  let api!: UseAgentCommands

  const app = createApp({
    setup() {
      api = useAgentCommands({
        identity: () => identity.value,
        text: () => text.value,
        select: (command) => {
          selected.push(command)
        },
      })
      return () =>
        h('div', [
          h('textarea', { class: 'composer', value: text.value }),
          h(AgentCommandMenu, {
            view: api.view.value,
            commands: api.matches.value,
            activeIndex: api.activeIndex.value,
            reason: api.reason.value,
            labels: LABELS,
            onSelect: (command: AgentCommand) => {
              selected.push(command)
            },
            onHighlight: (index: number) => {
              api.setActive(index)
            },
          }),
        ])
    },
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  app.mount(host)
  mounted.push(app)

  const composer = host.querySelector<HTMLTextAreaElement>('.composer')!
  let lastKey: AgentCommandKeyResult = 'pass'

  // The DOM's own events, on the element the handlers belong to. The IME
  // sequence below is therefore the one a browser produces, rather than a
  // `composing` flag this file would have had to set itself.
  composer.addEventListener('compositionstart', () => {
    api.onCompositionStart()
  })
  composer.addEventListener('compositionend', () => {
    api.onCompositionEnd()
  })
  composer.addEventListener('keydown', (event) => {
    lastKey = api.onKeydown(event)
  })

  return {
    api,
    selected,
    text,
    identity,
    async type(value: string) {
      text.value = value
      await nextTick()
    },
    press(key: string, init: KeyboardEventInit = {}) {
      lastKey = 'pass'
      composer.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
      )
      return lastKey
    },
    async compose(type: 'compositionstart' | 'compositionend') {
      composer.dispatchEvent(new CompositionEvent(type, { bubbles: true }))
      await nextTick()
    },
    composer,
    menu: () => host.querySelector<HTMLElement>('.agent-command-menu'),
    rows: () => Array.from(host.querySelectorAll<HTMLElement>('.agent-command-item')),
    notice: () => host.querySelector<HTMLElement>('.agent-command-notice'),
  }
}

describe('what the engine publishes', () => {
  it('offers the commands of the frame it received', async () => {
    const pair = mountPair()
    pair.api.accept(commandsFrame(IDENTITY, [REVIEW, INIT]))
    await nextTick()

    expect(names(pair.api.matches.value)).toEqual(['review', 'init'])
    expect(pair.api.view.value).toBe('rows')
    expect(pair.rows().map((row) => row.dataset.name)).toEqual(['review', 'init'])
  })

  it('replaces the list wholesale, so a command the frame dropped stops being offered', async () => {
    const pair = mountPair()
    pair.api.accept(commandsFrame(IDENTITY, [REVIEW, INIT]))
    await nextTick()
    expect(pair.rows().map((row) => row.dataset.name)).toEqual(['review', 'init'])

    // The second frame is the engine's complete list, and it does not mention
    // `review`: the engine no longer offers it, so neither does the menu.
    pair.api.accept(commandsFrame(IDENTITY, [INIT], 2))
    await nextTick()

    expect(names(pair.api.matches.value)).toEqual(['init'])
    expect(pair.rows().map((row) => row.dataset.name)).toEqual(['init'])
    expect(pair.api.state.value).toEqual({ kind: 'published', commands: [INIT] })
  })

  it('does not accumulate: a frame that adds a command is the list, not an addition to it', async () => {
    const pair = mountPair()
    pair.api.accept(commandsFrame(IDENTITY, [REVIEW]))
    pair.api.accept(commandsFrame(IDENTITY, [INIT], 2))
    await nextTick()

    // If the second frame added to the first, `review` would still be a row.
    expect(names(pair.api.matches.value)).toEqual(['init'])
  })

  it('keeps one row per name when the engine publishes the same name twice', async () => {
    const pair = mountPair()
    pair.api.accept(
      commandsFrame(IDENTITY, [
        { name: 'review', description: 'first' },
        { name: 'review', description: 'second' },
      ]),
    )
    await nextTick()

    expect(pair.rows()).toHaveLength(1)
    expect(pair.api.state.value).toEqual({
      kind: 'published',
      commands: [{ name: 'review', description: 'first' }],
    })
  })
})

describe('the arguments the user typed', () => {
  it('reaches the engine exactly as typed', async () => {
    const pair = mountPair()
    // Spaces, a tab, quotes, a backslash, non-ASCII and a trailing space: every
    // one of them is something a parser could quietly normalise on the way past.
    const raw = '/review   原样参数  a"b\\c\td  --flag=1  '
    await pair.type(raw)

    expect(pair.api.promptText()).toBe(raw)
  })

  it('rewrites the token under construction and nothing after it', async () => {
    const pair = mountPair()
    await pair.type('/rev   a  b')

    expect(pair.api.textWithCommand(REVIEW)).toBe('/review   a  b')
  })

  it('closes the menu on the name it inserted, so the name is not offered again', async () => {
    const pair = mountPair()
    pair.api.accept(commandsFrame(IDENTITY, [REVIEW]))
    await pair.type('/rev')

    const inserted = pair.api.textWithCommand(REVIEW)
    expect(inserted).toBe('/review ')

    await pair.type(inserted)
    expect(pair.api.view.value).toBe('closed')
    expect(pair.rows()).toEqual([])
  })

  it('sends an unpublished command on to the engine rather than blocking it', async () => {
    const pair = mountPair()
    pair.api.accept(commandsFrame(IDENTITY, [REVIEW]))
    await pair.type('/insert-selection')

    // The app's own actions live in another surface (§4.1), so this token names
    // nothing the engine published — and the app's job is not to police it.
    expect(pair.api.view.value).toBe('no-match')
    expect(pair.api.promptText()).toBe('/insert-selection')
  })
})

describe('the session a list belongs to', () => {
  it('clears the list when the composer moves to another session', async () => {
    const pair = mountPair()
    pair.api.accept(commandsFrame(IDENTITY, [REVIEW]))
    await nextTick()
    expect(names(pair.api.matches.value)).toEqual(['review'])

    pair.identity.value = { ...IDENTITY, sessionId: 'ses-2' }
    await nextTick()

    expect(pair.api.view.value).toBe('waiting')
    expect(pair.api.matches.value).toEqual([])
    expect(pair.rows()).toEqual([])
  })

  it('does not show the previous vault commands in the session that replaced it', async () => {
    const pair = mountPair()
    pair.api.accept(commandsFrame(IDENTITY, [REVIEW]))

    pair.identity.value = { ...IDENTITY, vaultId: 'vault-b', sessionId: 'ses-2' }
    await nextTick()
    // A frame for the session the user left, arriving after the switch.
    pair.api.accept(commandsFrame(IDENTITY, [REVIEW], 2))
    await nextTick()

    expect(pair.api.matches.value).toEqual([])
    expect(pair.api.view.value).toBe('waiting')
  })

  // One field at a time, because §6.2's rule is a composite: comparing a
  // session id alone would accept the other four.
  const STRANGERS: Array<[string, AgentIdentity]> = [
    ['agentId', { ...IDENTITY, agentId: 'some-other-agent' }],
    ['profileId', { ...IDENTITY, profileId: 'some-other-profile' }],
    ['runtimeEpoch', { ...IDENTITY, runtimeEpoch: 'epoch-2' }],
    ['vaultId', { ...IDENTITY, vaultId: 'vault-b' }],
    ['sessionId', { ...IDENTITY, sessionId: 'ses-2' }],
  ]

  it.each(STRANGERS)('ignores a frame whose %s is not the bound session', async (_field, stranger) => {
    const pair = mountPair()
    pair.api.accept(commandsFrame(IDENTITY, [REVIEW]))

    pair.api.accept(commandsFrame(stranger, [INIT], 2))
    await nextTick()

    expect(names(pair.api.matches.value)).toEqual(['review'])
  })

  it('has nothing to offer before a session is bound', async () => {
    const pair = mountPair()
    pair.identity.value = null
    pair.api.accept(commandsFrame(IDENTITY, [REVIEW]))
    await nextTick()

    expect(pair.api.view.value).toBe('waiting')
    expect(pair.api.matches.value).toEqual([])
  })
})

describe('a list with nothing in it', () => {
  it('says the engine published none when the list arrived empty', async () => {
    const pair = mountPair()
    pair.api.accept(commandsFrame(IDENTITY, []))
    await nextTick()

    expect(pair.api.view.value).toBe('empty')
    expect(pair.notice()?.textContent?.trim()).toBe(LABELS.empty)
    expect(pair.menu()?.dataset.view).toBe('empty')
  })

  it('says it could not be received when the session went away instead', async () => {
    const pair = mountPair()
    pair.api.accept(commandsFrame(IDENTITY, [REVIEW]))
    pair.api.accept(failureFrame(IDENTITY, 'process-exited', 2))
    await nextTick()

    expect(pair.api.view.value).toBe('unavailable')
    expect(pair.api.reason.value).toBe('process-exited')
    expect(pair.notice()?.textContent?.trim()).toBe(LABELS.unavailable)
    // Not the wording for an engine that simply has nothing: the two are told
    // apart in the DOM, not only in the state.
    expect(pair.notice()?.textContent?.trim()).not.toBe(LABELS.empty)
    expect(pair.notice()?.dataset.reason).toBe('process-exited')
    expect(pair.api.matches.value).toEqual([])
  })

  const UNREACHABLE: AgentFailureCode[] = [
    'runtime-unavailable',
    'protocol-incompatible',
    'session-stale',
    'buffer-conflict',
    'process-exited',
  ]

  it.each(UNREACHABLE)('stops offering the list when the run failed as %s', async (code) => {
    const pair = mountPair()
    pair.api.accept(commandsFrame(IDENTITY, [REVIEW]))
    pair.api.accept(failureFrame(IDENTITY, code, 2))
    await nextTick()

    expect(pair.api.view.value).toBe('unavailable')
  })

  const SURVIVABLE: AgentFailureCode[] = [
    'permission-denied',
    'cancelled',
    'timeout',
    'invalid-response',
    'authentication-required',
    'certificate-untrusted',
  ]

  it.each(SURVIVABLE)('keeps offering the list when a turn ended as %s', async (code) => {
    const pair = mountPair()
    pair.api.accept(commandsFrame(IDENTITY, [REVIEW]))
    pair.api.accept(failureFrame(IDENTITY, code, 2))
    await nextTick()

    expect(names(pair.api.matches.value)).toEqual(['review'])
    expect(pair.api.view.value).toBe('rows')
  })

  // The same rule from the other side. A frame is not the only way this list can be told the
  // session is gone: a *call* the host refused says it too — `agent_prompt` answering
  // `session-stale`, `runtime-unavailable` or `process-exited` means the conversation the rows
  // belong to is not there to be asked, which is the same fact a `run-failed` frame carries and
  // the same conclusion for the menu. Before the host's refusals carried codes there was nothing
  // to key this on, so a rejected prompt left the rows on offer — commands nothing was listening
  // for, drawn under a session that had already gone.
  it.each(UNREACHABLE)('stops offering the list when a call was refused as %s', (code) => {
    const pair = mountPair()
    pair.api.accept(commandsFrame(IDENTITY, [REVIEW]))

    pair.api.invalidate(code)
    expect(pair.api.view.value).toBe('unavailable')
    expect(pair.api.reason.value).toBe(code)
    expect(pair.api.matches.value).toEqual([])
  })

  it('keeps offering the list when a call was refused for a reason about the turn', () => {
    // The race the host answers when a second turn arrives on a session that is answering: nothing
    // about it says the session is gone, and dropping the rows would take the reader's commands
    // away over a refusal that lasts as long as the turn does.
    const pair = mountPair()
    pair.api.accept(commandsFrame(IDENTITY, [REVIEW]))

    pair.api.invalidate('turn-in-flight')

    expect(names(pair.api.matches.value)).toEqual(['review'])
    expect(pair.api.view.value).toBe('rows')
  })
})

describe('while an IME is composing', () => {
  it('filters by the text the composition started from, not by the letters on the way', async () => {
    const pair = mountPair()
    pair.api.accept(commandsFrame(IDENTITY, [REVIEW, INIT]))
    await nextTick()

    // Pinyin on its way to a character: the candidate list is open, and the
    // filter is still what the composer held when it opened.
    await pair.compose('compositionstart')
    await pair.type('/feng')
    expect(names(pair.api.matches.value)).toEqual(['review', 'init'])

    // Committed. The menu is the engine's list again, filtered by what the
    // composer now actually holds.
    await pair.compose('compositionend')
    await pair.type('/风景')
    expect(pair.api.matches.value).toEqual([])
    expect(pair.api.view.value).toBe('no-match')

    await pair.type('/re')
    expect(names(pair.api.matches.value)).toEqual(['review'])
  })

  it('keeps the highlight off the arrow keys that walk the candidates', async () => {
    const pair = mountPair()
    pair.api.accept(commandsFrame(IDENTITY, [REVIEW, INIT]))
    await pair.compose('compositionstart')

    expect(pair.press('ArrowDown')).toBe('composing')
    expect(pair.api.activeIndex.value).toBe(0)

    await pair.compose('compositionend')
    expect(pair.press('ArrowDown')).toBe('handled')
    expect(pair.api.activeIndex.value).toBe(1)
  })

  it('does not run a command on the Enter that commits the candidate', async () => {
    const pair = mountPair()
    pair.api.accept(commandsFrame(IDENTITY, [REVIEW]))
    await pair.compose('compositionstart')

    expect(pair.press('Enter')).toBe('composing')
    expect(pair.selected).toEqual([])

    // …and the following Enter, after the candidate is committed, is the menu's
    // again: the guard holds the key for the composition, not for good.
    await pair.compose('compositionend')
    expect(pair.press('Enter')).toBe('handled')
    expect(pair.selected).toEqual([REVIEW])
  })

  it('treats a keystroke the browser flags as composing as the IME’s too', async () => {
    const pair = mountPair()
    pair.api.accept(commandsFrame(IDENTITY, [REVIEW]))

    // No composition events at all — this is the engine that marks the keystroke
    // itself, which is the case the composition sequence alone would miss.
    expect(pair.press('Enter', { isComposing: true })).toBe('composing')
    expect(pair.selected).toEqual([])
  })

  it('lets an ordinary Enter select once nothing is composing', async () => {
    const pair = mountPair()
    pair.api.accept(commandsFrame(IDENTITY, [REVIEW]))

    expect(pair.press('Enter')).toBe('handled')
    expect(pair.selected).toEqual([REVIEW])
  })
})

describe('AgentCommandMenu', () => {
  function mountMenu(props: {
    view: 'closed' | 'rows' | 'no-match' | 'empty' | 'waiting' | 'unavailable'
    commands?: AgentCommand[]
    activeIndex?: number
    reason?: AgentFailureCode | null
  }): { el: () => HTMLElement | null; selected: AgentCommand[]; highlights: number[] } {
    const selected: AgentCommand[] = []
    const highlights: number[] = []
    const app = createApp({
      setup: () => () =>
        h(AgentCommandMenu, {
          view: props.view,
          commands: props.commands ?? [],
          activeIndex: props.activeIndex ?? 0,
          reason: props.reason ?? null,
          labels: LABELS,
          onSelect: (command: AgentCommand) => {
            selected.push(command)
          },
          onHighlight: (index: number) => {
            highlights.push(index)
          },
        }),
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    app.mount(host)
    mounted.push(app)
    return { el: () => host.querySelector<HTMLElement>('.agent-command-menu'), selected, highlights }
  }

  it('draws a row per command, named as the engine wrote it, with the description when it has one', () => {
    const menu = mountMenu({ view: 'rows', commands: [REVIEW, CUSTOMIZE] })
    const rows = Array.from(menu.el()!.querySelectorAll<HTMLElement>('.agent-command-item'))

    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('.agent-command-name')?.textContent).toBe('/review')
    expect(rows[0].querySelector('.agent-command-description')?.textContent).toBe(
      'Review the pending change',
    )
    // Advertised without a description: the line is absent rather than empty.
    expect(rows[1].querySelector('.agent-command-description')).toBeNull()
  })

  it('marks the row Enter would take and reports what a click settled on', async () => {
    const menu = mountMenu({ view: 'rows', commands: [REVIEW, INIT], activeIndex: 1 })
    const rows = Array.from(menu.el()!.querySelectorAll<HTMLElement>('.agent-command-item'))

    expect(rows[1].classList.contains('is-active')).toBe(true)
    expect(rows[0].classList.contains('is-active')).toBe(false)

    rows[0].click()
    await nextTick()
    expect(menu.selected).toEqual([REVIEW])
  })

  it('reports the row the pointer moved onto', async () => {
    const menu = mountMenu({ view: 'rows', commands: [REVIEW, INIT] })
    const rows = Array.from(menu.el()!.querySelectorAll<HTMLElement>('.agent-command-item'))

    rows[1].dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
    await nextTick()

    expect(menu.highlights).toEqual([1])
  })

  it('draws nothing at all when the menu is not open', () => {
    const menu = mountMenu({ view: 'closed' })
    expect(menu.el()).toBeNull()
  })

  it('says which of the empty lists it is, rather than drawing one empty box', () => {
    expect(mountMenu({ view: 'waiting' }).el()?.dataset.view).toBe('waiting')
    expect(mountMenu({ view: 'empty' }).el()?.dataset.view).toBe('empty')
    expect(mountMenu({ view: 'no-match' }).el()?.dataset.view).toBe('no-match')
    expect(mountMenu({ view: 'unavailable', reason: 'process-exited' }).el()?.dataset.view).toBe(
      'unavailable',
    )
  })

  it('draws no rows in any of the states that have none', () => {
    for (const view of ['waiting', 'empty', 'no-match', 'unavailable'] as const) {
      const menu = mountMenu({ view, commands: [REVIEW] })
      expect(menu.el()!.querySelectorAll('.agent-command-item')).toHaveLength(0)
    }
  })
})
