/**
 * E2 — the change view, in a real browser.
 *
 * §10.2's T10 row, and the three clauses it is judged by are about *what a person is told*, which
 * is why the rules are held in `agent-change-review.test.ts` (V8) and what is checked here is that
 * the surface tells the truth about them: a file the watcher alone saw is not presented as the
 * agent's work, a note with unsaved edits shows both texts instead of one of them, and nothing on
 * screen claims a recovery the host has not performed.
 *
 * ## What is driven here, and what is not
 *
 * The review itself is the real service, and the events are real ones: a session is opened on the
 * memory runtime from T1 and the frames are pushed through `gateway.subscribe`, so what the panel
 * renders is what the contract's own validator let through. The view component is mounted directly
 * rather than found in the editor workspace, for the reason E1 and E4 mount theirs: hosting the
 * review is T16's wiring, and until it exists there is nothing in the running application to
 * drive. Every assertion below stays true once the workspace hosts it.
 *
 * The host is a fake in the page, and it is deliberately a *fake*: T10's front end cannot write a
 * file at all — that is the property `no click here reaches a document` asserts — so what the fake
 * provides is the edit the user is typing into, which is the one thing this feature must not lose.
 *
 * Vue is imported by URL rather than by name: a page has no import map, and the component has to be
 * compiled against the *same* Vue instance the dev server serves, not a second copy.
 */
import { expect, test, type Page } from '@playwright/test'
import type { Component } from 'vue'
import type { AgentChangesLabels } from '/src/features/agent/components/AgentChangesView.vue'
import type { AgentToolKind, AgentToolStatus } from '/src/platform/gateways/agent-contracts.ts'

const COMPONENT_URL = '/src/features/agent/components/AgentChangesView.vue'
const HOST_ID = 'agent-changes-e2e'

/**
 * The copy the view draws, as the caller that mounts it supplies it.
 *
 * Nothing below asserts on these strings: they are the panel's words rather than the engine's, and
 * a test that matched them would break on a reworded label. The `data-*` attributes are what the
 * assertions read, which is also what keeps them about the facts.
 */
const LABELS: AgentChangesLabels = {
  title: 'Changes',
  empty: 'Nothing has changed yet',
  summary: '3 files changed · 1 kept · 0 put back · 2 to review',
  collapse: 'Hide the list',
  expand: 'Show the list',
  attribution: {
    agent: 'The agent changed this file',
    external: 'This file changed outside the agent',
    reported: 'The engine reported this file',
  },
  verdict: {
    followsDisk: 'No unsaved edits in this note',
    unsavedEdits: 'This note has unsaved edits',
  },
  offer: { view: 'Review', keep: 'Keep', recover: 'Reject' },
  refused: {
    notAgentChange: 'Nothing here recorded a change to put back',
    writeInFlight: 'The agent is still writing this file',
    noBaseline: 'No request named this file',
    vaultMismatch: 'This note is in another vault',
    noteNotOpen: 'No tab holds this note',
    unsavedEdits: 'Deal with the note\u2019s unsaved edits first',
    resultUnstated: 'The call did not say what it left',
    changedSince: 'The note is no longer what the agent left',
  },
  decision: { kept: 'Kept', rejected: 'Put back' },
  written: {
    saved: 'The note is back and the file has it',
    saveFailed: 'The note is back, but the file does not have it',
    unavailable: 'Nothing took the text',
  },
  unsavedBuffer: 'Your unsaved text',
  agentVersion: 'What the call left in the file',
  diskUnread: 'The file was not read',
}

/** What the page keeps between calls: the runtime it drives, and what the view emitted. */
interface ChangesHarness {
  /** Every event the view raised, in order, as `[action, path]`. */
  emitted: Array<[string, string]>
  /** The editor's own text per path — the thing no click here may change. */
  buffers: Record<string, string>
  /** The paths the rows currently name, in order. */
  paths(): string[]
  /** One write-kind tool call, as the engine sends it. */
  write(
    toolCallId: string,
    paths: string[],
    status: AgentToolStatus,
    kind?: AgentToolKind,
    diff?: { oldText: string; newText: string },
  ): void
  /** The engine's own list of paths it touched — a hint, never an attribution. */
  hint(paths: string[]): void
  /** The watcher: this file is not what the window last saw. */
  observed(path: string): void
  /** The version the request that named this path captured: what a rejection would put back. */
  baseline(path: string, text: string): void
  /** The caller recording an answer, the way the host does after its write. */
  answer(path: string, toolCallId: string, decision: 'kept' | 'rejected', written?: string): void
  setDirty(path: string, text: string, diskText: string | null): void
  setClean(path: string, text: string): void
  /** Take the section off screen, so a re-open does not leave two hosts answering one selector. */
  unmount?: () => void
}

declare global {
  interface Window {
    __agentChanges?: ChangesHarness
  }
}

/**
 * Put the change view on screen against a live session.
 *
 * The session is opened and subscribed before the component exists, so the review's state and the
 * component's props are the same object's two states rather than two subscriptions that could
 * disagree.
 */
async function open(page: Page): Promise<void> {
  await page.evaluate(
    async ({ url, serviceUrl, labels, hostId }) => {
      // The Vue the page's own modules already use, discovered from the dev server's transform of
      // `main.ts` rather than passed in: the URL has to be resolved in the realm that will import
      // it, and a value computed outside `page.evaluate` is not in scope here — the function is
      // serialised and run in the browser, so a closure variable is a ReferenceError, not a URL.
      const source = await (await fetch('/src/main.ts')).text()
      const vueUrl = source.match(/["']([^"']*\/deps\/vue\.js[^"']*)["']/)?.[1]
      if (vueUrl === undefined) throw new Error('the dev server serves no vue dependency')
      const vue = (await import(/* @vite-ignore */ vueUrl)) as typeof import('vue')
      const { default: AgentChangesView } = (await import(/* @vite-ignore */ url)) as {
        default: Component
      }
      const review = await import(/* @vite-ignore */ serviceUrl)
      const { createMemoryAgentGateway } = await import('/src/platform/gateways/memory-agent.ts')

      window.__agentChanges?.unmount?.()

      const gateway = createMemoryAgentGateway({ agentId: 'memory-e2e', profileId: 'e2e' })
      await gateway.start()
      const session = await gateway.openSession({ vaultId: 'e2e-vault', cwd: '/vault' })

      // The review, fed by the session's own stream. `subscribe` replays from the snapshot and then
      // delivers live, so an event pushed with `emit` arrives here exactly as a replayed one does.
      // The session *is* the identity — `AgentSession extends AgentIdentity`, and the handle is
      // the one thing here that carries the vault, the epoch and the session id. `createChangeReview`
      // copies what it is given, so handing it the handle is the same thing as handing it a copy.
      let state = review.createChangeReview(session)
      await gateway.subscribe(await gateway.snapshot(session), (event: unknown) => {
        state = review.applyChangeEvent(state, event)
      })

      const buffers = new Map<string, { text: string; diskText: string | null; dirty: boolean }>()
      const live = (path: string) => {
        const held = buffers.get(path)
        if (held === undefined) return null
        return {
          vaultId: 'e2e-vault',
          path,
          revision: 'r1',
          buffer: held.dirty
            ? { state: 'dirty' as const, text: held.text, diskText: held.diskText }
            : { state: 'clean' as const, text: held.text },
        }
      }

      const emitted: Array<[string, string]> = []
      const view = vue.reactive({ rows: [] as unknown[], open: true })
      const refresh = (): void => {
        view.rows = [...review.changeRows(state, live)]
      }

      const host = document.createElement('div')
      host.id = hostId
      // Fixed and out of the application's flow: the app is running on this page, and a panel that
      // took part in its layout would be measuring the app as much as itself.
      host.style.cssText =
        'position: fixed; top: 0; left: 0; width: 420px; max-height: 100vh; overflow: auto; z-index: 60;'
      document.body.append(host)

      const app = vue.createApp({
        render: () =>
          vue.h(AgentChangesView, {
            rows: view.rows,
            labels,
            open: view.open,
            onView: (path: string) => emitted.push(['view', path]),
            onKeep: (path: string) => emitted.push(['keep', path]),
            onRecover: (path: string) => emitted.push(['recover', path]),
            onToggle: () => {
              emitted.push([view.open ? 'collapse' : 'expand', ''])
              view.open = !view.open
            },
          }),
      })
      app.mount(host)

      // The editor's text as the spec can read it back. Kept apart from the `Map` the view is
      // given, because what this proves is that the two never diverge.
      const bufferTexts: Record<string, string> = {}

      const harness: ChangesHarness = {
        emitted,
        buffers: bufferTexts,
        paths: () => view.rows.map((row) => (row as { path: string }).path),
        write: (toolCallId, paths, status, kind = 'edit', diff) => {
          gateway.emit(session, {
            kind: 'tool-update',
            payload: {
              toolCallId,
              title: `${kind} ${paths.join(', ')}`,
              kind,
              status,
              paths,
              // The measured frame's own shape: a `diff` block per path, with the text the engine
              // started from and the text it left. That second text is what a rejection is judged
              // against, so a harness with none could not reach the offer at all.
              content: diff === undefined ? [] : paths.map((path) => ({
                type: 'diff' as const,
                path,
                oldText: diff.oldText,
                newText: diff.newText,
              })),
              input: { state: 'absent' },
              output: { state: 'absent' },
            },
          })
          refresh()
        },
        baseline: (path, text) => {
          // The version a request that named this path captured, hand-built because a session
          // opened on the memory double has no send behind it: it is plain data, and the module
          // reads it as such.
          state = {
            ...state,
            baselines: [
              ...state.baselines.filter((held: { path: string }) => held.path !== path),
              { identity: { ...session }, path, revision: 'r1', text },
            ],
          }
          refresh()
        },
        answer: (path, toolCallId, decision, written) => {
          state = review.decideChange(state, {
            path,
            toolCallId,
            decision,
            written: written === undefined ? null : { status: written },
          })
          refresh()
        },
        hint: (paths) => {
          gateway.emit(session, { kind: 'files-changed', payload: { paths } })
          refresh()
        },
        observed: (path) => {
          state = review.observeDiskChange(state, path)
          refresh()
        },
        setDirty: (path, text, diskText) => {
          buffers.set(path, { text, diskText, dirty: true })
          bufferTexts[path] = text
          refresh()
        },
        setClean: (path, text) => {
          buffers.set(path, { text, diskText: null, dirty: false })
          bufferTexts[path] = text
          refresh()
        },
        unmount: () => app.unmount(),
      }
      window.__agentChanges = harness
      refresh()
      await vue.nextTick()
    },
    { url: COMPONENT_URL, serviceUrl: '/src/features/agent/services/agent-change-review.ts', labels: LABELS, hostId: HOST_ID },
  )
  await expect(page.locator('[data-agent-changes]')).toBeVisible()
}

const paths = (page: Page) => page.evaluate(() => window.__agentChanges?.paths() ?? [])
const emitted = (page: Page) => page.evaluate(() => window.__agentChanges?.emitted ?? [])
const bufferText = (page: Page, path: string) =>
  page.evaluate((p) => window.__agentChanges?.buffers[p] ?? null, path)

/** One row, by path. The path is unique per row, so the locator needs no index. */
const row = (page: Page, path: string) => page.locator(`[data-path="${path}"][data-attribution]`)
/** A control inside that row. */
const action = (page: Page, path: string, name: string) =>
  row(page, path).locator(`[data-action="${name}"]`)

test.describe('what the change view claims', () => {
  test('the agent’s own record decides the attribution, and a hint is not one', async ({ page }) => {
    await page.goto('/')
    await open(page)

    await page.evaluate(() => {
      const harness = window.__agentChanges
      if (harness === undefined) throw new Error('the view is not mounted')
      // A write-kind call of this session: the agent's change. Its own `diff` block is what a
      // rejection is judged against, and the request's captured version is what it would put back.
      harness.write('call-1', ['notes/written.md'], 'completed', 'edit', { oldText: 'before', newText: 'after' })
      harness.baseline('notes/written.md', 'before')
      harness.setClean('notes/written.md', 'after')
      // The engine's own list of what it touched: a row, and no attribution.
      harness.hint(['notes/hinted.md'])
      // The watcher, with nothing in the session claiming the path.
      harness.observed('notes/outside.md')
      // A read names a file too, and reads nothing into this list.
      harness.write('call-2', ['notes/read.md'], 'completed', 'read')
    })

    expect(await paths(page)).toEqual(['notes/written.md', 'notes/hinted.md', 'notes/outside.md'])
    await expect(row(page, 'notes/written.md')).toHaveAttribute('data-attribution', 'agent')
    await expect(row(page, 'notes/hinted.md')).toHaveAttribute('data-attribution', 'reported')
    await expect(row(page, 'notes/outside.md')).toHaveAttribute('data-attribution', 'external')

    // The two the host cannot vouch for offer nothing but looking: a recovery button on either
    // would be a claim that this host recorded a change it never made.
    for (const path of ['notes/hinted.md', 'notes/outside.md']) {
      await expect(action(page, path, 'view')).toBeVisible()
      await expect(action(page, path, 'recover')).toHaveCount(0)
      await expect(row(page, path).locator('[data-refused]')).toHaveAttribute(
        'data-refusal',
        'not-agent-change',
      )
    }
    await expect(action(page, 'notes/written.md', 'recover')).toBeVisible()
  })

  test('a note with unsaved edits shows both texts, and the recovery is withheld', async ({ page }) => {
    await page.goto('/')
    await open(page)

    await page.evaluate(() => {
      const harness = window.__agentChanges
      if (harness === undefined) throw new Error('the view is not mounted')
      harness.write('call-1', ['notes/a.md'], 'completed', 'edit', { oldText: 'first line', newText: 'the agent\u2019s line' })
      harness.baseline('notes/a.md', 'first line')
      harness.setDirty('notes/a.md', 'first line\nmy unsaved second line', 'first line')
    })

    await expect(row(page, 'notes/a.md')).toHaveAttribute('data-verdict', 'unsaved-edits')
    // Both texts are on screen — the user's, and the one the call said it left — which is what says
    // neither was decided for them.
    await expect(row(page, 'notes/a.md').locator('[data-unsaved-buffer] .agent-changes-text')).toContainText(
      'my unsaved second line',
    )
    await expect(row(page, 'notes/a.md').locator('[data-agent-version] .agent-changes-text')).toContainText(
      'the agent\u2019s line',
    )
    await expect(action(page, 'notes/a.md', 'keep')).toBeVisible()
    await expect(action(page, 'notes/a.md', 'recover')).toHaveCount(0)
    await expect(row(page, 'notes/a.md').locator('[data-refused]')).toHaveAttribute(
      'data-refusal',
      'unsaved-edits',
    )

    // The answer reaches the caller as an intention, and the editor's text is exactly what it was:
    // nothing this feature can do writes a buffer.
    await action(page, 'notes/a.md', 'keep').click()
    expect(await emitted(page)).toEqual([['keep', 'notes/a.md']])
    expect(await bufferText(page, 'notes/a.md')).toBe('first line\nmy unsaved second line')
  })

  test('a write still in flight has no recovery to offer', async ({ page }) => {
    await page.goto('/')
    await open(page)

    await page.evaluate(() => {
      const harness = window.__agentChanges
      if (harness === undefined) throw new Error('the view is not mounted')
      harness.write('call-1', ['notes/a.md'], 'in_progress', 'edit', { oldText: 'before', newText: 'after' })
      harness.baseline('notes/a.md', 'before')
      harness.setClean('notes/a.md', 'after')
    })

    await expect(row(page, 'notes/a.md')).toHaveAttribute('data-attribution', 'agent')
    await expect(action(page, 'notes/a.md', 'recover')).toHaveCount(0)
    await expect(row(page, 'notes/a.md').locator('[data-refused]')).toHaveAttribute(
      'data-refusal',
      'write-in-flight',
    )

    // The engine finishes, and the same row gains the action with no second event.
    await page.evaluate(() =>
      window.__agentChanges?.write('call-1', ['notes/a.md'], 'completed', 'edit', {
        oldText: 'before',
        newText: 'after',
      }),
    )
    await expect(action(page, 'notes/a.md', 'recover')).toBeVisible()
    await expect(row(page, 'notes/a.md').locator('[data-refused]')).toHaveCount(0)
  })

  test('a rejection is an intention, and the row says nothing until the caller answers', async ({ page }) => {
    // 不伪造「撤销成功」 on the surface's side: pressing the button asks the host and changes
    // nothing here. The row keeps its attribution and its actions, so a host that refuses (the
    // file moved since the change, in §7.2's first case) leaves a screen that never said it worked.
    await page.goto('/')
    await open(page)

    await page.evaluate(() => {
      const harness = window.__agentChanges
      if (harness === undefined) throw new Error('the view is not mounted')
      harness.write('call-1', ['notes/a.md'], 'completed', 'edit', { oldText: 'before', newText: 'after' })
      harness.baseline('notes/a.md', 'before')
      harness.setClean('notes/a.md', 'after')
    })
    await action(page, 'notes/a.md', 'recover').click()

    expect(await emitted(page)).toEqual([['recover', 'notes/a.md']])
    await expect(action(page, 'notes/a.md', 'recover')).toBeVisible()
    await expect(row(page, 'notes/a.md')).toHaveAttribute('data-attribution', 'agent')
    await expect(row(page, 'notes/a.md')).toHaveAttribute('data-verdict', 'follows-disk')

    // The caller answers: the row is decided, draws no writes any more, and says what the write
    // did — the three arms of §7.2's outcome, kept apart.
    await page.evaluate(() => window.__agentChanges?.answer('notes/a.md', 'call-1', 'rejected', 'save-failed'))
    await expect(row(page, 'notes/a.md')).toHaveAttribute('data-decision', 'rejected')
    await expect(action(page, 'notes/a.md', 'recover')).toHaveCount(0)
    await expect(action(page, 'notes/a.md', 'keep')).toHaveCount(0)
    await expect(row(page, 'notes/a.md').locator('[data-decision-outcome]')).toHaveText(
      LABELS.written.saveFailed,
    )

    // And a keep is the other answer: nothing written, and the row says so with no outcome line.
    await page.evaluate(() => window.__agentChanges?.answer('notes/a.md', 'call-1', 'kept'))
    await expect(row(page, 'notes/a.md')).toHaveAttribute('data-decision', 'kept')
    await expect(row(page, 'notes/a.md').locator('[data-decision-outcome]')).toHaveCount(0)
  })

  test('no click here reaches a document', async ({ page }) => {
    // The whole of the buffer clause, as a property of the surface rather than of one handler: the
    // view has no field to type into and no state a click can write back, so there is nothing to
    // lose. A text input appearing here would be the first half of the defect the clause names.
    await page.goto('/')
    await open(page)

    await page.evaluate(() => {
      const harness = window.__agentChanges
      if (harness === undefined) throw new Error('the view is not mounted')
      // b.md carries the call's own text and a baseline, so it is the row with a rejection on it.
      harness.write('call-1', ['notes/b.md'], 'completed', 'edit', { oldText: 'before', newText: 'after' })
      harness.baseline('notes/b.md', 'before')
      harness.setClean('notes/b.md', 'after')
      // a.md is the user's own text that nothing has a version of: unsaved, and a call that
      // stated no text at all — the shape the "no file text here" sentence exists for.
      harness.write('call-2', ['notes/a.md'], 'completed')
      harness.setDirty('notes/a.md', 'unsaved', null)
    })

    await expect(page.locator('[data-agent-changes] input, [data-agent-changes] textarea')).toHaveCount(0)
    // A note whose file was never read says so instead of showing an empty file.
    await expect(row(page, 'notes/a.md').locator('[data-disk-unread]')).toBeVisible()

    for (const name of ['view', 'keep']) {
      const control = action(page, 'notes/a.md', name)
      if ((await control.count()) > 0) await control.click()
    }
    await action(page, 'notes/b.md', 'recover').click()
    await page.locator('[data-action="collapse"]').click()

    expect(await bufferText(page, 'notes/a.md')).toBe('unsaved')
    // The strip is collapsed, not gone: the header still says what the run touched, and the way
    // back is the same control.
    await expect(page.locator('[data-changes-summary]')).toBeVisible()
    await expect(page.locator('[data-agent-changes] li[data-path]')).toHaveCount(0)
    await page.locator('[data-action="expand"]').click()
    await expect(page.locator('[data-agent-changes] li[data-path]')).toHaveCount(2)
    expect((await emitted(page)).map(([name]) => name).sort()).toEqual([
      'collapse',
      'expand',
      'keep',
      'recover',
      'view',
    ])
  })
})

test.describe('the view in a narrow window', () => {
  test('a long path wraps instead of widening the page, and the rows stay reachable from the keyboard', async ({
    page,
  }) => {
    // §5.3's 860x560 and 长路径: the review opens in the editor's workspace, and the window it
    // opens in can be the small one. A path is one unbroken token, so it is the thing that
    // overflows a panel if anything does.
    await page.setViewportSize({ width: 860, height: 560 })
    await page.goto('/')
    await open(page)

    const long = 'notes/2026-09/项目/一条很长的中文路径/'.repeat(3) + 'a-note-with-no-spaces-in-its-name.md'
    await page.evaluate((path) => window.__agentChanges?.write('call-1', [path], 'completed'), long)

    // Measured on the section's own host rather than on the page: the application is running
    // behind it and a full editor workspace is not this spec's to hold to a width.
    const overflow = await page.evaluate(() => {
      const host = document.getElementById('agent-changes-e2e') as HTMLElement
      return host.scrollWidth - host.clientWidth
    })
    expect(overflow).toBeLessThanOrEqual(0)

    // Tab reaches the row's own controls and Enter activates them — the same actions the mouse
    // would take, so a keyboard user is not left with a list they can read but not act on. The
    // path is the first of them (it carries the view action), and inside the actions the answer
    // that cannot take anything away comes before the write.
    await page.locator('[data-action="collapse"]').focus()
    await page.keyboard.press('Tab')
    await expect(action(page, long, 'view')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(action(page, long, 'keep')).toBeFocused()
    await page.keyboard.press('Enter')
    expect(await emitted(page)).toEqual([['keep', long]])
  })

  test('the rows follow the theme rather than a colour of their own', async ({ page }) => {
    // 深浅主题: this view owns no palette. Every colour it draws is a theme token, so switching the
    // document's theme has to change what it looks like — a hardcoded colour would survive and be
    // the one block in the app that does not.
    await page.goto('/')
    await open(page)
    await page.evaluate(() => {
      const harness = window.__agentChanges
      if (harness === undefined) throw new Error('the view is not mounted')
      harness.write('call-1', ['notes/a.md'], 'completed', 'edit', { oldText: 'before', newText: 'after' })
      harness.baseline('notes/a.md', 'before')
      harness.setClean('notes/a.md', 'after')
    })

    const background = async (theme: string): Promise<string> =>
      page.evaluate((value) => {
        document.documentElement.dataset.theme = value
        document.documentElement.dataset.colorScheme = 'default'
        return getComputedStyle(document.querySelector('[data-agent-changes] li') as Element).backgroundColor
      }, theme)

    const light = await background('light')
    const dark = await background('dark')
    expect(light).not.toBe(dark)
    // …and the state that carries meaning is a word as well as a border, so it survives either.
    await expect(row(page, 'notes/a.md')).toHaveAttribute('data-attribution', 'agent')
  })
})
