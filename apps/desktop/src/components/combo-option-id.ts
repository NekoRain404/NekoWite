/** The id of one row in a ComboBox list.
 *
 * The field names the row the arrows are on in `aria-activedescendant`; the
 * list draws it. Both mint the id from the one string the field already owns
 * (`<id>-list`), from here rather than from either half, so the two cannot
 * drift: an `aria-activedescendant` naming an id no element carries is a
 * combobox a screen reader reads as empty (§13.9 — the scheme is not the
 * component's to reverse-export).
 */
export function comboOptionId(listId: string, index: number): string {
  return `${listId}-option-${index}`
}
