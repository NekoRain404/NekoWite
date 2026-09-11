import { linkSchema } from '@milkdown/preset-commonmark'

/**
 * Priority of the `link` mark in the Markdown serializer.
 *
 * `@milkdown/transformer` nests a text run's marks by `spec.priority` in
 * ascending order, and the first mark it opens ends up OUTERMOST. Every text
 * mark defaults to 50, so marks that share the default keep ProseMirror's own
 * order — where `strong` ranks before `link`. A link whose text was bold
 * therefore saved as `**[bold](url)** [link](url)` instead of the author's
 * `[**bold** link](url)`: the emphasis was hoisted outside the link and the
 * link was duplicated around each run.
 *
 * Pinning `link` below the default makes it wrap the text marks, which is the
 * form authors write and the form other Markdown tools expect. `inlineCode`
 * ships with priority 100 for the mirror-image reason: a code span has to stay
 * innermost. `delete` and `highlight` are left at the default; they only need to
 * be inside the link, and the ordering between them is unchanged from before.
 */
export const LINK_MARK_PRIORITY = 0

/**
 * The `link` mark with the serialization priority above.
 *
 * `priority` is read by milkdown's serializer but is not part of the `MarkSpec`
 * type it publishes, so the extended spec is asserted back to its own type
 * rather than widened.
 */
export const linkOrderSchema = linkSchema.extendSchema((prev) => (ctx) => {
  const base = prev(ctx)
  return { ...base, priority: LINK_MARK_PRIORITY } as typeof base
})
