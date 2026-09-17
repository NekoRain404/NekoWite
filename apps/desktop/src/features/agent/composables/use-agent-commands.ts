/**
 * The `/` menu's state: which commands the engine publishes for this session,
 * which of them the token being typed keeps, and what a key means while an IME
 * has a candidate list open (§13.4: state + command).
 *
 * Three things about this list are not like the palette's, and they are why it
 * gets a composable of its own rather than reusing the palette's. It arrives as
 * a notification rather than a reply — P0 §2.2 measured the engine pushing
 * `available_commands_update` after `session/new`, so the list is *received*
 * here, never fetched. It belongs to one session, so a frame from another is not
 * this menu's data (§4.1: 不把 A 库命令显示到 B 库). And each frame replaces the
 * whole list rather than adding to it, so a command that vanished from a later
 * frame has to stop being offered — a stale row is a click that fails for a
 * reason the user cannot see.
 *
 * What it deliberately does NOT do is understand a command. §4.1 executes one by
 * sending an ordinary `session/prompt` carrying `/command args`, and the app is
 * not to reimplement the engine's template interpreter, so the only strings
 * built here are the composer's own text.
 */

import { computed, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { isComposingKey } from '../../../services/key-guard'
import type {
  AgentCommand,
  AgentEvent,
  AgentFailureCode,
  AgentIdentity,
} from '../../../platform/gateways/agent-contracts'

/**
 * What the engine currently publishes for the bound session — and, when it
 * publishes nothing, which of the two kinds of nothing it is.
 *
 * `waiting` and `unavailable` are separate arms rather than one "no commands",
 * because the user's next move is different: one is worth waiting for and the
 * other is not. A named list of commands would have made them the same empty
 * array, and §4.1 asks the menu to say why it is empty rather than look the same
 * either way.
 */
export type AgentCommandListState =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'unavailable'; readonly reason: AgentFailureCode }
  | { readonly kind: 'published'; readonly commands: readonly AgentCommand[] }

/**
 * What the menu draws — one value, because "shows no rows" has four different
 * reasons and a menu that drew them alike would be asserting the wrong one.
 *
 * `empty` and `no-match` differ in what the user should do about it: one means
 * this engine has nothing to offer at all, the other means the token they are
 * typing matches nothing published. `closed` is the ordinary case — the
 * composer's text is not an unfinished `/token`.
 */
export type AgentCommandMenuView =
  | 'closed'
  | 'rows'
  | 'no-match'
  | 'empty'
  | 'waiting'
  | 'unavailable'

/**
 * What a keydown meant to the menu.
 *
 * Three outcomes rather than a boolean, because there are three audiences. The
 * menu itself, the IME, and the composer behind them — and the difference
 * between the last two is the whole point: `composing` says the key belongs to
 * the IME, so a caller whose default action is "send the prompt" has to hold
 * that too. Collapsing it into "not handled" is what makes Enter both commit a
 * candidate and send half-composed text.
 */
export type AgentCommandKeyResult = 'pass' | 'composing' | 'handled'

export interface UseAgentCommandsOptions {
  /** The session whose commands the menu may show; null before one is open. */
  identity: MaybeRefOrGetter<AgentIdentity | null>
  /** The composer's text, exactly as the user has it. */
  text: MaybeRefOrGetter<string>
  /**
   * Receives the command the user settled on — a click on a row, or Enter while
   * it is highlighted.
   *
   * What "settling on" means is the caller's: this menu inserts the name into
   * the composer rather than running anything, because §4.1 runs a command by
   * *sending* `/command args` as an ordinary prompt, and only the composer can
   * say what comes after the name.
   */
  select: (command: AgentCommand) => void
}

/**
 * Failures that mean the engine can no longer be asked anything.
 *
 * Short on purpose. A turn that was denied, cancelled or timed out ended the way
 * it was always going to end and says nothing about the list the engine already
 * published; only these say the session that list belongs to is gone, where
 * keeping the rows on offer would be offering commands nothing is listening for.
 *
 * It is a rule about *a code*, and it is applied from both directions: a frame that
 * failed a run, and a call the host refused. Those are one fact arriving over two
 * channels — the host's `AgentFailure` carries the same code a `run-failed` payload
 * does — and the menu's conclusion is the same for both.
 */
const LIST_INVALIDATING_FAILURES: readonly AgentFailureCode[] = [
  'runtime-unavailable',
  'protocol-incompatible',
  'session-stale',
  'buffer-conflict',
  'process-exited',
]

/**
 * The five identity fields as one comparable string (§6.2).
 *
 * Every one of them is load-bearing: two engines can mint the same session id,
 * a restarted runtime looks exactly like the one before it, and a frame from the
 * vault the user just left is a well-formed event from a session this menu no
 * longer shows. Comparing a session id alone would accept all three.
 *
 * NUL joins the fields because no identifier can contain one, so two different
 * identities cannot compose the same string.
 */
function identityKeyOf(identity: AgentIdentity | null): string | null {
  if (identity === null) return null
  return [
    identity.agentId,
    identity.profileId,
    identity.runtimeEpoch,
    identity.vaultId,
    identity.sessionId,
  ].join('\x00')
}

/**
 * One entry per command name, first occurrence kept.
 *
 * A menu is a list of things a click can choose, and two rows carrying one name
 * are two rows the user cannot tell apart and Enter cannot choose between — the
 * engine is addressed by that same name either way, so the second row could only
 * ever be the one that fails. The engine's own order decides which survives.
 */
function dedupeByName(commands: readonly AgentCommand[]): AgentCommand[] {
  const seen = new Set<string>()
  const unique: AgentCommand[] = []
  for (const command of commands) {
    if (seen.has(command.name)) continue
    seen.add(command.name)
    unique.push(command)
  }
  return unique
}

export function useAgentCommands(options: UseAgentCommandsOptions) {
  const list = ref<AgentCommandListState>({ kind: 'waiting' })
  const activeIndex = ref(0)

  /**
   * Whether an IME is composing, tracked from the composition events rather than
   * from `KeyboardEvent.isComposing` alone.
   *
   * The flag is not set by every engine for the keystroke that *commits* a
   * candidate, and that keystroke is precisely the one that must not run a
   * command — while the composition events are the sequence the DOM guarantees
   * for the whole episode.
   */
  const composing = ref(false)

  /** The text as it stood when the composition began; see {@link query}. */
  const composedFrom = ref<string | null>(null)

  const identityKey = computed(() => identityKeyOf(toValue(options.identity)))

  // A list belongs to the session it was published for (§4.1: the range is bound
  // to the running session). Moving to another session, or closing this one,
  // takes the list with it — so the next session's menu starts empty instead of
  // showing commands published for the one before it.
  //
  // Watching the fields rather than the object is what keeps this from firing
  // spuriously: a store that hands out a fresh handle for the same session would
  // otherwise clear a list that is still perfectly current.
  watch(identityKey, () => {
    list.value = { kind: 'waiting' }
    activeIndex.value = 0
  })

  /**
   * The unfinished command name after the leading `/`, or null when the
   * composer's text is not one.
   *
   * An unfinished name is the whole text: as soon as whitespace follows, the
   * user is typing arguments, the menu is done, and nothing here will ever look
   * at what they wrote. That is how the arguments stay unread — there is no code
   * path that takes one apart.
   */
  const query = computed<string | null>(() => {
    // While a candidate list is open the filter is the text as it was *before*
    // it opened. The pinyin letters on their way to a character are not what the
    // user is filtering by, and matching them would empty the menu under their
    // cursor and put it back a keystroke later.
    const text = composedFrom.value ?? toValue(options.text)
    if (!text.startsWith('/') || /\s/.test(text)) return null
    return text.slice(1)
  })

  const matches = computed<AgentCommand[]>(() => {
    const state = list.value
    if (state.kind !== 'published') return []
    const typed = query.value
    if (typed === null) return []
    const needle = typed.toLowerCase()
    // The engine's order is kept. Re-ranking by where the match sits would be
    // the app expressing a preference the engine never expressed, and this list
    // is the engine's to order.
    return state.commands.filter((command) => command.name.toLowerCase().includes(needle))
  })

  const view = computed<AgentCommandMenuView>(() => {
    if (query.value === null) return 'closed'
    const state = list.value
    if (state.kind === 'waiting') return 'waiting'
    if (state.kind === 'unavailable') return 'unavailable'
    // Published. An empty list is the engine having nothing to offer, which is
    // not the same as a token that matched none of what it did offer.
    if (state.commands.length === 0) return 'empty'
    return matches.value.length > 0 ? 'rows' : 'no-match'
  })

  /** The failure behind an `unavailable` list, for whoever has the wording. */
  const reason = computed<AgentFailureCode | null>(() =>
    list.value.kind === 'unavailable' ? list.value.reason : null,
  )

  const activeCommand = computed<AgentCommand | null>(() => matches.value[activeIndex.value] ?? null)

  function move(delta: number): void {
    const count = matches.value.length
    if (count === 0) return
    activeIndex.value = (activeIndex.value + delta + count) % count
  }

  function setActive(index: number): void {
    activeIndex.value = index
  }

  // The highlight follows the list it points into: a replacement frame, or a
  // keystroke that drops rows, would otherwise leave it on a row that is gone —
  // or on a different command than the one the user was looking at.
  watch([query, () => list.value], () => {
    activeIndex.value = 0
  })

  /**
   * Take one host event, and keep the list in step with it.
   *
   * Frames for another session are dropped rather than rendered: they are the
   * same event this menu handles, arriving for a list that is not its own.
   */
  function accept(event: AgentEvent): void {
    const bound = toValue(options.identity)
    if (bound === null || identityKeyOf(event) !== identityKeyOf(bound)) return

    if (event.kind === 'commands-changed') {
      // Wholesale, not appended: this frame is the engine's complete list, so a
      // command it no longer mentions is not offered any more. The protocol
      // states no such guarantee — the spec only says commands may be removed
      // when no longer relevant — so replacement is this host's reading of it,
      // and the alternative (an additive frame) would show the two behaviours
      // apart as stale rows, which is the failure this line is here to prevent.
      list.value = { kind: 'published', commands: dedupeByName(event.payload.commands) }
      return
    }

    if (event.kind === 'run-failed') invalidate(event.payload.code)
  }

  /**
   * Tell the menu that the conversation its rows belong to is gone.
   *
   * The second way in, and it is the same rule: a call the host refused carries the code a failed
   * run does, and for the codes above that refusal is the host saying it cannot reach this session
   * at all. The rows go, and the menu says why (`unavailable`'s own sentence, keyed by the code)
   * rather than drawing commands for a conversation that is no longer there.
   *
   * A code outside that list changes nothing — a refusal about the *turn* (`turn-in-flight`) says
   * the session is answering, which is the opposite of gone.
   */
  function invalidate(code: AgentFailureCode): void {
    if (LIST_INVALIDATING_FAILURES.includes(code)) {
      list.value = { kind: 'unavailable', reason: code }
    }
  }

  /**
   * What a keydown means here. See {@link AgentCommandKeyResult} for why the
   * caller is told about the IME instead of just being told "not mine".
   */
  function onKeydown(event: KeyboardEvent): AgentCommandKeyResult {
    // The IME is served first. `isComposingKey` covers the engines that flag the
    // keystroke; the composition events cover the ones that do not.
    if (composing.value || isComposingKey(event)) return 'composing'
    if (view.value === 'closed') return 'pass'

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
      return 'handled'
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
      return 'handled'
    }
    if (event.key === 'Enter') {
      const command = activeCommand.value
      // Nothing highlighted means nothing to insert — an empty or failed list,
      // or a token no published command matches. Enter is then the composer's,
      // and the text goes to the engine as written so it can report the real
      // reason itself (§4.1: 未被公布的命令不伪装成支持).
      if (command === null) return 'pass'
      event.preventDefault()
      options.select(command)
      return 'handled'
    }
    return 'pass'
  }

  function onCompositionStart(): void {
    composing.value = true
    composedFrom.value = toValue(options.text)
  }

  function onCompositionEnd(): void {
    composing.value = false
    composedFrom.value = null
  }

  /**
   * The composer's text with the unfinished `/token` at the front replaced by
   * the command's published name.
   *
   * Only the token is rewritten: everything from the first whitespace on is
   * copied across untouched. That is where 「原样参数保留」 is kept — this
   * function has no notion of an argument, so it cannot trim one, collapse its
   * spacing, unquote it or unescape it, and no later edit can start to, because
   * there is nothing here to edit.
   *
   * The separator when the token is the whole text is what closes the menu. It
   * is not part of the user's arguments — there are none yet — and without it
   * the fresh `/review` would still read as an unfinished token, so the menu
   * would reopen on the command it had just inserted.
   */
  function textWithCommand(command: AgentCommand): string {
    const text = toValue(options.text)
    const end = text.search(/\s/)
    const rest = end === -1 ? '' : text.slice(end)
    return `/${command.name}${rest === '' ? ' ' : rest}`
  }

  /**
   * What the composer sends for this turn: the text it already holds.
   *
   * Handing the text back unchanged is the point of the function. §4.1 runs a
   * command through an ordinary `session/prompt` carrying `/command args`, and
   * the app does not reimplement the engine's template interpreter — so there is
   * nothing to decide here. A token naming a command the engine never published
   * goes to the engine as written and fails there, visibly, rather than being
   * silently blocked or helpfully rewritten on the way.
   */
  function promptText(): string {
    return toValue(options.text)
  }

  return {
    /** The engine's list for the bound session, and why it is empty when it is. */
    state: computed(() => list.value),
    /** What to draw; see {@link AgentCommandMenuView}. */
    view,
    /** The failure behind an `unavailable` list, or null. */
    reason,
    /** The token being typed, or null when the menu is closed. */
    query,
    /** The published commands the token keeps, in the engine's order. */
    matches,
    /** The row Enter would take, as an index into {@link matches}. */
    activeIndex,
    activeCommand,
    move,
    setActive,
    accept,
    invalidate,
    onKeydown,
    onCompositionStart,
    onCompositionEnd,
    textWithCommand,
    promptText,
  }
}

export type UseAgentCommands = ReturnType<typeof useAgentCommands>
