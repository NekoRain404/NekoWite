import type { DocumentEnvelope } from './document-envelope'

/**
 * What document the editor is holding — the whole of it, or none.
 *
 * `open()` used to commit half of the new document before the step that can
 * fail: the frontmatter was assigned, and the MDX flag with it, and only then
 * did the parse run. A parse that threw left the editor holding the PREVIOUS
 * document under THIS file's frontmatter, and `save()` serialized exactly that —
 * a document that never existed anywhere, and the string the P0 reproduction
 * wrote to disk (task-37 C1). In a session that had not loaded a document yet
 * the same path serialized to `""`, which the app wrote over a 2 KB note.
 *
 * The fix is not "clear the model on failure": that discards state another
 * caller holds and would leave the same `""` behind. It is to stop the two
 * halves from ever being committed apart, and to make "I am holding no
 * document" a state the editor can be in and SAYS it is in:
 *
 *   - a load commits the envelope, the document kind and the model together, at
 *     the end of the load, and only if the parse succeeded (see `editor.ts`);
 *   - a load that throws ends with nothing held, whatever the model holds: the
 *     caller asked for a different file, so no serialization of the model is an
 *     answer to "what is in that file";
 *   - `save()` asks this object for the document it is holding, and refuses
 *     when there is none. Refusing is the only honest answer: any string it
 *     could invent would belong to another file, and the app would write it
 *     there. Returning `""` for "no document" is how the note was blanked.
 *
 * The model itself is NOT discarded — `getView()` still holds the previous
 * document, with its undo stack and caret, for whoever was using it. What is
 * dropped is the editor's claim that that document is the one that is open.
 */

/**
 * `save()` was asked for a document the editor is not holding: no `open()` has
 * succeeded (yet, or since the last one failed).
 *
 * A refusal rather than an empty string: the caller's next step is to write what
 * it gets back to the file the user is looking at, and there is no string that
 * is the right answer here.
 */
export class NoDocumentLoadedError extends Error {
  constructor() {
    super(
      '[NekoEditor] save() refused: the editor is not holding a document — ' +
        'no open() has succeeded, so there is nothing to serialize',
    )
    this.name = 'NoDocumentLoadedError'
  }
}

/** The document the editor is holding: the model, and the bytes around it. */
export interface HeldDocument {
  envelope: DocumentEnvelope
  /** Whether an MDX document is open: the parser and the save path must both
   *  read the model in the language it was loaded in. */
  mdx: boolean
}

export type HeldDocumentSlot = ReturnType<typeof createDocumentHolder>

export function createDocumentHolder() {
  let held: HeldDocument | null = null
  return {
    /** Commit a completed load: the last step of `open()`, never the first. */
    hold(next: HeldDocument): void {
      held = next
    },
    /** A load failed: the editor holds no document until one succeeds. */
    drop(): void {
      held = null
    },
    /** The document that is open. Throws when none is. */
    require(): HeldDocument {
      if (!held) throw new NoDocumentLoadedError()
      return held
    },
    /** The kind of the document that is open; false while none is. */
    get mdx(): boolean {
      return held?.mdx ?? false
    },
  }
}
