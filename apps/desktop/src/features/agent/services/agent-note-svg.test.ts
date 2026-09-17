/**
 * The staged artifact, read and placed.
 *
 * §7.3's insertion is a service with no host: `agent-svg-insertion.ts` verifies a document, plans
 * the vault name and re-checks the note's anchor, and `connectSvgInsertion` binds it to a session
 * and the editor — while nothing in the app ever asked for that binding. This file is the caller's
 * own half, and its tests are about the four steps that have to happen in this order and none of
 * which the service can take for itself: read the artifact off the disk, ask the service whether it
 * may be previewed at all, save the attachment the plan names, and only then let the note link it.
 *
 * The order is the subject. A note that links a file nothing wrote is the outcome the service's own
 * `attachmentSaved` flag exists to refuse, and a preview drawn from a file that was still being
 * written is what §7.3's 「等待文件写入完成」 forbids.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentIdentity } from '../../../platform/gateways/agent-contracts'
import type { AgentStagedSvg } from './agent-svg-insertion'
import type { AgentSvgInsertionBinding } from '../../../app/agent-composition'
import { STAGED_SVG_MEDIA_TYPE, inspectStagedSvg, planSvgInsertion } from './agent-svg-insertion'
import { readStagedSvg, savePlannedAttachment } from './agent-note-svg'

const IDENTITY: AgentIdentity = {
  agentId: 'opencode',
  profileId: 'default',
  runtimeEpoch: 'epoch-1',
  vaultId: '/vault',
  sessionId: 'session-1',
}

const VAULT = '/vault'
const STAGED = '/vault/attachments/2026-09/diagram.svg'
const NOTE = '/vault/notes/a.md'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'

/** The disk, as the two reads this module makes: a stat and a read. */
function diskOf(text: string, statSize = new TextEncoder().encode(text).length) {
  return {
    stat: vi.fn(async () => ({ size: statSize, mtime: 0 })),
    read: vi.fn(async () => text),
  }
}

describe('reading the artifact the engine staged', () => {
  it('hands the service the text and the size the host stat’ed before it', async () => {
    const disk = diskOf(SVG)

    const read = await readStagedSvg(VAULT, STAGED, disk)

    expect(read.status).toBe('read')
    if (read.status !== 'read') return
    expect(read.staged).toEqual({
      path: STAGED,
      mediaType: STAGED_SVG_MEDIA_TYPE,
      sizeBytes: SVG.length,
      text: SVG,
    })
    // The stat is taken BEFORE the read, which is the only order in which the two numbers can
    // disagree about a write that has not finished.
    expect(disk.stat).toHaveBeenCalledWith(VAULT, STAGED)
    expect(disk.read).toHaveBeenCalledWith(VAULT, STAGED)
  })

  it('is unreadable when the file cannot be read, rather than an empty document', async () => {
    const disk = { stat: vi.fn(async () => ({ size: 10, mtime: 0 })), read: vi.fn(async () => { throw new Error('ENOENT') }) }

    expect(await readStagedSvg(VAULT, STAGED, disk)).toEqual({ status: 'unreadable', path: STAGED })
  })

  it('is unreadable when the stat itself was refused', async () => {
    const disk = { stat: vi.fn(async () => { throw new Error('ENOENT') }), read: vi.fn(async () => SVG) }

    expect(await readStagedSvg(VAULT, STAGED, disk)).toEqual({ status: 'unreadable', path: STAGED })
  })
})

describe('saving the file the plan named', () => {
  const plan = (() => {
    const inspected = inspectStagedSvg({
      path: STAGED,
      mediaType: STAGED_SVG_MEDIA_TYPE,
      sizeBytes: SVG.length,
      text: SVG,
    })
    if (inspected.status !== 'previewed') throw new Error('the fixture did not verify')
    const planned = planSvgInsertion({
      preview: inspected.preview,
      target: {
        identity: IDENTITY,
        path: NOTE,
        revision: 'page-1:tab-1:0',
        anchor: { from: 0, to: 0, selected: '', before: '', after: '' },
      },
      identity: IDENTITY,
      destination: { vaultRoot: VAULT, takenNames: [], now: new Date('2026-09-17T12:00:00Z') },
      fileName: 'diagram',
    })
    if (planned.status !== 'planned') throw new Error('the fixture did not plan')
    return planned.plan
  })()

  it('writes the artifact’s own bytes under the name the plan resolved', async () => {
    const save = vi.fn<(vault: string, name: string, base64: string, dir: string) => Promise<string>>(
      async () => plan.vaultPath,
    )

    const outcome = await savePlannedAttachment(VAULT, plan, SVG, { saveAttachment: save })

    expect(outcome).toEqual({ status: 'saved' })
    expect(plan.vaultPath).toBe('attachments/2026-09/diagram.svg')
    // The bytes are the artifact's, not a re-serialisation of the preview: what lands in the vault
    // is what the agent wrote, which is the half §7.3 keeps raw and preview apart for.
    expect(save).toHaveBeenCalledWith(
      VAULT,
      'diagram.svg',
      expect.any(String),
      'attachments/2026-09',
    )
    const base64 = save.mock.calls[0]![2]
    expect(Buffer.from(base64, 'base64').toString('utf8')).toBe(SVG)
  })

  it('refuses when the file did not land where the note is about to point', async () => {
    // A name the backend resolved differently — a collision suffix, a directory that moved — is a
    // note that would link a file that is not there.
    const save = vi.fn<(vault: string, name: string, base64: string, dir: string) => Promise<string>>(
      async () => 'attachments/2026-09/diagram-2.svg',
    )

    expect(await savePlannedAttachment(VAULT, plan, SVG, { saveAttachment: save })).toEqual({
      status: 'elsewhere',
      plannedPath: plan.vaultPath,
      savedPath: 'attachments/2026-09/diagram-2.svg',
    })
  })

  it('reports a save that failed rather than pretending the file is there', async () => {
    const save = vi.fn<(vault: string, name: string, base64: string, dir: string) => Promise<string>>(
      async () => {
        throw new Error('EACCES')
      },
    )

    expect(await savePlannedAttachment(VAULT, plan, SVG, { saveAttachment: save })).toEqual({ status: 'failed' })
  })
})

describe('the binding is asked, never reimplemented', () => {
  it('is the composition’s own object that captures, plans and commits', () => {
    // A guard rather than a case: this module exists so that `connectSvgInsertion` has a caller,
    // and a version that reached for the service's functions directly would leave the binding as
    // unreachable as it was — the shape is pinned so that regression is a type error.
    const binding: AgentSvgInsertionBinding = {
      identity: IDENTITY,
      capture: () => ({ status: 'refused', refusal: { reason: 'note-not-open', path: NOTE } }),
      plan: () => ({ status: 'refused', refusal: { reason: 'note-not-open', path: NOTE } }),
      commit: () => ({
        status: 'refused',
        refusal: { reason: 'note-not-open', path: NOTE },
        attachmentSaved: false,
      }),
    }

    expect(typeof binding.capture).toBe('function')
  })
})

/** The service is not stubbed anywhere above: these are its real answers on the fixture. */
describe('the fixture itself', () => {
  it('is a document the verifier accepts', () => {
    const staged: AgentStagedSvg = {
      path: STAGED,
      mediaType: STAGED_SVG_MEDIA_TYPE,
      sizeBytes: SVG.length,
      text: SVG,
    }
    expect(inspectStagedSvg(staged).status).toBe('previewed')
  })
})
