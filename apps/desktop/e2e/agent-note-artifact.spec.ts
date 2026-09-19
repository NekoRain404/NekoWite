/**
 * The artifact the run staged for one note, decided while the reader is in another one.
 *
 * §7.3 clause 5 is「插入绑定原文档 revision 和锚点；用户已经切换笔记或移动编辑位置时重新确认，不插到新活动
 * 文档」, and this file is about the last three of those words. The first half has an owner and a
 * unit test — the service refuses rather than inserting near where the reader meant — but the
 * refusal on its own is a dead end: a reader who moved to another note while the offer was on
 * screen gets a sentence and no way to say "yes, put it here". `retargetSvgInsertion` has existed
 * for exactly that answer since T11 and had no caller in the tree at all, which is this project's
 * signature failure — a thing that passes its own spec and reaches nobody. So the assertions here
 * are about what the reader ends up looking at, after pressing the controls.
 *
 * ## The click path, hop by hop (each `file:line` is where the next hop is written)
 *
 *   the tree's own row (`support/editorHarness.ts:190` `openFromTree`) opens `welcome.md`
 *   → `ui/EditorPane.vue:202` mounts `features/agent/components/AgentNoteProposals.vue`
 *   → `AgentNoteProposals.vue:169` `useAgentNoteArtifact({ proposal, identity, insertions, path, onDecided })`
 *   → `composables/use-agent-note-artifact.ts:270` `insert()` plans through
 *     `app/agent-composition.ts:268` `connectSvgInsertion`'s binding
 *   → `:294`'s refusal (`note-switched`) keeps the plan and draws the sentence
 *   → `AgentNoteProposals.vue:337`'s `agent-artifact-reconfirm` → `use-agent-note-artifact.ts:322`
 *     `confirm()`, which retargets the kept plan onto the note in front
 *     (`services/agent-svg-insertion.ts:317`) and runs the same save-commit-write tail as the
 *     ordinary press.
 *
 * ## What is real here, and what is a stand-in
 *
 * Real: the application the dev server serves, booted on its own vault through the app's own Tauri
 * stub, the note tree, the editor, the tab store, the catalogue's sentences, both notes' bytes on
 * the disk the app writes to, and the composition's own insertion binding — the object
 * `AgentNoteProposals` is handed in `AppShell.vue`.
 *
 * A stand-in, and named because it is the one thing this file cannot press: the proposal's own
 * arrival. It comes from the engine (`AgentToolContent`'s write-kind call naming an `.svg`), and
 * the browser run has no engine — the app's own rail refuses to start one here, because a page
 * whose `__TAURI_INTERNALS__` is a stub believes it is on Tauri and asks the *host* for a runtime
 * that a browser does not have. So the frame is pushed onto the T1 memory double, through
 * `gateway.emit`, exactly as `agent-panel.spec.ts` and `agent-changes.spec.ts` push theirs; the
 * component, the surface and the document below it are the product's own.
 *
 * The surface is mounted *into the editor pane's own element* — the one `EditorPane.vue:202` puts
 * it in — rather than onto `document.body`, so the controls are laid out where the product lays
 * them out and the clicks are real clicks on real boxes.
 */
import { expect, test, type Page } from '@playwright/test'
import { DEFAULT_DOC, diskFiles, openFromTree, openNote } from './support/editorHarness'

/** The note the reader is in when the artifact arrives — the one the offer is made for. */
const FIRST = 'welcome.md'
const FIRST_PATH = `test-fixtures/${FIRST}`
/** The note they move to before deciding. In another directory on purpose: a reference measured
 *  from here is a different string from one measured from the vault root, so "it went into the
 *  note the reader is in" is an assertion about the link, not only about which file changed. */
const SECOND_NAME = 'second.md'
const SECOND_PATH = `test-fixtures/journal/${SECOND_NAME}`
const SECOND_DOC = '# Second\n\nthe note the reader moves to\n'
/** The file the engine staged, where a write-kind call would have named it. */
const STAGED = 'test-fixtures/attachments/2026-09/diagram.svg'
const MARKUP =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#123"/></svg>'
const HOST_ID = 'agent-note-artifact-e2e'

interface ArtifactHarness {
  /**
   * The offer arriving: the engine's own frame for a write-kind call that named the staged file,
   * pushed onto the session's stream the way the runtime pushes it.
   */
  propose(): Promise<void>
  /** The month directory the plan resolves into, as the app's own function spells it. */
  monthDir(): Promise<string>
}

declare global {
  interface Window {
    __agentArtifact?: ArtifactHarness
  }
}

/** The dev server's URLs for the two dependencies the page's modules already use. */
async function viewDeps(page: Page): Promise<{ vue: string, pinia: string }> {
  return page.evaluate(async () => {
    const source = await (await fetch('/src/main.ts')).text()
    const find = (name: string): string => {
      const match = source.match(new RegExp(`["']([^"']*/deps/${name}\\.js[^"']*)["']`))
      if (match === null) throw new Error(`the dev server serves no ${name} dependency`)
      return match[1]
    }
    return { vue: find('vue'), pinia: find('pinia') }
  })
}

/**
 * Put the artifact surface in the editor pane, on a session the memory double serves.
 *
 * The store, the tab store and the pinia are the application's own — this mounts one component
 * into the running app rather than building a second one beside it, which is what keeps the vault,
 * the open notes and the sentences the same ones the reader has.
 */
async function mountArtifactSurface(page: Page): Promise<void> {
  const deps = await viewDeps(page)
  await page.evaluate(
    async ({ deps: urls, hostId, staged }) => {
      const vue = (await import(/* @vite-ignore */ urls.vue)) as typeof import('vue')
      const pinia = (await import(/* @vite-ignore */ urls.pinia)) as typeof import('pinia')
      const { default: AgentNoteProposals } = await import(
        /* @vite-ignore */ '/src/features/agent/components/AgentNoteProposals.vue'
      )
      const { createAgentComposition } = await import('/src/app/agent-composition.ts')
      const { createMemoryAgentGateway } = await import('/src/platform/gateways/memory-agent.ts')
      const { useAgentSessionStore } = await import('/src/features/agent/stores/agent-session.ts')
      const { sessionKey } = await import('/src/features/agent/services/agent-session-view.ts')
      const { useTabsStore } = await import('/src/stores/tabs.ts')

      // The application's own pinia: the tab store below has to be the one the open notes live in.
      const active = pinia.getActivePinia()
      if (active === undefined) throw new Error('the application installed no pinia')
      const tabs = useTabsStore()
      const vault = tabs.vault
      if (vault === null) throw new Error('the application has no vault open')

      const gateway = createMemoryAgentGateway({ agentId: 'memory-e2e', profileId: 'e2e' })
      await gateway.start()
      const session = await gateway.openSession({ vaultId: vault, cwd: vault })
      // The composition the shell hands the pane, built the way a browser build builds it. Its
      // default live-note source is the tab store's own lookup, which is the one the editor's
      // account of a note comes from — the same object `AppShell.vue` passes down.
      const insertions = createAgentComposition({ vaultId: vault, environment: 'browser' })

      const store = useAgentSessionStore()
      await store.attach(gateway, session)
      const key = sessionKey(session)

      // §7.3 clause 1 compares the size a file declared with the bytes that were read, and the
      // shared stub answers `stat_file` with one byte for every file — which for a staged artifact
      // is the honest refusal "still being written". A spec whose subject is what happens *after*
      // the artifact was read needs a stat that tells the truth about this one file, and it is
      // this file only: the rest of the stub is left exactly as every other spec finds it.
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> }
      }).__TAURI_INTERNALS__
      const invoke = internals.invoke.bind(internals)
      internals.invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
        if (cmd === 'stat_file' && args.path === staged) {
          const text = (await invoke('read_file', { vault_root: args.vault_root, path: staged })) as string
          return { size: new TextEncoder().encode(text).length, mtime: 1 }
        }
        return invoke(cmd, args)
      }

      const pane = document.querySelector('.editor-pane')
      if (pane === null) throw new Error('the editor pane is not on screen')
      const host = document.createElement('div')
      host.id = hostId
      pane.prepend(host)
      const app = vue.createApp({
        render: () =>
          vue.h(AgentNoteProposals, { identity: session, insertions }),
      })
      app.use(active)
      app.mount(host)

      window.__agentArtifact = {
        propose: async () => {
          // A run has to be live, and it has to be the *store's own* run: a frame for a run this
          // window never started is refused (`illegal-transition`), which is what stops a stray
          // frame from beginning a run the user did not ask for. So the turn goes through the
          // store's `send` — the door the composer uses — with a script that says one thing and
          // hangs, which is the shape the panel's own specs drive their tool rows with. `send` is
          // not awaited: a hanging turn's promise never settles.
          gateway.script({ chunks: ['Drawing the diagram. '], hang: true })
          void store.send(key, 'draw me a diagram').catch(() => {})
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (store.recordFor(key)?.view.state === 'running') break
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
          if (store.recordFor(key)?.view.state !== 'running') throw new Error('the run never started')
          gateway.emit(session, {
            kind: 'tool-update',
            payload: {
              toolCallId: 'call-svg',
              title: 'Wrote diagram.svg',
              kind: 'edit',
              status: 'completed',
              paths: [staged],
              content: [],
              input: { state: 'absent' },
              output: { state: 'absent' },
            },
          })
          // One turn of the loop per Vue flush the frame needs to reach the tree.
          for (let round = 0; round < 5; round += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0))
          }
        },
        monthDir: async () => {
          const attachments = await import('/src/features/attachments/index.ts')
          return attachments.attachmentMonthDir()
        },
      }
    },
    { deps, hostId: HOST_ID, staged: STAGED },
  )
  // The host is in the pane. Nothing is drawn in it yet: the offer arrives when the engine's frame
  // does, and the test below waits for that.
  await expect(page.locator(`#${HOST_ID}`)).toBeAttached({ timeout: 5000 })
}

const propose = (page: Page): Promise<void> =>
  page.evaluate(async () => {
    const harness = window.__agentArtifact
    if (harness === undefined) throw new Error('the artifact surface is not mounted')
    await harness.propose()
  })

test('the offer is decided from the note the reader is in, not the one it was made for', async ({ page }) => {
  await openNote(page, {
    files: { [SECOND_PATH]: SECOND_DOC, [STAGED]: MARKUP },
  })
  await mountArtifactSurface(page)
  await propose(page)

  const outcome = page.locator('[data-agent-artifact-outcome]')
  const row = page.locator('[data-agent-note-artifact]')
  const sentence = (key: string, params?: Record<string, unknown>): Promise<string> =>
    page.evaluate(
      async ({ key: k, params: p }) => {
        const i18n = await import('/src/i18n/index.ts')
        return i18n.t(k, p)
      },
      { key, params },
    )

  // The artifact arrived while `welcome.md` was in front, and the verified preview is drawn — the
  // serialiser's own output, which is the only string §7.3 clause 3 lets a surface render.
  await expect(row).toBeVisible()
  await expect(row.locator('[data-artifact-preview] svg')).toHaveCount(1)

  // The reader moves to the other note through the tree, the same way they opened the first one.
  await openFromTree(page, SECOND_NAME)
  await expect(page.locator('.pane.rendered .ProseMirror')).toContainText('the note the reader moves to')

  // The offer is still on screen: it is about the artifact, and nothing has been decided about it.
  await expect(row).toBeVisible()

  const before = await diskFiles(page)
  await page.locator('[data-action="agent-artifact-insert"]').click()

  // 不插到新活动文档: the press wrote nothing at all — neither note gained a link, and the vault
  // gained no copy of the picture — and it says which note the insertion was prepared for, because
  // that is the note the reader can no longer see.
  await expect(outcome).toContainText(
    await sentence('agent.note.svg.outcome.noteSwitched', { planned: FIRST_PATH }),
  )
  expect(await diskFiles(page), 'the refused press wrote to the vault').toEqual(before)
  expect(before[FIRST_PATH], 'the first note was not the document it booted as').toBe(DEFAULT_DOC)

  // 重新确认, in the reader's own hands: the second answer is what puts it in the note in front.
  const reconfirm = page.locator('[data-action="agent-artifact-reconfirm"]')
  await expect(reconfirm).toBeVisible()
  await reconfirm.click()

  await expect(outcome).toHaveText(await sentence('agent.note.svg.outcome.inserted'))
  const month = await page.evaluate(async () => (await window.__agentArtifact?.monthDir()) ?? '')
  const after = await diskFiles(page)
  // The link is in the note the reader was in, and its reference is measured from THAT note's
  // directory (`../`, because this note is one level below the vault root) — which is what makes
  // the image resolve from where it was put. The two notes are in different directories on
  // purpose: a reference measured from the wrong one is a different string, so this assertion is
  // about which note the link is *for*, not only about which file gained a line.
  expect(after[SECOND_PATH]).toContain(`![diagram](../attachments/${month}/diagram.svg)`)
  // And the note the offer was about is exactly as it was: this is the note the refusal protected.
  expect(after[FIRST_PATH], 'the insertion reached the note the offer was made for').toBe(DEFAULT_DOC)
  await expect(page.locator('[data-action="agent-artifact-reconfirm"]')).toHaveCount(0)
})
