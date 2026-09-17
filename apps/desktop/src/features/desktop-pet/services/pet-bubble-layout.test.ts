/**
 * The bubble's content model: what a row is made of, which tasks the bubble shows, and in what order.
 *
 * The order is the assertion that matters most here, because it is the one §3.1.3 names as an
 * upstream defect to correct rather than port: 「上游 working 情绪优先于 waiting → 待授权必须可见，
 * 不能被另一项工作无限遮住」. Upstream ranks `working` above `waiting` (`windows/src/state.ts:43`),
 * so a run waiting for the user sits under every run that is merely busy — and with a cap, "under"
 * means gone. Several tests below are that correction, and one of them compares the ranking table
 * against the contract's own alert table so the two cannot drift apart in silence.
 *
 * The cap gets the same treatment for the same reason: a list that quietly drops its last two rows
 * is indistinguishable from a list that had two rows, so the count of what was not shown is part
 * of the model rather than something the component works out in a template.
 */
import { describe, expect, it } from 'vitest'
import {
  PET_ALERT_BY_STATE,
  PET_TASK_STATES,
  type PetTaskKey,
  type PetTaskProjection,
  type PetTaskState,
} from '../../../platform/gateways/pet-contracts'
import {
  PET_BUBBLE_LAYOUT_DEFAULTS,
  PET_TASK_URGENCY,
  PET_BUBBLE_MAX_HEIGHT,
  PET_BUBBLE_MAX_WIDTH,
  PET_BUBBLE_PRESETS,
  PET_BUBBLE_SCROLL_STYLE,
  buildPetTaskDisplay,
  filterPetTasks,
  groupPetTasks,
  petAgentLabel,
  petTokenStyle,
  rankPetTasks,
  resolvePetBubbleLayout,
  type PetBubbleLayout,
} from './pet-bubble-layout'

function task(
  state: PetTaskState,
  options: { agentId?: string; sessionId?: string; updatedAt?: number; runId?: string } = {},
): PetTaskProjection {
  const key: PetTaskKey = {
    agentId: options.agentId ?? 'memory',
    profileId: 'default',
    runtimeEpoch: 'epoch-1',
    vaultId: 'memoir://demo',
    sessionId: options.sessionId ?? 'session-1',
    runId: options.runId ?? 'run-1',
  }
  return {
    key,
    state,
    permissionRequestId: state === 'waiting-input' ? 'req-1' : null,
    updatedAt: options.updatedAt ?? 1_000,
  }
}

/** Of the tasks a display holds, which are they — named by session, which the fixture controls. */
function sessions(display: { groups: { tasks: PetTaskProjection[] }[] }): string[] {
  return display.groups.flatMap((group) => group.tasks.map((one) => one.key.sessionId))
}

function layout(input: Partial<PetBubbleLayout> = {}): PetBubbleLayout {
  return { ...PET_BUBBLE_LAYOUT_DEFAULTS, ...input }
}

describe('the layout settings', () => {
  it('states a default for every field rather than leaving the component to invent one', () => {
    const resolved = resolvePetBubbleLayout()

    expect(resolved.mode).toBe('list')
    expect(resolved.grouping).toBe('by-agent')
    expect(resolved.filter).toBe('all')
    expect(resolved.maxTasks).toBeGreaterThan(0)
    expect(resolved.tokens.length).toBeGreaterThan(0)
    // Every token the model knows, in an order, with each one saying whether it is on: the same
    // shape upstream's `ap_bub_tokens` had (`windows/src/bubble.ts:13-49`).
    expect(resolved.tokens.map((item) => item.token)).toContain('message')
    expect(resolved.tokens.every((item) => typeof item.visible === 'boolean')).toBe(true)
  })

  it('keeps what it understands and replaces what it does not, field by field', () => {
    // A stored `maxTasks` is a number from a settings record, which is exactly where a `"7"`, a
    // `0` or a `NaN` comes from — the reason `readPetNumber` exists in the contract (D1).
    const resolved = resolvePetBubbleLayout({
      // The cast is the test: these are the values a damaged or hand-edited record holds.
      mode: 'carousel-that-never-was' as PetBubbleLayout['mode'],
      maxTasks: 0,
      separator: 42 as unknown as string,
      filter: 'working',
    })

    expect(resolved.mode).toBe(PET_BUBBLE_LAYOUT_DEFAULTS.mode)
    expect(resolved.maxTasks).toBe(PET_BUBBLE_LAYOUT_DEFAULTS.maxTasks)
    expect(resolved.separator).toBe(PET_BUBBLE_LAYOUT_DEFAULTS.separator)
    expect(resolved.filter).toBe('working')
  })

  it('caps the cap, so a stored number cannot ask for a thousand rows in a 300px window', () => {
    expect(resolvePetBubbleLayout({ maxTasks: 999 }).maxTasks).toBeLessThanOrEqual(10)
    expect(resolvePetBubbleLayout({ maxTasks: 2.5 }).maxTasks).toBe(PET_BUBBLE_LAYOUT_DEFAULTS.maxTasks)
  })

  it('drops a token it does not know and keeps the rest in the order it was given', () => {
    const resolved = resolvePetBubbleLayout({
      tokens: [
        { token: 'message', visible: true },
        { token: 'hologram' as never, visible: true },
        { token: 'elapsed', visible: true },
      ],
    })

    expect(resolved.tokens).toEqual([
      { token: 'message', visible: true },
      { token: 'elapsed', visible: true },
    ])
  })

  it('falls back to a preset when the stored token list is unusable, rather than showing empty rows', () => {
    expect(resolvePetBubbleLayout({ tokens: [] }).tokens).toEqual(PET_BUBBLE_PRESETS.standard)
    expect(
      resolvePetBubbleLayout({ tokens: [{ token: 'nope' as never, visible: true }] }).tokens,
    ).toEqual(PET_BUBBLE_PRESETS.standard)
  })
})

describe('which tasks the bubble shows', () => {
  it('filters by what the pet is doing about them, not by spelling', () => {
    const all = [
      task('working', { sessionId: 'w' }),
      task('waiting-input', { sessionId: 'a' }),
      task('turn-finished', { sessionId: 'd' }),
      task('failed', { sessionId: 'f' }),
      task('cancelled', { sessionId: 'c' }),
    ]

    expect(filterPetTasks(all, 'all').map((one) => one.key.sessionId)).toEqual([
      'w',
      'a',
      'd',
      'f',
      'c',
    ])
    expect(filterPetTasks(all, 'working').map((one) => one.key.sessionId)).toEqual(['w'])
    expect(filterPetTasks(all, 'active').map((one) => one.key.sessionId)).toEqual(['w', 'a'])
    // The alert table decides this one, so "attention" cannot come to mean something else here.
    expect(filterPetTasks(all, 'attention').map((one) => one.key.sessionId)).toEqual(['a', 'f'])
  })

  it('puts what the user is being asked for above what is merely busy', () => {
    // §3.1.3, asserted directly. The working run is newer, and upstream's ranking would still bury
    // the waiting one; §6.2's whole point is that a permission request is the thing the user has
    // to act on, so recency does not get to decide this.
    const ranked = rankPetTasks([
      task('working', { sessionId: 'busy', updatedAt: 5_000 }),
      task('waiting-input', { sessionId: 'needs-you', updatedAt: 1_000 }),
    ])

    expect(ranked.map((one) => one.key.sessionId)).toEqual(['needs-you', 'busy'])
  })

  it('orders the four kinds of ending by what they need from the user, and works outranks a finished turn', () => {
    const ranked = rankPetTasks([
      task('cancelled', { sessionId: 'cancelled', updatedAt: 4_000 }),
      task('turn-finished', { sessionId: 'finished', updatedAt: 4_000 }),
      task('refused', { sessionId: 'refused', updatedAt: 1_000 }),
      task('working', { sessionId: 'working', updatedAt: 1_000 }),
      task('interrupted', { sessionId: 'interrupted', updatedAt: 1_000 }),
    ])

    // §6.3: 待授权/失败等需关注状态，再工作，再短暂完成. A cancellation is neither: it is the
    // quietest ending there is and sorts last.
    expect(ranked.map((one) => one.key.sessionId)).toEqual([
      'refused',
      'interrupted',
      'working',
      'finished',
      'cancelled',
    ])
  })

  it('breaks ties by the most recent event, so the newest thing the pet did is nearest the top', () => {
    const ranked = rankPetTasks([
      task('working', { sessionId: 'older', updatedAt: 1_000 }),
      task('working', { sessionId: 'newer', updatedAt: 9_000 }),
    ])

    expect(ranked.map((one) => one.key.sessionId)).toEqual(['newer', 'older'])
  })

  it('is consistent with the contract’s own alert table', () => {
    // The drift guard. `PET_ALERT_BY_STATE` (D1) is where "this state needs the user" is decided;
    // this file ranks by urgency. A new state whose alert says attention but whose rank says
    // nothing special would be a state the pet announces and then hides in the fold.
    const states = [...PET_TASK_STATES]
    const urgent = states.filter((state) => PET_ALERT_BY_STATE[state] === 'needs-attention')
    const rest = states.filter((state) => PET_ALERT_BY_STATE[state] !== 'needs-attention')

    expect(urgent.length).toBeGreaterThan(0)
    for (const needs of urgent) {
      for (const other of rest) {
        expect(PET_TASK_URGENCY[needs], `${needs} needs attention and must sort above ${other}`)
          .toBeLessThan(PET_TASK_URGENCY[other])
      }
    }
    // §6.3's order for the rest: 再工作，再短暂完成. A cancellation is the quietest ending there is.
    expect(PET_TASK_URGENCY.working).toBeLessThan(PET_TASK_URGENCY['turn-finished'])
    expect(PET_TASK_URGENCY['turn-finished']).toBeLessThan(PET_TASK_URGENCY.cancelled)
    expect(Object.keys(PET_TASK_URGENCY).sort()).toEqual([...states].sort())
  })

  it('keeps every task of one agent together, ordered by what the agent needs', () => {
    const grouped = groupPetTasks(
      rankPetTasks([
        task('working', { agentId: 'memory', sessionId: 'm-working', updatedAt: 9_000 }),
        task('waiting-input', { agentId: 'opencode', sessionId: 'o-waiting', updatedAt: 1_000 }),
      ]),
      'by-agent',
    )

    // The agent that needs something comes first, which is the same correction as the ranking —
    // ordering by agent name instead would put the waiting run of the second agent in row three.
    expect(grouped.map((group) => group.agentId)).toEqual(['opencode', 'memory'])
    expect(grouped[0]?.tasks.map((one) => one.key.sessionId)).toEqual(['o-waiting'])
  })

  it('has no heading when it is flat, and one heading per agent when it is not', () => {
    const tasks = [
      task('working', { agentId: 'memory', sessionId: 'm1' }),
      task('working', { agentId: 'memory', sessionId: 'm2' }),
      task('failed', { agentId: 'opencode', sessionId: 'o1' }),
    ]

    const flat = groupPetTasks(tasks, 'flat')
    expect(flat).toHaveLength(1)
    expect(flat[0]?.agentId).toBeNull()
    expect(flat[0]?.label).toBeNull()
    expect(flat[0]?.tasks).toHaveLength(3)

    // Grouping keeps the order it is given, so the *display* is what has to rank first — and it
    // does: the agent with the failed run heads the list even though its task arrived last.
    const display = buildPetTaskDisplay(tasks, layout({ grouping: 'by-agent' }))
    expect(display.groups.map((group) => group.agentId)).toEqual(['opencode', 'memory'])
    expect(display.groups.map((group) => group.tasks.length)).toEqual([1, 2])
  })

  it('never hides a task that needs the user behind the cap', () => {
    const many = [
      task('working', { sessionId: 'w1', updatedAt: 9_000 }),
      task('working', { sessionId: 'w2', updatedAt: 8_000 }),
      task('working', { sessionId: 'w3', updatedAt: 7_000 }),
      task('working', { sessionId: 'w4', updatedAt: 6_000 }),
      task('working', { sessionId: 'w5', updatedAt: 5_000 }),
      // The oldest event of all, and the one the user is actually being asked for.
      task('waiting-input', { sessionId: 'needs-you', updatedAt: 1_000 }),
    ]

    const display = buildPetTaskDisplay(many, layout({ maxTasks: 2 }))

    expect(display.total).toBe(6)
    expect(display.hidden).toBe(4)
    expect(sessions(display)).toEqual(['needs-you', 'w1'])
  })

  it('counts what it did not show, in every mode', () => {
    const many = [
      task('working', { sessionId: 'a' }),
      task('working', { sessionId: 'b' }),
      task('working', { sessionId: 'c' }),
    ]

    for (const mode of ['list', 'compact', 'carousel'] as const) {
      const display = buildPetTaskDisplay(many, layout({ mode, maxTasks: 1 }))
      expect(display.hidden, mode).toBe(2)
      expect(sessions(display), mode).toHaveLength(1)
    }
  })

  it('pages in carousel mode, clamps past the end, and keeps the page out of the other modes', () => {
    const many = [
      task('working', { sessionId: 'w1', updatedAt: 5_000 }),
      task('working', { sessionId: 'w2', updatedAt: 4_000 }),
      task('working', { sessionId: 'w3', updatedAt: 3_000 }),
      task('working', { sessionId: 'w4', updatedAt: 2_000 }),
      task('waiting-input', { sessionId: 'needs-you', updatedAt: 1_000 }),
    ]
    const carousel = layout({ mode: 'carousel', maxTasks: 2 })

    const first = buildPetTaskDisplay(many, carousel)
    expect(first.pages).toBe(3)
    expect(first.page).toBe(0)
    // The page is cut after the ranking, so the first page is where the waiting task is — and a
    // carousel that paged in arrival order would have put it last, one dot-click away.
    expect(sessions(first)).toEqual(['needs-you', 'w1'])

    const middle = buildPetTaskDisplay(many, carousel, 1)
    expect(sessions(middle)).toEqual(['w2', 'w3'])
    expect(middle.hidden).toBe(3)

    // The list shrank under the pointer: a dot for a page that is no longer there still shows the
    // last page rather than an empty surface.
    const past = buildPetTaskDisplay(many, carousel, 9)
    expect(past.page).toBe(2)
    expect(sessions(past)).toEqual(['w4'])

    // Every other mode shows the first page: a browser that remembered a dot must not open a list
    // scrolled to the middle of a list the user has never paged.
    expect(buildPetTaskDisplay(many, layout({ maxTasks: 2 }), 2).page).toBe(0)
  })

  it('shows nothing rather than a stale row when the filter excludes everything', () => {
    const display = buildPetTaskDisplay([task('turn-finished')], layout({ filter: 'working' }))

    expect(display.groups).toEqual([])
    expect(display.total).toBe(0)
    expect(display.hidden).toBe(0)
  })
})

describe('the words a row is labelled with', () => {
  it('falls back to the agent id itself for an engine it has never heard of', () => {
    // §5.2: 从当前 Agent 注册表生成列表，兼容未知 Agent，不固定上游名单. Upstream returns the
    // string "Agent" for anything outside its eight hard-coded kinds (`state.ts:154-167`), which
    // turns "which engine is this?" — the one thing a multi-agent row has to answer — into a guess.
    expect(petAgentLabel('opencode')).toBe('opencode')
    expect(petAgentLabel('some-new-engine')).toBe('some-new-engine')
    expect(petAgentLabel('some-new-engine')).not.toBe('Agent')
    // A registry, when the composition has one, is a lookup and not a list compiled in here.
    expect(petAgentLabel('opencode', { opencode: 'OpenCode' })).toBe('OpenCode')
  })
})

describe('the wrapping the acceptance names', () => {
  it('gives the message room to break anywhere, which is what Chinese and long ids both need', () => {
    const message = petTokenStyle('message')

    // Chinese has no spaces: a break opportunity between ideographs is what stops a sentence from
    // running out of the bubble. `anywhere` is the same permission for the other half of the
    // problem — a path, a session id or a URL inside that sentence, which has no break in it at all.
    expect(message.overflowWrap).toBe('anywhere')
    expect(message.wordBreak).toBe('break-word')
    // And the flex item has to be allowed to shrink below its content: a flex child's automatic
    // minimum size is its min-content width, so without this the row grows and the bubble widens
    // past its cap instead of the text wrapping inside it.
    expect(message.minWidth).toBe(0)
    expect(message.whiteSpace).not.toBe('nowrap')
  })

  it('pins the fields whose content is a word from a fixed list', () => {
    // Four tokens whose content this build chooses: a dot with no text, one or two separator
    // characters, a state label out of `PET_STATE_LABELS`, and a duration out of `petElapsed`.
    // None of them can be longer than a few characters, so none of them needs a break opportunity —
    // and keeping them at their own size is what lets the message be the field that gives way.
    for (const token of ['dot', 'separator', 'stateLabel', 'elapsed'] as const) {
      expect(petTokenStyle(token).flex, token).toBe('0 0 auto')
      expect(petTokenStyle(token).whiteSpace, token).toBe('nowrap')
    }
  })

  it('lets the two fields that carry an *identifier* break, because an identifier is as long as it is', () => {
    // `agent` is an engine id (§5.2: an engine nobody has heard of is shown as itself) and `session`
    // is an ACP session id — a 36-character uuid, which in the row's 11px monospace is wider than
    // the 260px bubble on its own. `nowrap` plus `flex: 0 0 auto` is a field that cannot shrink and
    // cannot break, so the row overflowed the surface and the id was simply unreadable: measured in
    // Chromium at a 320px character (a 420px window), the scrolling box came out 258 against a
    // 242px client width and the `session` field reached 16px past its own row.
    for (const token of ['agent', 'session'] as const) {
      const style = petTokenStyle(token)
      expect(style.whiteSpace, token).not.toBe('nowrap')
      expect(style.overflowWrap, token).toBe('anywhere')
      // Shrinkable *and* shrinkable to nothing: the automatic minimum size of a flex item is its
      // min-content width, which for an unbreakable id is the whole id. `0 1 auto` lets the row's
      // wrap run first (the hypothetical size is the id's max-content) and then lets the field give
      // the last few pixels back instead of overflowing them.
      expect(style.flex, token).toBe('0 1 auto')
      expect(style.minWidth, token).toBe(0)
    }
  })

  it('is no wider than the window it is drawn in', () => {
    // 260 is `window_host::CHARACTER_WINDOW_MIN_WIDTH` — the number is written here rather than read
    // from the Rust file because the two languages meet at a test, and the meeting is on the Rust
    // side: `desktop_pet_ipc_test`'s `the_bubble_fits_the_window_it_is_drawn_in` reads this
    // constant out of the layout service and fails when the pair drifts. What this holds is that
    // the constant stays a width a bubble could plausibly have — an integer, not a stray 0.
    //
    // A literal, and deliberately: a test that compared the constant with itself would pass for
    // every value, which is how the old 280 (chosen against upstream's 300px popover window, a
    // surface this bubble is not in) survived a fix that was about the bubble's own geometry.
    expect(PET_BUBBLE_MAX_WIDTH).toBe(260)
  })

  it('bounds the height in the window’s own units, and hands the scroll to the surface', () => {
    // The second axis of 气泡不越屏, and the one D13 measured (six rows, 561px, clipped by a window
    // sized for a sprite). A height in pixels would be a number this surface has no standing to
    // choose — §7.1 gives the window and its size to the host — so the cap is a fraction of that
    // window, with an absolute ceiling for a window taller than any bubble should be.
    expect(PET_BUBBLE_MAX_HEIGHT).toContain('vh')
    expect(PET_BUBBLE_MAX_HEIGHT).toContain('min(')
    expect(PET_BUBBLE_SCROLL_STYLE.maxHeight).toBe(PET_BUBBLE_MAX_HEIGHT)
    expect(PET_BUBBLE_SCROLL_STYLE.overflowY).toBe('auto')
  })

  it('is the box that gives the room back, so the character keeps its own', () => {
    // The cap above is written against the *window*; the room this box has is the window minus the
    // character minus the column's gap, which is 136px at every size the character slider offers
    // (`window_host::CHARACTER_WINDOW_SLACK`'s 140px of height, less `.pet-root`'s 4px gap). The cap
    // is the larger of the two from the schema's default size upward, so the page cannot satisfy it
    // by capping: something has to *shrink*, and the only item in the column that may is this one.
    //
    // `flex: 1 1 auto` is the grow/shrink half and `minHeight: 0` is the load-bearing one — a flex
    // item's automatic minimum size is its content, so without it the box refuses to shrink and the
    // surface pushes the character out of the window instead (measured before this line existed:
    // 28.5px past the bottom edge at a 160px character, 100.5px at 320 — Chromium,
    // `e2e/desktop-pet-window-fit.spec.ts`).
    //
    // Inline, and here, for the reason `PET_BUBBLE_MESSAGE_STYLE` gives: the test environment
    // injects no SFC styles, so a bound that only a stylesheet can see is a bound no test holds.
    expect(PET_BUBBLE_SCROLL_STYLE.flex).toBe('1 1 auto')
    expect(PET_BUBBLE_SCROLL_STYLE.minHeight).toBe(0)
  })
})
