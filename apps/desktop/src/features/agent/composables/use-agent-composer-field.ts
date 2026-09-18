/**
 * The field itself: how tall it grows, which Enter the input method owns, and where a chosen
 * reference lands in the text.
 *
 * Everything here needs the element, and that is the whole of the split.
 * `use-agent-composer-attachments.ts` states the reason these live outside the component — the
 * rules are testable without mounting a textarea, "and the component is left with the parts only an
 * element can do: where the caret is, which clipboard event arrived, whether a drag is over it" —
 * and this file is that remainder gathered in one place rather than spread through
 * `AgentComposer.vue`: the element, its caret, its `scrollHeight`, the composition events it saw,
 * and focus. What it does *not* decide is whether a turn may go out at all (the component's
 * `submit`) or what a key means to the menus above it (the component's dispatch order): both ask
 * this file rather than re-deriving it, and {@link AgentComposerField.inputMethodOwnsEnter} is the
 * one answer to "did the reader press this key".
 *
 * **Enter does not send during an IME composition.** That is §10.2's acceptance, and it is the one
 * place in this feature where a keystroke must be read as the input method's rather than the
 * reader's: a candidate is committed with Enter, and a composer that sent on it would submit half a
 * word and, on a Chinese or Japanese layout, send on every candidate change. Three signals decide
 * it, because the engines disagree about which one they set — the composition events this element
 * saw, `KeyboardEvent.isComposing`, and the legacy 229 key code a browser sends for a key it handed
 * to the input method. All three are checked: the composition events are the ones that are always
 * there, and the other two cover the deliveries that arrive outside a composition as far as this
 * element is concerned.
 *
 * The field grows with its content to about a third of the panel and then scrolls
 * (§5.3 「输入区初始约 96–120px，随内容增长到面板高度的约 35% 后内部滚动」). The bound is
 * measured from the nearest positioned ancestor — the panel, which is what it must not
 * outgrow — and not from the window, because the panel is not always the window.
 */
import { nextTick, ref, type Ref } from 'vue'
import { insertReferenceText } from '../services/agent-context-references'

export interface UseAgentComposerFieldOptions {
  /** The element itself. Bound by the template (`ref="el"`) and handed in rather than reached for
   *  inside this file: a template ref is the template's to name. */
  el: Ref<HTMLTextAreaElement | null>
  /** The message as the reader has it: read for what is around the caret, written when a reference
   *  goes in. Where the draft lives is nobody's business here — the composer's is the session's
   *  (`AgentComposer.vue`'s `draft`). */
  draft: Ref<string>
  /** A composition opened or closed. This file owns the flag the answer is read from; what the rest
   *  of the app is told is the caller's (`AgentComposer.vue`'s `composition` event, which the
   *  panel's command menu holds its filter still across — T8). */
  composition: (phase: 'start' | 'end') => void
}

export interface AgentComposerField {
  /** Put focus in the field. */
  focus(): void
  /** Grow to fit the text, then let the panel's share cap it. Called after the DOM has the new
   *  value, because `scrollHeight` is measured from it. */
  grow(): void
  /** Put a reference into the message, at the caret. */
  insertReference(reference: string): void
  /** Whether the Enter that just arrived is the input method's rather than the reader's. */
  inputMethodOwnsEnter(event: KeyboardEvent): boolean
  /** The field's own `compositionstart`. */
  onCompositionStart(): void
  /** The field's own `compositionend`. */
  onCompositionEnd(): void
}

export function useAgentComposerField(
  options: UseAgentComposerFieldOptions,
): AgentComposerField {
  /** Set by the composition events this element saw, and the authority on whether Enter is the
   *  reader's or the input method's. */
  const composing = ref(false)

  /**
   * How long after a composition ends an Enter is still read as the input method's.
   *
   * WebKit — the engine this application ships on, WebKitGTK 4.1 — delivers the Enter that
   * *committed* a candidate after `compositionend`, by which time both `isComposing` and this
   * element's own flag say the composition is over. Trusting the flags alone would send half a
   * word on the product's own engine. A reader cannot commit a candidate and mean "send" inside
   * this window: committing is itself an Enter, so the send would have to be a second keystroke
   * inside 60ms.
   */
  const COMMIT_GRACE = 60
  let composedAt = Number.NEGATIVE_INFINITY

  function focus(): void {
    options.el.value?.focus()
  }

  /** How tall the field may grow: about a third of the panel (§5.3).
   *
   *  Measured from the panel's own marker rather than from `offsetParent`: the panel is what the
   *  field must not outgrow, and between the two of them now sits the mention list's positioning
   *  box — an ancestor, but not the bound. */
  function limit(el: HTMLTextAreaElement): number {
    const panel = el.closest('[data-agent-panel]') as HTMLElement | null
    return Math.round((panel?.clientHeight ?? 480) * 0.35)
  }

  function grow(): void {
    const el = options.el.value
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, limit(el))}px`
  }

  /**
   * Put a reference the reader picked into the message, at the caret.
   *
   * The caret is where the reader was typing, so the text lands there; a field that has never been
   * focused has no selection to read and the reference is appended. What the message becomes is
   * `insertReferenceText`'s decision rather than this file's — the spaces, the clamp and the
   * new caret live with the rest of the reference rules — and what is left here is the two things
   * only the element can do: read the caret off the textarea, and put focus and the caret back.
   *
   * Focus goes to the field, and it goes there in a `nextTick`: the list that produced the reference
   * is being torn down in this same turn, and a field that asked for focus before that patch would
   * be handing it straight back to a dying menu. Choosing a row is the one way out of that list that
   * ends here rather than on the control (`AgentComposerContext` returns focus to the control when
   * the reader *dismisses* it), because the reader's next act is a word, not another file.
   */
  function insertReference(reference: string): void {
    const el = options.el.value
    const placed = insertReferenceText(
      options.draft.value,
      el?.selectionStart ?? options.draft.value.length,
      reference,
    )
    options.draft.value = placed.text
    void nextTick(() => {
      const target = options.el.value
      if (target === null) return
      target.focus()
      target.setSelectionRange(placed.caret, placed.caret)
    })
  }

  function inputMethodOwnsEnter(event: KeyboardEvent): boolean {
    // Enter during a composition is the input method committing a candidate. See the header.
    if (composing.value || event.isComposing || event.keyCode === 229) return true
    // …and so is the Enter a WebKit delivers just after one ended. See COMMIT_GRACE.
    return performance.now() - composedAt < COMMIT_GRACE
  }

  function onCompositionStart(): void {
    composing.value = true
    options.composition('start')
  }

  function onCompositionEnd(): void {
    composing.value = false
    composedAt = performance.now()
    options.composition('end')
  }

  return { focus, grow, insertReference, inputMethodOwnsEnter, onCompositionStart, onCompositionEnd }
}
