/**
 * The SVG insertion's tests, one per way the acceptance names an insert going wrong.
 *
 *  - **恶意 SVG** — the artifact comes from an agent, so it is untrusted input and every hostile
 *    document below is refused *by name*: the element or attribute that failed is in the refusal, and
 *    nothing is cleaned up and handed on. A `script` tag that vanished from a "safe" copy would be
 *    the silent-drop failure this codebase refuses, and the tests assert the refusal rather than a
 *    sanitised document, which is what makes "it was not stripped, it was rejected" checkable.
 *  - **半成品** — an insert interrupted between writing the file and editing the note. The note is
 *    untouched, and the outcome says whether the attachment had already been written, so the state
 *    the user is left in is one the UI can describe and they can undo.
 *  - **超大文件** — three bounds, each asserted with the input that must hit it rather than with a
 *    file that merely looks big: an over-size stat, an over-size text behind a small stat, and a tree
 *    with more elements or more nesting than the budget. The first of those is also the proof the
 *    size check runs *before* the parse: the text is not even well-formed.
 *  - **切换文档** — a plan names a note, and the note that is open when the insert lands may be
 *    another one. The commit reads the *planned path* and refuses when it is gone, when another vault
 *    owns it, or when the session identity moved on.
 *  - **锚点失效** — the offsets may no longer describe the spot: an edit before it moves them, an edit
 *    *at* it keeps them and changes the text. Both are refused, and the second is the one a check on
 *    offsets alone would miss — which is why the anchor keeps the text around it.
 *
 * The positive controls are load-bearing. A suite that only refused would pass on a module that
 * refuses everything, so each refusal family is paired with the document, the edit or the re-placed
 * insert that must be accepted.
 */

import { describe, expect, it } from 'vitest'
import type { AgentIdentity } from '../../../platform/gateways/agent-contracts'
import type { AgentLiveNote } from './agent-context-snapshot'
import {
  ANCHOR_CONTEXT_CHARS,
  MAX_ATTACHMENT_NAME_ATTEMPTS,
  MAX_SVG_BYTES,
  MAX_SVG_DEPTH,
  MAX_SVG_ELEMENTS,
  captureInsertionTarget,
  commitSvgInsertion,
  inspectStagedSvg,
  planSvgInsertion,
  retargetSvgInsertion,
  type AgentInsertionRefusal,
  type AgentInsertionTarget,
  type AgentSvgInsertionPlan,
  type AgentSvgPreview,
  type AgentSvgRefusal,
  type AgentStagedSvg,
} from './agent-svg-insertion'
import { createAgentComposition } from '../../../app/agent-composition'

const VAULT = '/home/user/vault'
const SEPTEMBER_2026 = new Date(2026, 8, 16, 12, 0, 0)

function identity(overrides: Partial<AgentIdentity> = {}): AgentIdentity {
  return {
    agentId: 'opencode',
    profileId: 'default',
    runtimeEpoch: 'epoch-1',
    vaultId: VAULT,
    sessionId: 'session-1',
    ...overrides,
  }
}

/** A note as the editor holds it: clean unless the test is about a dirty buffer. */
function note(overrides: Partial<AgentLiveNote> = {}): AgentLiveNote {
  return {
    vaultId: VAULT,
    path: `${VAULT}/notes/a.md`,
    revision: 'rev-1',
    buffer: { state: 'clean', text: 'intro\n\n' },
    ...overrides,
  }
}

function staged(text: string, overrides: Partial<AgentStagedSvg> = {}): AgentStagedSvg {
  return {
    path: '/home/user/staging/diagram.svg',
    mediaType: 'image/svg+xml',
    sizeBytes: new TextEncoder().encode(text).length,
    text,
    ...overrides,
  }
}

function svg(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`
}

/** The preview, or a failure naming what was refused: a test that expects a preview and gets a
 *  refusal should say what the refusal was, not fail reading `.markup` off the other arm. */
function previewOrThrow(artifact: AgentStagedSvg): AgentSvgPreview {
  const result = inspectStagedSvg(artifact)
  if (result.status !== 'previewed') throw new Error(`refused: ${describeSvgRefusal(result.refusal)}`)
  return result.preview
}

function describeSvgRefusal(refusal: AgentSvgRefusal): string {
  return 'element' in refusal ? `${refusal.reason}(${refusal.element})` : refusal.reason
}

/** The refusal inspection returned, or a failure saying it was accepted when it had to be refused. */
function svgRefusalOf(artifact: AgentStagedSvg): AgentSvgRefusal {
  const result = inspectStagedSvg(artifact)
  if (result.status !== 'refused') throw new Error(`accepted: ${result.preview.markup.slice(0, 80)}`)
  return result.refusal
}

function planOf(request: Parameters<typeof planSvgInsertion>[0]): AgentSvgInsertionPlan {
  const result = planSvgInsertion(request)
  if (result.status !== 'planned') throw new Error(`refused: ${result.refusal.reason}`)
  return result.plan
}

function insertRefusalOf(result: ReturnType<typeof commitSvgInsertion>): AgentInsertionRefusal & {
  readonly attachmentSaved: boolean
} {
  if (result.status !== 'refused') throw new Error(`inserted into ${result.path}`)
  return { ...result.refusal, attachmentSaved: result.attachmentSaved }
}

/** A target pointing at a caret in a note, which is the ordinary case: nothing is replaced. */
function targetAt(live: AgentLiveNote, offset: number, overrides: Partial<AgentIdentity> = {}): AgentInsertionTarget {
  const capture = captureInsertionTarget(live, identity(overrides), { from: offset, to: offset })
  if (capture.status !== 'captured') throw new Error(`capture refused: ${capture.refusal.reason}`)
  return capture.target
}

function planFor(
  live: AgentLiveNote,
  overrides: {
    readonly fileName?: string
    readonly takenNames?: readonly string[]
    readonly alt?: string
    readonly vaultRoot?: string
  } = {},
): AgentSvgInsertionPlan {
  const preview = previewOrThrow(staged(svg('<rect width="10" height="10" fill="red"/>')))
  return planOf({
    preview,
    target: targetAt(live, live.buffer.text.length),
    identity: identity(),
    destination: {
      vaultRoot: overrides.vaultRoot ?? VAULT,
      takenNames: overrides.takenNames ?? [],
      now: SEPTEMBER_2026,
    },
    fileName: overrides.fileName ?? 'diagram.svg',
    ...(overrides.alt === undefined ? {} : { alt: overrides.alt }),
  })
}

describe('inspectStagedSvg — a document from an agent is untrusted until it passes', () => {
  it('refuses a script element by name instead of deleting it', () => {
    const refusal = svgRefusalOf(staged(svg('<script>alert(1)</script>')))
    expect(refusal).toEqual({ reason: 'unsafe-element', element: 'script' })
  })

  it('refuses an event-handler attribute', () => {
    expect(svgRefusalOf(staged(svg('<rect onload="alert(1)" width="1" height="1"/>')))).toEqual({
      reason: 'unsafe-attribute',
      element: 'rect',
      attribute: 'onload',
    })
  })

  it('refuses an event handler however it is spelled', () => {
    // XML is case-sensitive, so `onLoad` is not the SVG handler — but a document that reaches a
    // renderer through more than one parser must not depend on which of them agrees with that.
    const text = svg('<rect onLoad="alert(1)" width="1" height="1"/>')
    expect(svgRefusalOf(staged(text)).reason).toBe('unsafe-attribute')
  })

  it('refuses a reference out of the document', () => {
    expect(svgRefusalOf(staged(svg('<use href="https://evil.example/x.svg#z"/>')))).toEqual({
      reason: 'external-reference',
      element: 'use',
      attribute: 'href',
    })
  })

  it('refuses an xlink reference out of the document', () => {
    const text = svg('<use xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://evil.example/x.svg#z"/>')
    expect(svgRefusalOf(staged(text)).reason).toBe('external-reference')
  })

  it('refuses an image whose data is a URL', () => {
    const text = svg('<image width="10" height="10" href="data:image/svg+xml;base64,PHN2Zy8+"/>')
    expect(svgRefusalOf(staged(text)).reason).toBe('external-reference')
  })

  it('refuses a paint server that would reach the network', () => {
    const text = svg('<rect width="1" height="1" fill="url(https://evil.example/p.svg#g)"/>')
    expect(svgRefusalOf(staged(text)).reason).toBe('external-reference')
  })

  it('accepts a paint server that points into the document', () => {
    const text = svg(
      '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs>' +
        '<rect width="1" height="1" fill="url(#g)"/>',
    )
    expect(previewOrThrow(staged(text)).markup).toContain('url(#g)')
  })

  it('refuses a style element', () => {
    expect(svgRefusalOf(staged(svg('<style>rect{fill:url(https://evil.example/x)}</style>')))).toEqual({
      reason: 'unsafe-element',
      element: 'style',
    })
  })

  it('refuses a style attribute', () => {
    const text = svg('<rect style="fill:red" width="1" height="1"/>')
    expect(svgRefusalOf(staged(text))).toEqual({
      reason: 'unsafe-attribute',
      element: 'rect',
      attribute: 'style',
    })
  })

  it('refuses foreignObject', () => {
    const text = svg('<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"/></foreignObject>')
    expect(svgRefusalOf(staged(text))).toEqual({ reason: 'unsafe-element', element: 'foreignobject' })
  })

  it('refuses an animation, which could retarget a checked link later', () => {
    const text = svg('<use href="#a"><set attributeName="href" to="javascript:alert(1)"/></use>')
    expect(svgRefusalOf(staged(text)).reason).toBe('unsafe-element')
  })

  it('refuses an element from another namespace', () => {
    const text = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://evil.example/ns"><s:x/></svg>'
    expect(svgRefusalOf(staged(text))).toEqual({
      reason: 'foreign-namespace',
      element: 'x',
      namespace: 'http://evil.example/ns',
    })
  })

  it('refuses an element that is not on the allowlist rather than dropping it', () => {
    // A link is a real SVG element and deliberately absent from the list: it is an active channel,
    // and the refusal names it rather than rendering a picture with the link quietly removed.
    expect(svgRefusalOf(staged(svg('<a x="1"><rect width="1" height="1"/></a>')))).toEqual({
      reason: 'unsafe-element',
      element: 'a',
    })
  })

  it('refuses a doctype before the parser is handed the entities it declares', () => {
    // A billion-laughs document is small and expands without bound, which is why this is refused as
    // a declaration rather than measured: the size bound cannot see what the entity will become.
    const text =
      '<!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>' +
      '<svg xmlns="http://www.w3.org/2000/svg"><text>&b;</text></svg>'
    expect(svgRefusalOf(staged(text))).toEqual({ reason: 'unsafe-declaration', declaration: 'doctype' })
  })

  it('refuses a stylesheet processing instruction', () => {
    const text = `<?xml-stylesheet href="https://evil.example/x.css" type="text/css"?><svg xmlns="http://www.w3.org/2000/svg"/>`
    expect(svgRefusalOf(staged(text)).reason).toBe('unsafe-declaration')
  })

  it('accepts an ordinary diagram and reports what it checked', () => {
    const artifact = staged(svg('<g><rect width="10" height="10" fill="red"/><text x="1" y="2">hi</text></g>'))
    const preview = previewOrThrow(artifact)
    expect(preview.stagedPath).toBe(artifact.path)
    expect(preview.elements).toBe(4)
    expect(preview.byteLength).toBe(artifact.sizeBytes)
    expect(preview.markup).toContain('<rect')
  })

  it('hands over the parser’s own output, not the raw text', () => {
    const text = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns='http://www.w3.org/2000/svg'><rect width='1' height='1'/></svg>`
    const preview = previewOrThrow(staged(text))
    expect(preview.markup).not.toBe(text)
    expect(preview.markup).toContain('width="1"')
    expect(preview.markup).not.toContain("width='1'")
  })
})

describe('inspectStagedSvg — the bounds are checked, not hoped for', () => {
  it('refuses an over-size file before it looks at the text', () => {
    // Not well-formed on purpose: the size is what must be answered, and a file that is over the
    // bound has no business being parsed to find out what it says.
    const artifact = staged('not svg at all', { sizeBytes: MAX_SVG_BYTES + 1 })
    expect(svgRefusalOf(artifact)).toEqual({ reason: 'too-large', sizeBytes: MAX_SVG_BYTES + 1, limit: MAX_SVG_BYTES })
  })

  it('refuses a text longer than the bound even when the caller’s size says otherwise', () => {
    const text = 'x'.repeat(MAX_SVG_BYTES + 1)
    const artifact = { ...staged(text), sizeBytes: 4 }
    expect(svgRefusalOf(artifact).reason).toBe('too-large')
  })

  it('refuses a read that does not match the size that was stat’ed', () => {
    const artifact = staged(svg('<rect width="1" height="1"/>'), { sizeBytes: 40 })
    const refusal = svgRefusalOf(artifact)
    expect(refusal.reason).toBe('incomplete-read')
    expect(refusal).toMatchObject({ sizeBytes: 40 })
  })

  it('refuses a tree with more elements than the budget', () => {
    const body = '<g>'.repeat(4) + '<rect width="1" height="1"/>'.repeat(MAX_SVG_ELEMENTS) + '</g>'.repeat(4)
    expect(svgRefusalOf(staged(svg(body)))).toMatchObject({ reason: 'too-complex', limit: MAX_SVG_ELEMENTS })
  })

  it('refuses a tree nested deeper than the budget', () => {
    const depth = MAX_SVG_DEPTH + 2
    const text = svg('<g>'.repeat(depth) + '</g>'.repeat(depth))
    expect(svgRefusalOf(staged(text))).toMatchObject({ reason: 'too-deep', limit: MAX_SVG_DEPTH })
  })

  it('refuses a document that is still being written', () => {
    expect(svgRefusalOf(staged('<svg xmlns="http://www.w3.org/2000/svg"><rect')).reason).toBe('malformed')
  })

  it('refuses a document whose root is not svg', () => {
    expect(svgRefusalOf(staged('<html xmlns="http://www.w3.org/1999/xhtml"/>')).reason).toBe('malformed')
  })

  it('refuses a staged file that is not an SVG at all', () => {
    const artifact = staged('<svg/>', { mediaType: 'image/png' })
    expect(svgRefusalOf(artifact)).toEqual({ reason: 'not-svg', mediaType: 'image/png' })
  })
})

describe('captureInsertionTarget', () => {
  it('keeps the note, its revision and the text around the spot', () => {
    const live = note({ path: `${VAULT}/notes/a.md`, buffer: { state: 'clean', text: 'alpha beta gamma' } })
    const capture = captureInsertionTarget(live, identity(), { from: 6, to: 10 })
    expect(capture.status).toBe('captured')
    if (capture.status !== 'captured') return
    expect(capture.target.path).toBe(live.path)
    expect(capture.target.revision).toBe('rev-1')
    expect(capture.target.anchor).toMatchObject({ from: 6, to: 10, selected: 'beta', before: 'alpha ', after: ' gamma' })
  })

  it('refuses a note of another vault', () => {
    const live = note({ vaultId: '/home/user/other', path: '/home/user/other/a.md' })
    const capture = captureInsertionTarget(live, identity(), { from: 0, to: 0 })
    expect(capture).toEqual({
      status: 'refused',
      refusal: {
        reason: 'vault-mismatch',
        path: '/home/user/other/a.md',
        itemVaultId: '/home/user/other',
        contextVaultId: VAULT,
      },
    })
  })

  it('refuses a range that is not in the text it was given', () => {
    const capture = captureInsertionTarget(note(), identity(), { from: 0, to: 99 })
    expect(capture).toMatchObject({ status: 'refused', refusal: { reason: 'anchor-out-of-range' } })
  })
})

describe('planSvgInsertion — the existing attachment path, plus the same-name case', () => {
  it('names the file, places it by month and references it from the note’s own directory', () => {
    const plan = planFor(note())
    expect(plan.fileName).toBe('diagram.svg')
    expect(plan.vaultPath).toBe('attachments/2026-09/diagram.svg')
    expect(plan.markdownSrc).toBe('../attachments/2026-09/diagram.svg')
    expect(plan.insert).toBe('\n\n![diagram](../attachments/2026-09/diagram.svg)\n\n')
    expect(plan.renamedFrom).toBeNull()
    expect(plan.stagedPath).toBe('/home/user/staging/diagram.svg')
  })

  it('references a root-level note without climbing out of the vault', () => {
    const plan = planFor(note({ path: `${VAULT}/a.md` }))
    expect(plan.markdownSrc).toBe('attachments/2026-09/diagram.svg')
  })

  it('turns the spaces and punctuation of an offered name into a vault-safe one and says it did', () => {
    const plan = planFor(note(), { fileName: 'My Diagram (v2).svg' })
    expect(plan.fileName).toBe('My-Diagram-v2.svg')
    expect(plan.renamedFrom).toBe('My Diagram (v2).svg')
  })

  it('keeps a taken name instead of overwriting the file it belongs to', () => {
    const plan = planFor(note(), { takenNames: ['diagram.svg', 'Diagram-2.svg'] })
    expect(plan.fileName).toBe('diagram-3.svg')
    expect(plan.renamedFrom).toBe('diagram.svg')
  })

  it('refuses rather than renaming forever when the destination is full of one name', () => {
    const taken = Array.from({ length: MAX_ATTACHMENT_NAME_ATTEMPTS }, (_, index) =>
      index === 0 ? 'diagram.svg' : `diagram-${index + 1}.svg`,
    )
    expect(planSvgInsertion({
      preview: previewOrThrow(staged(svg(''))),
      target: targetAt(note(), 0),
      identity: identity(),
      destination: { vaultRoot: VAULT, takenNames: taken, now: SEPTEMBER_2026 },
      fileName: 'diagram.svg',
    })).toMatchObject({ status: 'refused', refusal: { reason: 'name-unavailable' } })
  })

  it('refuses a name with nothing usable in it', () => {
    expect(planSvgInsertion({
      preview: previewOrThrow(staged(svg(''))),
      target: targetAt(note(), 0),
      identity: identity(),
      destination: { vaultRoot: VAULT, takenNames: [], now: SEPTEMBER_2026 },
      fileName: '---',
    })).toMatchObject({ status: 'refused', refusal: { reason: 'invalid-file-name' } })
  })

  it('escapes the alt text rather than letting it break the markdown', () => {
    const plan = planFor(note(), { alt: 'a [broken]  alt' })
    expect(plan.insert).toContain('![a broken alt](')
  })

  it('refuses a target captured under another session', () => {
    const target = targetAt(note(), 0)
    expect(planSvgInsertion({
      preview: previewOrThrow(staged(svg(''))),
      target,
      identity: identity({ runtimeEpoch: 'epoch-2' }),
      destination: { vaultRoot: VAULT, takenNames: [], now: SEPTEMBER_2026 },
      fileName: 'diagram.svg',
    })).toEqual({ status: 'refused', refusal: { reason: 'identity-changed', field: 'runtimeEpoch' } })
  })
})

describe('commitSvgInsertion — 切换文档', () => {
  it('inserts the planned text at the captured spot', () => {
    const live = note({ buffer: { state: 'clean', text: 'intro\n\n' } })
    const plan = planFor(live)
    const outcome = commitSvgInsertion(plan, { live, identity: identity(), attachmentSaved: true })
    expect(outcome.status).toBe('inserted')
    if (outcome.status !== 'inserted') return
    expect(outcome.change).toEqual({ from: 7, to: 7, insert: plan.insert })
    const after = live.buffer.text.slice(0, 7) + outcome.change.insert + live.buffer.text.slice(7)
    expect(after).toContain('\n\n![diagram](../attachments/2026-09/diagram.svg)\n\n')
  })

  it('refuses when the note that is open is not the note the plan named', () => {
    const plan = planFor(note())
    const other = note({ path: `${VAULT}/notes/b.md` })
    expect(insertRefusalOf(commitSvgInsertion(plan, { live: other, identity: identity(), attachmentSaved: false }))).toMatchObject({
      reason: 'target-changed',
      path: `${VAULT}/notes/b.md`,
      plannedPath: `${VAULT}/notes/a.md`,
    })
  })

  it('refuses when no tab holds the planned note any more', () => {
    const plan = planFor(note())
    expect(insertRefusalOf(commitSvgInsertion(plan, { live: null, identity: identity(), attachmentSaved: false }))).toMatchObject({
      reason: 'note-not-open',
      path: `${VAULT}/notes/a.md`,
    })
  })

  it('refuses a note that belongs to another vault', () => {
    const plan = planFor(note())
    const moved = note({ vaultId: '/home/user/other' })
    expect(insertRefusalOf(commitSvgInsertion(plan, { live: moved, identity: identity(), attachmentSaved: false }))).toMatchObject({
      reason: 'vault-mismatch',
      itemVaultId: '/home/user/other',
      contextVaultId: VAULT,
    })
  })

  it('refuses when the session identity has moved on', () => {
    const plan = planFor(note())
    const refusal = insertRefusalOf(
      commitSvgInsertion(plan, { live: note(), identity: identity({ sessionId: 'session-2' }), attachmentSaved: false }),
    )
    expect(refusal).toMatchObject({ reason: 'identity-changed', field: 'sessionId' })
  })
})

describe('commitSvgInsertion — 锚点失效', () => {
  it('refuses when an edit before the anchor moved it', () => {
    const live = note({ buffer: { state: 'clean', text: 'intro\n\nbody' } })
    const plan = planFor(live)
    const typed = note({ buffer: { state: 'clean', text: 'Xintro\n\nbody' } })
    expect(insertRefusalOf(commitSvgInsertion(plan, { live: typed, identity: identity(), attachmentSaved: false }))).toMatchObject({
      reason: 'anchor-moved',
    })
  })

  it('refuses when the text at the anchor was replaced by other text of the same length', () => {
    // The offsets are identical, so only the fingerprint catches this: a check on positions alone
    // would insert into a sentence that is no longer the one the user pointed at.
    const live = note({ buffer: { state: 'clean', text: 'keep TARGET keep' } })
    const capture = captureInsertionTarget(live, identity(), { from: 5, to: 11 })
    expect(capture.status).toBe('captured')
    if (capture.status !== 'captured') return
    const plan = planOf({
      preview: previewOrThrow(staged(svg(''))),
      target: capture.target,
      identity: identity(),
      destination: { vaultRoot: VAULT, takenNames: [], now: SEPTEMBER_2026 },
      fileName: 'diagram.svg',
    })
    const replaced = note({ buffer: { state: 'clean', text: 'keep XXXXXX keep' } })
    expect(insertRefusalOf(commitSvgInsertion(plan, { live: replaced, identity: identity(), attachmentSaved: false }))).toMatchObject({
      reason: 'anchor-moved',
    })
  })

  it('refuses before the anchor when the note moved to another revision', () => {
    const live = note()
    const plan = planFor(live)
    const saved = note({ revision: 'rev-2' })
    expect(insertRefusalOf(commitSvgInsertion(plan, { live: saved, identity: identity(), attachmentSaved: false }))).toMatchObject({
      reason: 'revision-changed',
      plannedRevision: 'rev-1',
      currentRevision: 'rev-2',
    })
  })

  it('still inserts after an edit far enough away to leave the spot where it was', () => {
    const text = 'head' + 'x'.repeat(ANCHOR_CONTEXT_CHARS) + 'tail'
    const live = note({ buffer: { state: 'clean', text } })
    const capture = captureInsertionTarget(live, identity(), { from: 4 + ANCHOR_CONTEXT_CHARS, to: 4 + ANCHOR_CONTEXT_CHARS })
    expect(capture.status).toBe('captured')
    if (capture.status !== 'captured') return
    const plan = planOf({
      preview: previewOrThrow(staged(svg(''))),
      target: capture.target,
      identity: identity(),
      destination: { vaultRoot: VAULT, takenNames: [], now: SEPTEMBER_2026 },
      fileName: 'diagram.svg',
    })
    const edited = note({ buffer: { state: 'clean', text: `${text} and more` } })
    expect(commitSvgInsertion(plan, { live: edited, identity: identity(), attachmentSaved: true }).status).toBe('inserted')
  })
})

describe('commitSvgInsertion — 半成品', () => {
  it('refuses the note edit while the attachment has not been written', () => {
    const live = note()
    const plan = planFor(live)
    expect(insertRefusalOf(commitSvgInsertion(plan, { live, identity: identity(), attachmentSaved: false }))).toEqual({
      reason: 'attachment-not-saved',
      path: 'attachments/2026-09/diagram.svg',
      attachmentSaved: false,
    })
  })

  it('says the file is on disk when the note edit is refused after the write', () => {
    // The interrupted insert: the attachment was saved, the note moved, and nothing was inserted.
    // The note is exactly as it was, and the outcome carries what did happen so the user can undo it.
    const plan = planFor(note())
    const moved = note({ revision: 'rev-2' })
    const refusal = insertRefusalOf(commitSvgInsertion(plan, { live: moved, identity: identity(), attachmentSaved: true }))
    expect(refusal.reason).toBe('revision-changed')
    expect(refusal.attachmentSaved).toBe(true)
  })

  it('places the same insert again without writing a second copy of the picture', () => {
    const plan = planFor(note())
    const moved = note({ revision: 'rev-2', buffer: { state: 'clean', text: 'a different note entirely\n' } })
    const refusal = insertRefusalOf(commitSvgInsertion(plan, { live: moved, identity: identity(), attachmentSaved: true }))
    expect(refusal.reason).toBe('revision-changed')

    // The re-confirmation §7.3 asks for: the user points at the spot again, and the attachment the
    // caller has already saved keeps its name and its reference point.
    const again = retargetSvgInsertion(plan, targetAt(moved, moved.buffer.text.length))
    expect(again.fileName).toBe(plan.fileName)
    expect(again.vaultPath).toBe(plan.vaultPath)
    expect(again.path).toBe(moved.path)
    expect(commitSvgInsertion(again, { live: moved, identity: identity(), attachmentSaved: true }).status).toBe('inserted')
  })
})

describe('agent-composition — the binding a caller holds', () => {
  function editorWith(notes: readonly AgentLiveNote[]) {
    const asked: string[] = []
    return {
      asked,
      liveNote(path: string): AgentLiveNote | null {
        asked.push(path)
        return notes.find((held) => held.path === path) ?? null
      },
    }
  }

  it('captures a note the session owns and refuses one it does not', () => {
    const owned = note()
    const foreign = note({ vaultId: '/home/user/other', path: '/home/user/other/a.md' })
    const composition = createAgentComposition({ environment: 'browser', vaultId: VAULT })
    const binding = composition.connectSvgInsertion(identity(), editorWith([owned, foreign]))

    expect(binding.capture(owned.path, 0, 0).status).toBe('captured')
    expect(binding.capture(foreign.path, 0, 0)).toMatchObject({
      status: 'refused',
      refusal: { reason: 'vault-mismatch' },
    })
  })

  it('refuses a note no tab holds', () => {
    const composition = createAgentComposition({ environment: 'browser', vaultId: VAULT })
    const binding = composition.connectSvgInsertion(identity(), editorWith([]))
    expect(binding.capture(`${VAULT}/notes/a.md`, 0, 0)).toEqual({
      status: 'refused',
      refusal: { reason: 'note-not-open', path: `${VAULT}/notes/a.md` },
    })
  })

  it('asks the editor for the note the plan named, never for whatever is open', () => {
    const live = note()
    const editor = editorWith([live])
    const composition = createAgentComposition({ environment: 'browser', vaultId: VAULT })
    const binding = composition.connectSvgInsertion(identity(), editor)
    const capture = binding.capture(live.path, 7, 7)
    if (capture.status !== 'captured') throw new Error('capture refused')
    const planned = binding.plan({
      preview: previewOrThrow(staged(svg(''))),
      target: capture.target,
      destination: { vaultRoot: VAULT, takenNames: [], now: SEPTEMBER_2026 },
      fileName: 'diagram.svg',
    })
    if (planned.status !== 'planned') throw new Error('plan refused')
    editor.asked.length = 0

    expect(binding.commit(planned.plan, true).status).toBe('inserted')
    expect(editor.asked).toEqual([live.path])
  })

  it('refuses a plan made under another session', () => {
    const live = note()
    const composition = createAgentComposition({ environment: 'browser', vaultId: VAULT })
    const first = composition.connectSvgInsertion(identity(), editorWith([live]))
    const capture = first.capture(live.path, 7, 7)
    if (capture.status !== 'captured') throw new Error('capture refused')
    const planned = first.plan({
      preview: previewOrThrow(staged(svg(''))),
      target: capture.target,
      destination: { vaultRoot: VAULT, takenNames: [], now: SEPTEMBER_2026 },
      fileName: 'diagram.svg',
    })
    if (planned.status !== 'planned') throw new Error('plan refused')

    // The runtime restarted: a new binding, a new session, and the plan's identity is refused by
    // the service rather than inserted under the session that replaced it.
    const second = composition.connectSvgInsertion(
      identity({ runtimeEpoch: 'epoch-2', sessionId: 'session-2' }),
      editorWith([live]),
    )
    expect(second.commit(planned.plan, true)).toMatchObject({
      status: 'refused',
      refusal: { reason: 'identity-changed', field: 'runtimeEpoch' },
    })
  })
})
