/**
 * The SVG the run staged for the note that is open, from the offer to the note edit.
 *
 * This is the production caller `AgentComposition.connectSvgInsertion` never had. §7.3's insertion
 * has been a finished service with a binding on the composition since T11, and the binding was
 * reached by nothing: the four steps it cannot take for itself belong to whoever holds the editor
 * pane — read the artifact off the disk, ask whether it may be drawn at all, save it where the plan
 * said, and only then let the note link it — and those four steps are this file, in that order.
 *
 * ## Why the order is the whole of it
 *
 *  - **The stat comes before the read.** The service compares the declared size with the bytes it
 *    was handed, and a file still being written is the one thing that comparison can catch. Taking
 *    both reads after the fact would make them agree about the same instant and prove nothing.
 *  - **The preview is a value only the checks can mint.** `inspectStagedSvg` returns a branded
 *    `AgentSvgPreview`, and nothing here can construct one, so "draw the raw text" is not a mistake
 *    this file is able to make — the type is the rule (§7.3 clause 3).
 *  - **The attachment is saved before the note may link it.** The plan names the file and the
 *    markdown; the save is the caller's, and the commit is told what really happened
 *    (`attachmentSaved`), so a note that would link a file nothing wrote is refused by the service
 *    rather than by this file remembering to check.
 *  - **The splice is taken from the note as it is at the commit**, not from the copy the plan was
 *    made against: the commit re-checks the revision and the anchor, and the text that gains the
 *    link is read after it, so an edit that landed elsewhere in the note while the image was being
 *    placed is carried rather than dropped.
 *
 * ## Where the insertion goes
 *
 * At the end of the note, and the surface says so out loud before the reader presses anything. An
 * offset in the editor's own coordinates would have to be mapped from whichever pane owns the
 * document — ProseMirror document positions are not markdown offsets — and a spot that is
 * approximately where the reader was looking is exactly the "it went in near where you meant"
 * outcome the service refuses. The end is a real anchor with a real fingerprint (the last 32
 * characters), it needs no mapping, and it is stated rather than implied.
 */

import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { AgentIdentity } from '../../../platform/gateways/agent-contracts'
import { t } from '../../../i18n'
import { fsService } from '../../../platform/gateways/fs'
import { useTabsStore } from '../../../stores/tabs'
import { ATTACHMENTS_DIR, attachmentMonthDir } from '../../attachments'
import type { AgentNoteSvgProposal } from '../services/agent-note-proposals'
import { readStagedSvg, savePlannedAttachment, type StagedSvgRead } from '../services/agent-note-svg'
import { writeNoteText } from '../services/agent-note-write'
import {
  inspectStagedSvg,
  type AgentSvgInspection,
  type AgentSvgRefusal,
} from '../services/agent-svg-insertion'
import type { AgentInsertionSource } from '../services/agent-insertion-source'

export interface AgentNoteArtifactDeps {
  /** The artifact on offer, or null when there is none. */
  proposal: () => AgentNoteSvgProposal | null
  /** The session the plan is made under, or null. */
  identity: AgentIdentity | null
  /** Where an insertion is bound, or null. */
  insertions: AgentInsertionSource | null
  /** The note the editor has in front, or null. */
  path: () => string | null
  /** Called once the reader has decided, so the row is not offered again. */
  onDecided: (toolCallId: string) => void
}

export interface AgentNoteArtifact {
  /** The artifact as the disk has it, or why it could not be read at all. */
  readonly artifact: Ref<StagedSvgRead | null>
  /** The name the vault file will get. The artifact's own stem until the reader changes it. */
  readonly fileName: Ref<string>
  readonly preview: ComputedRef<ReturnType<typeof previewOf>>
  readonly previewRefusal: ComputedRef<AgentSvgRefusal | null>
  /** Why the artifact may not be previewed, in the catalogue's own words. */
  readonly refusalSentence: ComputedRef<string | null>
  /** What became of the last placement, or null while there is nothing to say. */
  readonly sentence: ComputedRef<string | null>
  /** The artifact's own name, without the extension the plan adds. */
  stem(stagedPath: string): string
  insert(): Promise<void>
  discard(): void
}

/** The verified preview of an inspection, or null. Split out so the two computeds below read as
 *  one question each. */
function previewOf(inspection: AgentSvgInspection | null) {
  return inspection?.status === 'previewed' ? inspection.preview : null
}

export function useAgentNoteArtifact(deps: AgentNoteArtifactDeps): AgentNoteArtifact {
  const tabs = useTabsStore()

  const artifact = ref<StagedSvgRead | null>(null)
  const fileName = ref('')
  /** What happened to the last placement. A code the sentences below are keyed by. */
  const outcome = ref<string | null>(null)

  /** The file's own name, from the path the engine gave — no extension, which the plan adds. */
  function stem(stagedPath: string): string {
    const last = stagedPath.replace(/\\/g, '/').split('/').pop() ?? stagedPath
    return last.replace(/\.svg$/i, '')
  }

  watch(
    () => deps.proposal()?.path ?? null,
    async (stagedPath) => {
      artifact.value = null
      // A null path is the artifact having been DECIDED about, and the sentence describing that
      // decision is the one thing that has to survive it: clearing it here would erase the outcome
      // in the same breath as recording it. Only a different artifact starts a new story.
      if (stagedPath === null) return
      outcome.value = null
      fileName.value = stem(stagedPath)
      const vault = tabs.vault
      if (vault === null) return
      const read = await readStagedSvg(vault, stagedPath, fsService)
      // The proposal may have been superseded by a newer write while this read ran: nothing is
      // assigned for a path that is no longer the one on offer.
      if (deps.proposal()?.path === stagedPath) artifact.value = read
    },
    { immediate: true },
  )

  const inspection = computed<AgentSvgInspection | null>(() =>
    artifact.value?.status === 'read' ? inspectStagedSvg(artifact.value.staged) : null,
  )
  const preview = computed(() => previewOf(inspection.value))
  const previewRefusal = computed(() =>
    inspection.value?.status === 'refused' ? inspection.value.refusal : null,
  )

  /** Why an artifact may not be previewed, in the catalogue's own words. Each arm names the thing
   *  that is wrong rather than echoing the value that was refused. */
  const refusalSentence = computed<string | null>(() => {
    const refusal = previewRefusal.value
    if (refusal === null) return null
    if (refusal.reason === 'too-large') return t('agent.note.svg.refused.tooLarge', { size: refusal.sizeBytes, limit: refusal.limit })
    if (refusal.reason === 'incomplete-read') return t('agent.note.svg.refused.incompleteRead', { size: refusal.sizeBytes, read: refusal.readBytes })
    if (refusal.reason === 'too-complex') return t('agent.note.svg.refused.tooComplex', { elements: refusal.elements, limit: refusal.limit })
    if (refusal.reason === 'too-deep') return t('agent.note.svg.refused.tooDeep', { depth: refusal.depth, limit: refusal.limit })
    if (refusal.reason === 'foreign-namespace') return t('agent.note.svg.refused.foreignNamespace', { element: refusal.element, namespace: refusal.namespace })
    if (refusal.reason === 'unsafe-attribute') return t('agent.note.svg.refused.unsafeAttribute', { element: refusal.element, attribute: refusal.attribute })
    if (refusal.reason === 'external-reference') return t('agent.note.svg.refused.externalReference', { element: refusal.element, attribute: refusal.attribute })
    if (refusal.reason === 'unsafe-element') return t('agent.note.svg.refused.unsafeElement', { element: refusal.element })
    if (refusal.reason === 'not-svg') return t('agent.note.svg.refused.notSvg')
    if (refusal.reason === 'malformed') return t('agent.note.svg.refused.malformed')
    const kind = refusal.declaration === 'processing-instruction' ? 'processing instruction' : refusal.declaration
    return t('agent.note.svg.refused.declaration', { kind })
  })

  /** The names the destination month directory already holds: what the plan resolves against. */
  async function takenNames(vault: string, now: Date): Promise<readonly string[]> {
    try {
      const entries = await fsService.list(vault, `${ATTACHMENTS_DIR}/${attachmentMonthDir(now)}`)
      return entries.map((entry) => entry.name)
    } catch {
      // A directory that does not exist yet holds nothing, which IS the honest answer — and a read
      // that failed for another reason leaves the plan resolving against no names, where the
      // vault's own write is what would then have to resolve them. It is not silently ignored:
      // `savePlannedAttachment` refuses when the file does not land where the note points.
      return []
    }
  }

  /**
   * Place the verified artifact, or say why not.
   *
   * Every early return sets `outcome` to a code, because "nothing happened" is the one answer the
   * reader must not be left to infer.
   */
  async function insert(): Promise<void> {
    const offered = deps.proposal()
    const source = deps.insertions
    const identity = deps.identity
    const at = deps.path()
    const vault = tabs.vault
    const verified = preview.value
    const read = artifact.value
    if (
      offered === null || source === null || identity === null ||
      at === null || vault === null || verified === null || read === null || read.status !== 'read'
    ) {
      return
    }

    // The composition's own binding, minted for this session: the identity a plan is made under is
    // the session's, and this is the object that can say so.
    const binding = source.connectSvgInsertion(identity)

    const live = tabs.lookUpLiveNote(at)
    if (live.kind !== 'held') {
      outcome.value = 'note-not-open'
      return
    }
    const end = live.note.buffer.text.length
    const captured = binding.capture(at, end, end)
    if (captured.status !== 'captured') {
      outcome.value = captured.refusal.reason
      return
    }

    const now = new Date()
    const planned = binding.plan({
      preview: verified,
      target: captured.target,
      destination: { vaultRoot: vault, takenNames: await takenNames(vault, now), now },
      fileName: fileName.value,
      alt: stem(offered.path),
    })
    if (planned.status !== 'planned') {
      outcome.value = planned.refusal.reason
      return
    }

    const saved = await savePlannedAttachment(vault, planned.plan, read.staged.text, fsService)
    if (saved.status !== 'saved') {
      // Refused through the service's own commit so the outcome carries the same shape as every
      // other refusal, and so nothing here decides on its own that a broken link is acceptable.
      binding.commit(planned.plan, false)
      outcome.value = saved.status === 'elsewhere' ? 'move-elsewhere' : 'move-failed'
      return
    }

    const committed = binding.commit(planned.plan, true)
    if (committed.status !== 'inserted') {
      outcome.value = committed.refusal.reason
      return
    }

    // The note as it is NOW, after the commit that re-checked its revision and its anchor: an edit
    // that landed elsewhere in the document while the image was being placed is carried, not
    // dropped by splicing the text this was planned against.
    const after = tabs.lookUpLiveNote(at)
    if (after.kind !== 'held') {
      outcome.value = 'note-not-open'
      return
    }
    const text = after.note.buffer.text
    const next = text.slice(0, committed.change.from) + committed.change.insert + text.slice(committed.change.to)
    // The note's own save transaction, the same one the edit half uses: the link is a change to a
    // document, and there is one path into a document's file.
    const wrote = await writeNoteText(at, next)
    outcome.value = wrote.status === 'saved' ? 'inserted' : 'note-write-failed'
    deps.onDecided(offered.toolCallId)
  }

  function discard(): void {
    const offered = deps.proposal()
    if (offered !== null) deps.onDecided(offered.toolCallId)
  }

  /** The placement's own refusals, keyed by the code the service returned. */
  function placementSentence(reason: string): string {
    const sentences: Record<string, string> = {
      'note-not-open': t('agent.note.svg.outcome.noteNotOpen'),
      'target-changed': t('agent.note.svg.outcome.targetChanged'),
      'vault-mismatch': t('agent.note.svg.outcome.vaultMismatch'),
      'anchor-out-of-range': t('agent.note.svg.outcome.anchorOutOfRange'),
      'identity-changed': t('agent.note.svg.outcome.identityChanged'),
      'revision-changed': t('agent.note.svg.outcome.revisionChanged'),
      'anchor-moved': t('agent.note.svg.outcome.anchorMoved'),
      'invalid-file-name': t('agent.note.svg.outcome.invalidFileName'),
      'name-unavailable': t('agent.note.svg.outcome.nameUnavailable'),
      'attachment-not-saved': t('agent.note.svg.outcome.attachmentNotSaved'),
    }
    return sentences[reason] ?? t('agent.note.svg.outcome.anchorMoved')
  }

  const sentence = computed<string | null>(() => {
    const code = outcome.value
    if (code === null) return null
    if (code === 'inserted') return t('agent.note.svg.outcome.inserted')
    if (code === 'move-failed') return t('agent.note.svg.outcome.moveFailed')
    if (code === 'move-elsewhere') return t('agent.note.svg.outcome.moveElsewhere')
    if (code === 'note-write-failed') return t('agent.note.svg.outcome.noteWriteFailed')
    return placementSentence(code)
  })

  return { artifact, fileName, preview, previewRefusal, refusalSentence, sentence, stem, insert, discard }
}
