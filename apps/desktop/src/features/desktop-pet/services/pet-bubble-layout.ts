/**
 * The bubble's content model: what a row is made of, which tasks it shows, and in what order.
 *
 * Ported from `windows/src/bubble.ts` — the token presets (13-49), the filter/sort/group/cap step
 * (`groupSessions`, 129-160) and the per-row token order — with three things changed, each of them
 * a rule the plan names rather than a preference:
 *
 *  - **Attention sorts first.** Upstream's `RANK` puts `working` above `waiting` (`state.ts:43`,
 *    `bubble.ts:124`), which §3.1.3 corrects outright: 「待授权必须可见，不能被另一项工作无限遮住」.
 *    {@link PET_TASK_URGENCY} is that correction, and it is checked against the contract's own
 *    {@link PET_ALERT_BY_STATE} so a state cannot be announced as needing the user and then ranked
 *    as if it did not.
 *  - **The cap reports what it hid.** Upstream slices and forgets; a list that quietly drops its
 *    last two rows is indistinguishable from a list that had two rows. Every display carries
 *    `hidden`, and the ranking is what makes the cap safe: what falls off the end is always the
 *    least urgent.
 *  - **No agent name is compiled in.** Upstream's `agentLabel` knows eight engines and answers
 *    "Agent" for everything else (`state.ts:154-167`); §5.2 requires the list to come from the
 *    current registry and to stay compatible with engines it has never heard of, so an unknown id
 *    is shown as itself. "Which engine is this?" is the one question a multi-agent row has to
 *    answer, and a generic word is the one answer that does not.
 *
 * The token vocabulary is upstream's, minus the ones this window has no data for. Upstream's
 * `icon` and `title` come from a per-agent brand asset and from the transcript, and §6.1 forbids
 * sending transcript content to this window; the row's fields are therefore the ones a
 * `PetTaskProjection` actually carries — the identity, the state and a host clock — and upstream's
 * `project` is not among them because a project's display name is not part of the projection
 * either. `session` stands where upstream showed a project or a session id: with two tasks of one
 * engine on screen it is what tells the rows apart. (A `session`-less preset is one line away —
 * the presets below are data.)
 *
 * Nothing here reads a clock, a store or a DOM: the caller passes tasks, the layout it resolved
 * from settings, and the labels it has.
 */
import type { CSSProperties } from 'vue'
import {
  PET_ALERT_BY_STATE,
  petTaskToken,
  readPetNumber,
  type PetBubbleSeparator,
  type PetTaskProjection,
  type PetTaskState,
} from '../../../platform/gateways/pet-contracts'

/** One field a row can show, in the order the user arranged them (upstream `BubbleToken`). */
export const PET_BUBBLE_TOKENS = [
  /** The state, as a coloured dot. */
  'dot',
  /** Which engine this task belongs to. */
  'agent',
  /** Which of that engine's tasks this is. */
  'session',
  /** Between the fields; the character is the user's (upstream `ap_bub_sep`, default `·`). */
  'separator',
  /** What the pet says about the task. */
  'message',
  /** What the task *is* — never what a written phrase claims it is (§5.2). */
  'stateLabel',
  /** How long since the host last changed it. */
  'elapsed',
] as const

export type PetBubbleToken = (typeof PET_BUBBLE_TOKENS)[number]

export interface PetBubbleTokenItem {
  token: PetBubbleToken
  visible: boolean
}

export type PetBubblePreset = 'original' | 'standard' | 'detailed'

/**
 * The three field presets, ported from upstream's `LAYOUT_PRESETS` (18-49) over this row's fields.
 *
 * `original` is the narrowest — state, engine, what the pet says — and each step adds context:
 * which task it is, then what it *is* and how long it has been that way.
 */
export const PET_BUBBLE_PRESETS: Readonly<Record<PetBubblePreset, readonly PetBubbleTokenItem[]>> = {
  original: [
    { token: 'dot', visible: true },
    { token: 'agent', visible: true },
    { token: 'separator', visible: true },
    { token: 'message', visible: true },
    { token: 'session', visible: false },
    { token: 'stateLabel', visible: false },
    { token: 'elapsed', visible: false },
  ],
  standard: [
    { token: 'dot', visible: true },
    { token: 'agent', visible: true },
    { token: 'session', visible: true },
    { token: 'separator', visible: true },
    { token: 'message', visible: true },
    { token: 'stateLabel', visible: false },
    { token: 'elapsed', visible: false },
  ],
  detailed: [
    { token: 'dot', visible: true },
    { token: 'agent', visible: true },
    { token: 'session', visible: true },
    { token: 'separator', visible: true },
    { token: 'message', visible: true },
    { token: 'stateLabel', visible: true },
    { token: 'elapsed', visible: true },
  ],
}

/**
 * How the tasks are presented.
 *
 * `carousel` is upstream's mode with its automatic advance removed, and the removal is deliberate:
 * upstream pages every three seconds on a timer (`bubble.ts` 392-398), which is a mode that hides a
 * task the user has not answered yet — §3.1.3's requirement, on a clock. The pages are still there
 * and are still the user's to move through; nothing moves them on its own.
 */
export const PET_BUBBLE_MODES = ['list', 'compact', 'carousel'] as const
export type PetBubbleMode = (typeof PET_BUBBLE_MODES)[number]

export const PET_BUBBLE_GROUPINGS = ['by-agent', 'flat'] as const
export type PetBubbleGrouping = (typeof PET_BUBBLE_GROUPINGS)[number]

/**
 * What the bubble leaves out.
 *
 * `attention` and `active` are computed from the state's own alert rather than from a list of
 * states, so they keep meaning what they say when the vocabulary grows.
 */
export const PET_BUBBLE_FILTERS = ['all', 'attention', 'active', 'working'] as const
export type PetBubbleFilter = (typeof PET_BUBBLE_FILTERS)[number]

export interface PetBubbleLayout {
  mode: PetBubbleMode
  grouping: PetBubbleGrouping
  filter: PetBubbleFilter
  /** How many rows the surface shows. The rest are counted, never silently dropped. */
  maxTasks: number
  separator: string
  tokens: readonly PetBubbleTokenItem[]
}

/** The cap's rule, in the contract's own shape so `readPetNumber` can apply it (§5.3). */
const MAX_TASKS_RULE = { min: 1, max: 10, integer: true, fallback: 5 } as const

export const PET_BUBBLE_LAYOUT_DEFAULTS: PetBubbleLayout = {
  mode: 'list',
  grouping: 'by-agent',
  filter: 'all',
  maxTasks: MAX_TASKS_RULE.fallback,
  separator: '·',
  tokens: PET_BUBBLE_PRESETS.standard,
}

/**
 * What a settings record may hold: the same shape, unchecked, from anywhere.
 *
 * `unknown` per field rather than the union each one resolves to, and that is what the sentence
 * above already meant: this is the *input* to {@link resolvePetBubbleLayout}, which reads every
 * field through its own rule, so a caller that had to hand this a `PetBubbleMode` would be a caller
 * forced to assert — which is the check this type exists to avoid writing twice. The two callers
 * are a stored record and the appearance read, and neither can promise a member.
 */
export type PetBubbleLayoutInput = Partial<{
  mode: unknown
  grouping: unknown
  filter: unknown
  maxTasks: unknown
  separator: unknown
  tokens: unknown
}>

function oneOf<T extends string>(allowed: readonly T[], raw: unknown, fallback: T): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
}

/**
 * The four separators the schema names, as the characters upstream's control offers.
 *
 * `message.separator` is stored as a *name* (`pet-contracts/config.ts`'s `PetBubbleSeparator`) while
 * the renderer wants the one character that goes between two fields, and this table is where the
 * two meet. It is here rather than on the host because it is a drawing decision: upstream's control
 * is four buttons whose values are `·`, `→`, `|` and a space
 * (`references/desktop-pet/windows/settings.html:184-189`), and which glyph stands for `bar` is
 * something this surface knows and a settings store does not.
 *
 * `space` is a real member and not an omission: an empty separator is a valid layout, and the
 * schema spells it as a word so that a stored value cannot be a blank an editor stripped.
 */
export const PET_BUBBLE_SEPARATORS: Readonly<Record<PetBubbleSeparator, string>> = {
  dot: '·',
  arrow: '→',
  bar: '|',
  space: ' ',
}

function readSeparator(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback
  // A schema member first: the names are words, and one of them (`bar`) would otherwise read as a
  // three-character literal and be refused.
  const named = (PET_BUBBLE_SEPARATORS as Readonly<Record<string, string | undefined>>)[raw]
  if (named !== undefined) return named
  const trimmed = raw.trim()
  // One or two characters: the field is a separator between row fields, and a paragraph of text
  // there is a layout the user did not ask for. Whitespace alone is not a separator at all.
  return trimmed.length === 0 || trimmed.length > 2 ? fallback : trimmed
}

function readTokens(
  raw: unknown,
  fallback: readonly PetBubbleTokenItem[],
): readonly PetBubbleTokenItem[] {
  if (!Array.isArray(raw)) return fallback
  const known = new Set<string>(PET_BUBBLE_TOKENS)
  const kept: PetBubbleTokenItem[] = []
  for (const item of raw) {
    const token = (item as PetBubbleTokenItem | null)?.token
    if (typeof token === 'string' && known.has(token)) {
      kept.push({ token: token as PetBubbleToken, visible: (item as PetBubbleTokenItem).visible !== false })
    }
  }
  // An empty row is not a layout: it is a stored list that names nothing this build knows, and a
  // row showing no fields at all is worse than the preset the user started from.
  return kept.length > 0 ? kept : fallback
}

/**
 * The layout a component renders from, with every unusable field replaced by its default.
 *
 * Field by field rather than all-or-nothing: a record with one damaged value should lose that value
 * and keep the rest, which is what §5.3 asks of a migrated store and the reason the contract has
 * `readPetNumber` in the first place.
 */
export function resolvePetBubbleLayout(input: PetBubbleLayoutInput = {}): PetBubbleLayout {
  return {
    mode: oneOf(PET_BUBBLE_MODES, input.mode, PET_BUBBLE_LAYOUT_DEFAULTS.mode),
    grouping: oneOf(PET_BUBBLE_GROUPINGS, input.grouping, PET_BUBBLE_LAYOUT_DEFAULTS.grouping),
    filter: oneOf(PET_BUBBLE_FILTERS, input.filter, PET_BUBBLE_LAYOUT_DEFAULTS.filter),
    maxTasks: readPetNumber(input.maxTasks, MAX_TASKS_RULE),
    separator: readSeparator(input.separator, PET_BUBBLE_LAYOUT_DEFAULTS.separator),
    tokens: readTokens(input.tokens, PET_BUBBLE_LAYOUT_DEFAULTS.tokens),
  }
}

/**
 * What the pet does about each state, as a sort key: low sorts nearer the top.
 *
 * Total over the union, so a new state has to decide where it belongs. The five `needs-attention`
 * entries are ordered by what the user can do about them — one is waiting for an answer right now,
 * the next two are endings the user decides on, and the last two describe a host that cannot help.
 */
export const PET_TASK_URGENCY: { [S in PetTaskState]: number } = {
  'waiting-input': 0,
  refused: 1,
  failed: 2,
  stopped: 3,
  interrupted: 4,
  unknown: 5,
  working: 6,
  'turn-finished': 7,
  cancelled: 8,
}

function keepsTask(filter: PetBubbleFilter, task: PetTaskProjection): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'attention':
      return PET_ALERT_BY_STATE[task.state] === 'needs-attention'
    case 'active':
      return task.state === 'working' || task.state === 'waiting-input'
    case 'working':
      return task.state === 'working'
  }
}

/** The tasks the filter keeps, in the order they arrived. Ranking is {@link rankPetTasks}'s job. */
export function filterPetTasks(
  tasks: readonly PetTaskProjection[],
  filter: PetBubbleFilter,
): PetTaskProjection[] {
  return tasks.filter((task) => keepsTask(filter, task))
}

/**
 * Most urgent first, then most recently changed, then by task key.
 *
 * The last tiebreak is what makes the order a total one: two tasks of the same state settled in
 * the same millisecond would otherwise swap places between renders, and a list that reorders while
 * the user is reaching for a row is a list where clicking the same row twice can hit two tasks.
 */
export function rankPetTasks(tasks: readonly PetTaskProjection[]): PetTaskProjection[] {
  return [...tasks].sort((a, b) => {
    const urgency = PET_TASK_URGENCY[a.state] - PET_TASK_URGENCY[b.state]
    if (urgency !== 0) return urgency
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
    const left = petTaskToken(a.key)
    const right = petTaskToken(b.key)
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/** One agent's rows, or the whole list when there is no heading to draw. */
export interface PetTaskGroup {
  /** null when the layout is flat: there is no agent this heading would name. */
  agentId: string | null
  /** The heading's text; null for a flat list, which has nothing to head. */
  label: string | null
  tasks: PetTaskProjection[]
}

/**
 * The engine's name for humans, or the id itself when no registry knows it (§5.2).
 *
 * `labels` is the current agent registry, passed in rather than looked up, because a registry this
 * file could reach would be a list compiled in — the thing §5.2 forbids.
 */
export function petAgentLabel(
  agentId: string,
  labels?: Readonly<Record<string, string>>,
): string {
  const written = labels?.[agentId]
  return written && written.trim() ? written : agentId
}

/**
 * Tasks gathered under their agent, in the order they arrived.
 *
 * The caller ranks first (`buildPetTaskDisplay` does), so a group's position is its most urgent
 * task's position and an agent waiting for an answer is not sorted below an agent that is merely
 * busy. Grouping here is a *heading*, not a fold: every task keeps its own row, because a row that
 * stands for three tasks cannot be clicked to one of them (§6.3's 多任务列表持续显示每个任务).
 */
export function groupPetTasks(
  tasks: readonly PetTaskProjection[],
  grouping: PetBubbleGrouping,
  agentLabels?: Readonly<Record<string, string>>,
): PetTaskGroup[] {
  if (grouping === 'flat') return [{ agentId: null, label: null, tasks: [...tasks] }]

  const byAgent = new Map<string, PetTaskProjection[]>()
  for (const task of tasks) {
    const rows = byAgent.get(task.key.agentId)
    if (rows) rows.push(task)
    else byAgent.set(task.key.agentId, [task])
  }
  return [...byAgent].map(([agentId, rows]) => ({
    agentId,
    label: petAgentLabel(agentId, agentLabels),
    tasks: rows,
  }))
}

/** What a surface renders: the rows, and the count of the ones it does not show. */
export interface PetTaskDisplay {
  groups: PetTaskGroup[]
  /** How many tasks the filter kept, across every page. */
  total: number
  /** How many of those this page does not show. Never silently included in `total`. */
  hidden: number
  /** How many pages the ranked list divides into at this cap. 1 outside `carousel`. */
  pages: number
  /** The page actually rendered, 0-based, after clamping. Carousel dots read this, not the request. */
  page: number
}

/**
 * Filter, rank, page, group — in that order, and the order is the whole point: the page is cut
 * after the ranking, so what is left for later pages is always the least urgent, and a task the
 * user is being asked about is on the first one.
 *
 * `page` is only meaningful in `carousel` mode, where the surface shows one page at a time; every
 * other mode shows the first. A page past the end clamps to the last one rather than rendering an
 * empty surface: the list shrinks under the pointer when a run ends, and a dot the user clicked
 * while it was the last one must not turn the bubble blank.
 */
export function buildPetTaskDisplay(
  tasks: readonly PetTaskProjection[],
  layout: PetBubbleLayout,
  page = 0,
  agentLabels?: Readonly<Record<string, string>>,
): PetTaskDisplay {
  const ranked = rankPetTasks(filterPetTasks(tasks, layout.filter))
  // One page, or one page at a time. A list that honored a page number would be a list whose tail
  // is unreachable — there is no dot to click in `list` mode — and `hidden` would then be counting
  // rows nobody can get to.
  const pages = layout.mode === 'carousel' ? Math.max(1, Math.ceil(ranked.length / layout.maxTasks)) : 1
  const current = layout.mode === 'carousel' ? Math.min(Math.max(0, Math.floor(page)), pages - 1) : 0
  const shown = ranked.slice(current * layout.maxTasks, (current + 1) * layout.maxTasks)
  return {
    groups: groupPetTasks(shown, layout.grouping, agentLabels),
    total: ranked.length,
    hidden: ranked.length - shown.length,
    pages,
    page: current,
  }
}

/**
 * How many rows compact mode previews before the fold (upstream's `groups.slice(0, 2)`,
 * `bubble.ts:463`). The fold opens to the layout's cap and no further, so the preview is a view
 * of the same list rather than a second cap that could disagree with it.
 */
export const PET_BUBBLE_COMPACT_PREVIEW = 2

/**
 * What the message field is allowed to do: wrap, wherever the text needs to break.
 *
 * `anywhere` is for the two kinds of run that have no spaces in them — a Chinese sentence, whose
 * break opportunities are between ideographs rather than at spaces, and the Latin path, id or URL
 * that appears inside one. `minWidth: 0` is the flexbox half of the same problem: a flex item's
 * automatic minimum size is its min-content width, so without it the row grows and the bubble
 * widens past its cap instead of the text wrapping inside it. The bubble is a small surface with
 * no scrollbar, so an overflowing row is simply not readable.
 *
 * Declared here rather than only in a stylesheet because this is the acceptance the port is judged
 * on — 长中文 — and a rule that exists only as CSS is a rule no unit test can see (the test
 * environment injects no SFC styles), which is how wrapping becomes an afterthought.
 */
export const PET_BUBBLE_MESSAGE_STYLE: CSSProperties = {
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
  whiteSpace: 'normal',
  minWidth: 0,
  flex: '1 1 auto',
}

/**
 * The fields whose content is a word from a list this build owns: `dot` (no text at all),
 * `separator` (one or two characters, capped by {@link readSeparator}), `stateLabel` (out of
 * `PET_STATE_LABELS`) and `elapsed` (out of `petElapsed`). They keep their size and never break,
 * and that is what leaves the message as the field that gives way.
 */
export const PET_BUBBLE_FIXED_TOKEN_STYLE: CSSProperties = {
  flex: '0 0 auto',
  whiteSpace: 'nowrap',
}

/**
 * The fields whose content is an **identifier**: `session` (an ACP session id) and `agent` (an
 * engine id, which §5.2 requires to be shown as itself for an engine this build has never heard
 * of). An identifier is as long as it is, and neither of the two is bounded by anything this build
 * chooses.
 *
 * **This style is the fix for a measured overflow.** Both fields used to take
 * {@link PET_BUBBLE_FIXED_TOKEN_STYLE}, which is `flex: 0 0 auto` + `nowrap` — a field that can
 * neither shrink nor break. A 36-character uuid in the row's 11px monospace is wider than the
 * 260px bubble on its own, so the row ran past the surface that holds it: measured in Chromium
 * (Playwright, the product's own root in the page's own mount point, a 320px character in the 420px
 * window the host builds) the scrolling box came out **258 against a 242px client width**, and the
 * `session` field reached **16px past its own row**. The fixtures all used ids like
 * `shared-session`, which is why no assertion had ever seen it.
 *
 * Wrapping rather than an ellipsis, and the reason is the row's own job: §6.1's identity is what
 * tells two rows of one engine apart, and a truncated id is a weaker answer to that than a wrapped
 * one. It is also the treatment `PET_BUBBLE_MESSAGE_STYLE` already gives the same kind of string —
 * that constant names 「a session id」 as one of the two runs with no break opportunity in it.
 *
 * `flex: 0 1 auto` and `min-width: 0` are the half that makes it hold. The row is
 * `flex-wrap: wrap`, and line breaking uses each item's *hypothetical* main size — the id's
 * max-content width — so a long id moves to a line of its own before anything shrinks. On that line
 * it is the only item, and what is left is the few pixels of overhang, which `flex-shrink` gives
 * back. Without `min-width: 0` the automatic minimum size would be the id's min-content width (the
 * whole id, since it has no break opportunity *until* this rule's `overflow-wrap`) and the field
 * would refuse to shrink at all.
 */
export const PET_BUBBLE_ID_STYLE: CSSProperties = {
  flex: '0 1 auto',
  minWidth: 0,
  whiteSpace: 'normal',
  overflowWrap: 'anywhere',
  wordBreak: 'break-word',
}

/**
 * What one field draws with: the message gives way, the identifiers break when they must, and the
 * fixed-vocabulary fields keep their size.
 */
export function petTokenStyle(token: PetBubbleToken): CSSProperties {
  if (token === 'message') return PET_BUBBLE_MESSAGE_STYLE
  if (token === 'session' || token === 'agent') return PET_BUBBLE_ID_STYLE
  return PET_BUBBLE_FIXED_TOKEN_STYLE
}

/**
 * One field of one row, resolved: which field it is and the text it shows.
 *
 * The seam between the two halves of a row — the list resolves the text (it has the phrases, the
 * clock and the state labels) and `PetTaskRow.vue` draws it. A field is a token and a string and
 * nothing else, so the row cannot reach a task, a gateway or a clock even by accident.
 */
export interface PetRowField {
  token: PetBubbleToken
  text: string
}

/**
 * The bubble's widest row: **the width of the window the bubble is drawn in**, not a number of its
 * own choosing.
 *
 * It was 280, and the reason written beside it compared it to the wrong surface — upstream's
 * 300px *popover* (`windows/src/popover.ts:170`), which is a window of its own (`popover.html`,
 * the menu-bar panel) and not this bubble's container. Upstream's bubble is `.bubble` inside
 * `index.html` — 「The bubble sits above the sprite」, `#pet-root`, a column — and its own rule is
 * `max-width: 260px` (styles.css:43), which is exactly the character window's width. Two hundred
 * and eighty is greater than two hundred and sixty, and the pair had never been compared.
 *
 * The window wins because it is the frame: a webview cannot paint outside its own window, so a
 * bubble wider than the window is not an overhanging bubble, it is a clipped one — and a clipped
 * bubble cannot be clicked, which is how D13 found the height half of this (task-183, finding 7).
 * §7.1 gives the window and its size to the host; a surface that asked for more than the host
 * grants would be asking for something no compositor can give it.
 *
 * The number is `window_host::CHARACTER_WINDOW_MIN_WIDTH` (260.0) — the floor the character
 * window's *width* never goes below, whatever the character's size setting says — and that pairing
 * is held by tests rather than by this sentence: `desktop_pet_ipc_test`'s
 * `the_bubble_fits_the_window_it_is_drawn_in` reads this constant out of this file, and
 * `desktop_pet_settings_test`'s `the_window_is_never_narrower_than_the_bubble_it_draws` reads it
 * too and walks every size the slider offers. Either fails when the pair drifts.
 */
export const PET_BUBBLE_MAX_WIDTH = 260

/**
 * How tall the box that scrolls may get: an absolute ceiling, and a fraction of the window.
 *
 * D13 measured what this answers: six rows of long Chinese came to **561px** in the 280px width the
 * surface capped itself at then (it is 260 now, so the same rows are taller still), and the pet
 * window — §7.1 gives that window to the character, not to the bubble — simply clipped them. A
 * number in pixels cannot be right here, because the window the bubble lands in is the host's and
 * its height follows the character's size setting (D13 swept 80, 160 and 320), so `40vh` is a term
 * that moves with the window, and the 240px ceiling is what keeps a very tall window from turning a
 * bubble into a panel.
 *
 * **It is a ceiling, and it is not the room.** The two were confused, and the confusion is the
 * defect `e2e/desktop-pet-window-fit.spec.ts` now measures. The host builds the character window as
 * the sprite's box plus a constant slack (`window_host::CHARACTER_WINDOW_SLACK`: 100px of width,
 * **140px of height**), so what is left for this surface and the column's own 4px gap is 136px at
 * *every* size the slider offers — while this bound is 128px at the schema's default window and
 * 200px at the ceiling. Measured in a real browser, at the default character size (Chromium,
 * Playwright, the page's own mount point, six runs so the list is at its bound): the rows box was
 * 128px at this cap and the surface around it 164.5px — 14px of padding and border, 128, and 22.5px
 * of reports that sit outside the scrolling box — and 164.5 + 4 + 180 is **348.5px in a 320px
 * window**, so the character's lower 28.5px were past the bottom edge of a window that does not
 * scroll. At a 320px character it was **100.5px**. The bound is therefore kept, because a window taller than the
 * host's rule must not become a panel, and the *room* is read by the layout engine instead: the
 * surface is a shrinkable flex item of `.pet-root`'s column and this box is the item that gives the
 * height back (see {@link PET_BUBBLE_SCROLL_STYLE}).
 *
 * **A bound, and not a lower row count.** The list already has a count cap, the user's own
 * (`maxTasks`), and it reports what that cap left out; a second cap derived from height would be a
 * second answer to "how many rows are there" that could disagree with the first — the shape the
 * compact fold refuses by opening only as far as the first cap. Height cannot be turned into a row
 * count without measuring layout, which this surface deliberately does not do (§7.3: no per-frame
 * layout reads) and a DOM test cannot do either. Scrolling keeps every row §6.3 requires the list
 * to keep showing — in the DOM, whole, and reachable — and the ranking decides which of them is
 * visible first: a task that needs the user is the top row, so it is never the one below the fold.
 */
export const PET_BUBBLE_MAX_HEIGHT = 'min(240px, 40vh)'

/**
 * The box that scrolls when what it holds does not fit: the height cap, and the scroll that makes
 * the rest of it reachable.
 *
 * It is applied to the element that *grows* — the rows of a list, the sentence of a one-line
 * bubble — and not to the surface around it, so that the parts which say what is on the surface
 * stay outside the fold: the count of rows the cap left out, the pager and the compact fold are all
 * under this box, and a report that had to be scrolled to would be a weaker report.
 *
 * **`flex: 1 1 auto` and `min-height: 0` are the half that reads the room.** The cap above is
 * written against the window, and the room this box actually has is the window minus the character
 * minus the column's gap — smaller than the cap whenever the character is at or above the schema's
 * default size. The surface around this box is a shrinkable flex item of that column
 * (`PetBubble.vue`'s `min-height: 0`), so the box is where the height has to come *from*: as a flex
 * item it takes exactly what is left after the surface's own padding and the reports under it, and
 * `min-height: 0` is what lets it fall below its content — the automatic minimum size of a flex item
 * is its content, and without this line the box would refuse to shrink and the whole surface would
 * instead push the character out of the window. Applied inline to both of the boxes that can grow,
 * so the two surfaces cannot drift apart.
 *
 * In the layout service rather than in the SFC styles, for the reason {@link PET_BUBBLE_MESSAGE_STYLE}
 * gives: the test environment injects no SFC styles, and a bound that only a stylesheet can see is
 * a bound no test holds on to.
 */
export const PET_BUBBLE_SCROLL_STYLE: CSSProperties = {
  maxHeight: PET_BUBBLE_MAX_HEIGHT,
  overflowY: 'auto',
  flex: '1 1 auto',
  minHeight: 0,
}
