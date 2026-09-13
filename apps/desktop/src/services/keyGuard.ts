/**
 * Shared guard for keyboard handlers that must not act while an IME is
 * composing text.
 *
 * Chinese/Japanese/Korean input is a two-stage process: the keystrokes that
 * build a candidate, and the keystroke that accepts it. Enter and Escape belong
 * to the *first* stage while the candidate list is open — pressing Enter there
 * chooses the highlighted candidate, and Escape dismisses the list. A handler
 * that claims those keys for the app instead submits half-composed text or
 * throws the user's input away (the classic "I typed pinyin and it renamed the
 * file to `fengjing`" report).
 *
 * Three signals have to be checked because browsers and IMEs disagree:
 *   - `isComposing` — the standard flag, set during composition;
 *   - `keyCode === 229` — the legacy "this key is being processed by the IME"
 *     marker some Windows IMEs/themes still rely on (and which is what the
 *     deprecated `keyCode` is for);
 *   - `key === 'Process'` — some IMEs report the composing key itself this way
 *     with `isComposing` already cleared.
 *
 * Handlers call this first and return when it is true, so the IME gets the
 * event untouched. Every keydown handler in the app that reacts to Enter, Tab
 * or Escape should use it.
 */
export function isComposingKey(e: KeyboardEvent): boolean {
  return (
    e.isComposing === true ||
    e.keyCode === 229 ||
    e.key === 'Process'
  )
}
