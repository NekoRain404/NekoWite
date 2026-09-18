/**
 * The two intakes that arrive as *events on the field*: a paste, and a drag that ends on it.
 *
 * A composable rather than state on `AgentComposer.vue`, for the reason `use-agent-composer-
 * attachments.ts` is one: what it decides is what a *gesture* means — whether the clipboard
 * carried an image, whether a drag is one of this app's own documents, which effect its source is
 * offering — and none of that needs a textarea to be read. What the component keeps is the part
 * only its own markup can do (bind these three to the field) and the two answers this file must
 * not invent: which file a path names, and what a transfer's files become. Both are handed in —
 * `pick` is `AgentComposer.vue`'s `pickFile`, and `addFromTransfer` is
 * `use-agent-composer-attachments.ts`'s own function, which holds the engine's report and the
 * refusals.
 *
 * The third intake is not here: a file picked in the `+`'s list is a *row* rather than an event,
 * and it goes straight to `pickFile`, which is also where this file's dragged path ends up.
 */
import { carriesDraggedPath, draggedPath } from '../../../services/drag-payload'
import { draggedReference } from '../services/agent-context-references'

export interface UseAgentComposerIntakeOptions {
  /** The workspace a dragged path is addressed in. Read through a function because that is the
   *  shape this component's readers take: a composer re-pointed at another session must not answer
   *  this one with an older vault than its pick or its `+` did. */
  vault: () => string | null
  /** Add what a transfer carried. The gate is the attachments composable's: an intake is a fact
   *  about the clipboard, and what the engine reads is a fact about the engine. */
  addFromTransfer: (data: DataTransfer | null) => Promise<void>
  /** The one route a file named by a gesture takes, so what becomes of it is decided in one place. */
  pick: (path: string) => void
}

export interface AgentComposerIntake {
  /** The field's own `paste`. */
  onPaste(event: ClipboardEvent): void
  /** The field's own `dragover`. */
  onDragOver(event: DragEvent): void
  /** The field's own `drop`. */
  onDrop(event: DragEvent): void
}

export function useAgentComposerIntake(
  options: UseAgentComposerIntakeOptions,
): AgentComposerIntake {
  /**
   * A paste. Images become attachments; anything else is left to the field.
   *
   * The event is only taken when the clipboard actually carried an image: a paste of text must reach
   * the textarea unchanged, and preventing the default on every paste would be this file swallowing
   * the reader's copy of a sentence to look for a screenshot in it.
   */
  function onPaste(event: ClipboardEvent): void {
    const clipboard = event.clipboardData
    const carriesImage = Array.from(clipboard?.items ?? []).some(
      (item) => item.kind === 'file' && item.type.startsWith('image/'),
    )
    if (!carriesImage) return
    event.preventDefault()
    void options.addFromTransfer(clipboard)
  }

  /** A drag over the field. Only claimed when the drag carries files or a document of this app's
   *  own, and refused by default otherwise so the field keeps its ordinary text-drop behaviour. */
  function onDragOver(event: DragEvent): void {
    const data = event.dataTransfer
    if (!carriesFiles(data) && !carriesDraggedPath(data)) return
    event.preventDefault()
    if (data !== null) data.dropEffect = offeredEffect(data)
  }

  function onDrop(event: DragEvent): void {
    // The whole reason a document drag is not a file drag: the bytes were never in the transfer.
    // What arrives is a path this window dragged, and it goes exactly where the `+`'s file row goes —
    // through `attachFile`, the one place that decides between an image, a resource block and a path
    // in the message by asking the engine's own report. See `AgentComposer.vue`'s `pickFile`, which
    // is what `pick` above is.
    //
    // The conversion is `draggedReference`'s and not this file's: a reference is vault-relative
    // because that is the only spelling the engine can resolve, and the same rule produces the `+`'s
    // rows. A path that cannot become one — from outside the vault, or with no vault open yet —
    // leaves the drag unclaimed rather than inserting a path that names nothing the turn can read.
    const dropped = draggedReference(draggedPath(event.dataTransfer), options.vault())
    if (dropped !== null) {
      event.preventDefault()
      options.pick(dropped)
      return
    }
    if (!carriesFiles(event.dataTransfer)) return
    event.preventDefault()
    void options.addFromTransfer(event.dataTransfer)
  }

  function carriesFiles(data: DataTransfer | null): boolean {
    if (data === null) return false
    return Array.from(data.types).includes('Files')
  }

  /**
   * Which effect to ask for, out of the ones the source is offering.
   *
   * The two producers of a document drag do not offer the same thing: the tab strip offers a copy
   * (the document stays where it was) and the vault tree offers a move (its drag re-parents a node).
   * A target may only accept an effect the source offers — asking for a copy of a move-only drag
   * makes the browser cancel the drop before this handler ever runs — so the field asks for the copy
   * when it may and settles for the move when it may not. Either way the message is the same: the
   * *effect* is a promise about the source, not about what this app does with the path.
   */
  function offeredEffect(data: DataTransfer): 'copy' | 'move' {
    const allowed = data.effectAllowed
    const copies = allowed === 'copy' || allowed === 'copyMove' || allowed === 'copyLink' || allowed === 'all'
    // `uninitialized` is the value a source that never set one leaves behind, and every effect is
    // available there; `link` alone is the one case with no copy and no move to ask for, and the
    // field asks for neither rather than inventing a third.
    if (copies || allowed === 'uninitialized') return 'copy'
    return 'move'
  }

  return { onPaste, onDragOver, onDrop }
}
