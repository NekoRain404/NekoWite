/**
 * E1 — the agent panel's own acceptance, in a real browser.
 *
 * The three rules this file exists for, in the task's own words: collapsing does not interrupt
 * the run, scrolling up is not stolen, and IME input does not send (§10.2, T6's row). Each is a
 * rule about a *moment* rather than about a shape, which is why none of them is a unit test:
 * the collapse has to be a real unmount of a real Vue tree, the scroll has to be a real scroll
 * container, and the composition has to be a real input method.
 *
 * ## Why the panel is mounted here rather than found in the rail
 *
 * The panel's slot is the right rail, and moving the rail onto it is T16's change to
 * `InfoRail.vue` / `AppShell.vue` — not this task's, and not something a spec may do for it.
 * Until that wiring exists there is no panel in the running application to drive, so this spec
 * mounts the component itself against the memory runtime from T1, in the page the dev server is
 * already serving. Every assertion below is about the component's behaviour and stays true
 * unchanged once the rail hosts it; what this file deliberately does not cover is the wiring.
 *
 * The page is opened with no Tauri stub, so the application boots on its browser path and
 * nothing in it competes with the panel for the store, the runtime or the keyboard.
 *
 * Vue and Pinia are imported by URL rather than by name: a page has no import map, and the
 * panel has to be built by the *same* Vue instance the components it renders were compiled
 * against — a second copy in one page renders a tree with a runtime that is not its own. The
 * URLs are read out of a module the dev server rewrote, which is the exact URL the browser
 * already loaded, hash included.
 */
import { expect, test, type Page } from '@playwright/test'
import type { Pinia } from 'pinia'
import type { App } from 'vue'
import type { AgentPanelLabels } from '/src/features/agent/index.ts'
import type { AgentSession } from '/src/platform/gateways/agent-contracts.ts'
import type { MemoryAgentGateway, MemoryRunScript } from '/src/platform/gateways/memory-agent.ts'

/**
 * The copy the panel draws, as the caller that mounts it supplies it.
 *
 * The components have no sentences of their own — the catalogue has keys for the command menu
 * and the permission prompt and none for the panel (§ AgentPanelLabels) — so the caller is
 * where the words come from. Nothing below asserts on these strings: they are the panel's
 * words rather than the engine's, and a test that matched them would break on a reworded
 * tooltip.
 */
const LABELS: AgentPanelLabels = {
  // The transcript's first line, drawn while the transcript is empty. It arrived with the panel's
  // engine sentence and was not carried over here, so this spec was mounting a panel whose empty
  // transcript drew nothing — the browser run had no assertion on that line, which is why only the
  // checker noticed.
  empty: {
    line: 'Message Memory — / for commands',
  },
  bar: {
    untitled: 'New session',
    state: {
      idle: 'Idle',
      starting: 'Starting',
      ready: 'Ready',
      running: 'Running',
      'waiting-permission': 'Waiting for approval',
      completed: 'Completed',
      cancelled: 'Stopped',
      failed: 'Failed',
    },
    result: {
      'end-turn': 'Finished',
      'max-tokens': 'Token limit',
      'max-turn-requests': 'Request limit',
      refusal: 'Refused',
      cancelled: 'Stopped',
      unrecognised: 'Unrecognised ending',
    },
  },
  timeline: {
    aria: 'Agent transcript',
    you: 'You',
    thoughtOpen: 'Hide reasoning',
    thoughtClosed: 'Reasoning',
    jump: 'New content',
    tool: {
      status: {
        pending: 'Queued',
        in_progress: 'Running',
        completed: 'Done',
        failed: 'Failed',
        cancelled: 'Stopped',
      },
      expand: 'Show arguments and output',
      collapse: 'Hide arguments and output',
      args: 'Arguments',
      output: 'Output',
      argsAbsent: 'The engine sent no arguments',
      argsUnreadable: 'The engine sent arguments this app could not read',
      outputAbsent: 'No output reported',
      outputUnreadable: 'The engine sent output this app could not read',
    },
  },
  composer: {
    placeholder: 'Ask the agent',
    send: 'Send',
    stop: 'Stop',
    hint: 'Enter sends, Shift+Enter starts a new line',
    hintBusy: 'A run is in flight — the text waits here',
  },
  notice: {
    gap: 'Part of this session’s record was never received',
    resync: 'Resync',
  },
}

/** What the spec keeps on the page between mounts: the runtime it drives, the one session on
 *  it, and the panel's own answers about what it is showing. */
interface PanelHarness {
  gateway: MemoryAgentGateway
  session: AgentSession
  /** Kept across mounts: the session's record — its timeline, draft, position and unread flag —
   *  lives in this store, and a collapse must not take it with it (§5.1). */
  pinia: Pinia
  app: App | null
  /** Every prompt the panel handed the engine, in order. The composer's sends are the only
   *  thing that feeds it, which is what makes "nothing was sent" an assertion about a call. */
  prompts: string[]
  /** Every answer the panel handed the engine, as `[requestId, optionId]` — the same trick for
   *  the other decision: a permission that was answered rather than merely rendered. */
  answers: Array<[string, string]>
  /** The store's own word for the on-screen session's state. */
  state(): string
  /** The engine's own state, from its snapshot: what a collapse must not change. */
  engineState(): Promise<string>
  /** The agent's text as the store holds it, concatenated. */
  text(): string
  /** How many rows the store holds — arrivals and nothing else move it. */
  rows(): number
  /** Take the panel off screen, the way the rail's `v-if` does. */
  unmount(): void
}

declare global {
  interface Window {
    __agentPanel?: PanelHarness
  }
}

/** The mount point, and the panel's own size: §5.3's default width, taller than the viewport
 *  it sits against so the timeline inside it scrolls. */
const HOST_ID = 'agent-e2e-panel'
const PANEL_WIDTH = 400
const PANEL_HEIGHT = 720

/** Let the browser process `count` animation frames, the way `input-ime.spec.ts` does: a fixed
 *  sleep loses its meaning under load, and two frames are what "the browser has applied this"
 *  actually requires. */
async function nextFrames(page: Page, count = 2): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let left = n
        const step = (): void => {
          left -= 1
          if (left <= 0) resolve()
          else requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      }),
    count,
  )
}

/** The dev server's URLs for the two dependencies the page's modules already use. */
async function viewDeps(page: Page): Promise<{ vue: string; pinia: string }> {
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
 * Put the panel on screen. The runtime, the session and the store are made once and kept across
 * mounts: a collapse is the panel going away, not the session, and a spec that rebuilt the
 * runtime would be testing a restart instead.
 */
async function mount(page: Page): Promise<void> {
  const deps = await viewDeps(page)
  await page.evaluate(
    async ({ deps: urls, labels, hostId, width, height }) => {
      const vue = (await import(/* @vite-ignore */ urls.vue)) as typeof import('vue')
      const pinia = (await import(/* @vite-ignore */ urls.pinia)) as typeof import('pinia')
      const { AgentPanel } = await import('/src/features/agent/index.ts')
      const { createMemoryAgentGateway } = await import('/src/platform/gateways/memory-agent.ts')
      const { useAgentSessionStore } = await import('/src/features/agent/stores/agent-session.ts')

      const previous = window.__agentPanel
      const prompts = previous?.prompts ?? []
      const answers = previous?.answers ?? []
      const gateway =
        previous?.gateway ??
        createMemoryAgentGateway({ agentId: 'memory-e2e', profileId: 'e2e' })
      if (previous === undefined) {
        await gateway.start()
        // Count what the composer actually hands over. "No row appeared" would also hold if a
        // send were swallowed on the way, and the rule this file checks is about the call.
        const prompt = gateway.prompt.bind(gateway)
        gateway.prompt = (target, text) => {
          prompts.push(text)
          return prompt(target, text)
        }
        // …and the same for the other decision the panel makes on the reader's behalf: an
        // authorization that was answered, rather than one that was merely drawn.
        const answer = gateway.answerPermission.bind(gateway)
        gateway.answerPermission = async (target, requestId, optionId) => {
          answers.push([requestId, optionId])
          return answer(target, requestId, optionId)
        }
      }
      const session = previous?.session ?? (await gateway.openSession({ vaultId: 'e2e-vault', cwd: '/vault' }))

      // The same store on every mount: it is where the session's record lives, and a remount
      // that started a fresh one would be testing a new session rather than a reopened panel.
      const piniaInstance = previous?.pinia ?? pinia.createPinia()
      pinia.setActivePinia(piniaInstance)
      const store = useAgentSessionStore()

      let host = document.getElementById(hostId)
      if (host === null) {
        host = document.createElement('div')
        host.id = hostId
        // Fixed, and out of the application's flow: the app is running on this page, and a
        // panel that took part in its layout would be measuring the app as much as itself.
        host.style.cssText = `position: fixed; top: 0; right: 0; width: ${width}px; height: ${height}px; display: flex; z-index: 60;`
        document.body.append(host)
      }
      const app = vue.createApp(AgentPanel, { gateway, session, labels })
      app.use(piniaInstance)
      app.mount(host)

      const record = () => {
        const key = store.activeKey
        return key === null ? null : store.recordFor(key)
      }
      window.__agentPanel = {
        gateway,
        session,
        pinia: piniaInstance,
        app,
        prompts,
        answers,
        state: () => record()?.view.state ?? 'none',
        engineState: async () => (await gateway.snapshot(session)).state,
        text: () =>
          (record()?.view.timeline ?? [])
            .filter((row) => row.kind === 'text')
            .map((row) => (row.kind === 'text' ? row.text : ''))
            .join(''),
        rows: () => record()?.view.timeline.length ?? 0,
        unmount: () => {
          window.__agentPanel?.app?.unmount()
          if (window.__agentPanel) window.__agentPanel.app = null
        },
      }
    },
    { deps, labels: LABELS, hostId: HOST_ID, width: PANEL_WIDTH, height: PANEL_HEIGHT },
  )
  await expect(page.locator('[data-agent-panel]')).toBeVisible()
}

/** The rail closing: the panel's component goes away and nothing else does. */
async function unmount(page: Page): Promise<void> {
  await page.evaluate(() => window.__agentPanel?.unmount())
  await expect(page.locator('[data-agent-panel]')).toHaveCount(0)
}

/** What the next turns do, as the memory runtime understands it. */
async function scriptTurns(page: Page, script: MemoryRunScript): Promise<void> {
  await page.evaluate((next) => window.__agentPanel?.gateway.script(next), script)
}

/** One row of content from the engine, out of band — the frames a running turn keeps sending. */
async function emitToolRow(page: Page, base: string, count: number, long = false): Promise<void> {
  await page.evaluate(
    ({ base: name, count: rows, long: verbose }) => {
      const harness = window.__agentPanel
      if (harness === undefined) throw new Error('the panel is not mounted')
      for (let i = 0; i < rows; i += 1) {
        harness.gateway.emit(harness.session, {
          kind: 'tool-update',
          payload: {
            toolCallId: `${name}-${i}`,
            title: verbose
              ? 'Reading a note whose title is long enough that a narrower panel wraps it onto two lines, twice over'
              : `Reading note ${name}-${i}`,
            kind: 'read',
            status: 'completed',
            paths: [`notes/2026-09/${name}-${i}.md`],
            input: { state: 'absent' },
            output: { state: 'text', json: '{"ok":true}' },
          },
        })
      }
    },
    { base, count, long },
  )
  await nextFrames(page)
}

async function emitText(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => {
    const harness = window.__agentPanel
    if (harness === undefined) throw new Error('the panel is not mounted')
    harness.gateway.emit(harness.session, { kind: 'text-delta', payload: { text: value } })
  }, text)
  await nextFrames(page)
}

/** Type a message and press send, waiting for the run it started to end. */
async function sendAndWait(page: Page, text: string): Promise<void> {
  await page.locator('.agent-composer-field').fill(text)
  await page.locator('.agent-composer [data-action="send"]').click()
  await expect.poll(async () => state(page), { timeout: 5000 }).not.toBe('running')
}

const state = (page: Page): Promise<string> =>
  page.evaluate(() => window.__agentPanel?.state() ?? 'none')

const engineState = (page: Page): Promise<string> =>
  page.evaluate(async () => (await window.__agentPanel?.engineState()) ?? 'none')

const prompts = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__agentPanel?.prompts ?? [])

const answers = (page: Page): Promise<Array<[string, string]>> =>
  page.evaluate(() => window.__agentPanel?.answers ?? [])

const rowCount = (page: Page): Promise<number> =>
  page.evaluate(() => window.__agentPanel?.rows() ?? 0)

const agentText = (page: Page): Promise<string> =>
  page.evaluate(() => window.__agentPanel?.text() ?? '')

/** Where the transcript is scrolled to, as the browser reports it. */
const scrollTop = (page: Page): Promise<number> =>
  page.locator('.agent-timeline').evaluate((el) => el.scrollTop)

/** The end of the transcript: what "at the bottom" means for this container. */
const endOffset = (page: Page): Promise<number> =>
  page.locator('.agent-timeline').evaluate((el) => el.scrollHeight - el.clientHeight)

interface Metrics {
  top: number
  scrollHeight: number
  clientHeight: number
}

const metrics = (page: Page): Promise<Metrics> =>
  page.locator('.agent-timeline').evaluate((el) => ({
    top: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }))

/** The reader's own scroll: the container moves, and the browser reports it a frame later. */
async function scrollUpTo(page: Page, top: number): Promise<void> {
  await page.locator('.agent-timeline').evaluate((el, value) => {
    el.scrollTop = value
  }, top)
  // The scroll event is delivered on the next frame, and until it arrives the controller still
  // believes the reader is at the end — which is the race the panel has to get right anyway.
  await nextFrames(page, 2)
}

/** The first row the reader sees, and where it sits: the reading position an anchor has to hold. */
async function readingPosition(page: Page): Promise<{ row: string; offset: number }> {
  return page.locator('.agent-timeline').evaluate((el) => {
    const top = el.getBoundingClientRect().top
    for (const row of Array.from(el.children)) {
      const box = row.getBoundingClientRect()
      if (box.bottom - top > 0) {
        return { row: (row as HTMLElement).dataset.row ?? '', offset: box.top - top }
      }
    }
    throw new Error('the transcript has no visible row')
  })
}

/** Where a row sits now, by the store's own id for it. */
async function offsetOfRow(page: Page, id: string): Promise<number> {
  return page.locator(`.agent-timeline [data-row="${id}"]`).evaluate((el) => {
    const scroller = el.closest('.agent-timeline')
    if (scroller === null) throw new Error('the row is not in the transcript')
    return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  })
}

/** The panel dragged narrower, which re-wraps every row of text inside it (§5.3's range). */
async function resizePanel(page: Page, width: number): Promise<void> {
  await page.locator(`#${HOST_ID}`).evaluate((el, value) => {
    ;(el as HTMLElement).style.width = `${value}px`
  }, width)
  await nextFrames(page, 3)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test.describe('agent panel — a collapse is not an interruption', () => {
  test('the run outlives the panel it was started from, and the transcript comes back whole', async ({
    page,
  }) => {
    await mount(page)
    // A turn that keeps running until something ends it: the window a collapse can happen in.
    await scriptTurns(page, { chunks: ['Reading the note. '], hang: true })
    await page.locator('.agent-composer-field').fill('Summarise the note')
    await page.locator('.agent-composer [data-action="send"]').click()
    await expect(page.locator('.agent-row-user')).toHaveCount(1)
    expect(await state(page)).toBe('running')

    // The rail closing while the run is in flight.
    await unmount(page)
    await emitText(page, 'Still arriving while nobody is watching. ')
    // The engine's own answer, not the panel's: nothing was stopped, only unsubscribed.
    expect(await engineState(page)).toBe('running')

    // And the rail opening again: the panel rebuilds from the runtime's snapshot, which is the
    // handshake §6.2 asks for precisely so that a remount is safe.
    await mount(page)
    await expect(page.locator('.agent-row-reply')).toContainText('Still arriving while nobody is watching.')
    expect(await agentText(page)).toContain('Reading the note.')

    // The reader can still end it, from the composer the panel came back with.
    await page.locator('.agent-composer [data-action="stop"]').click()
    await expect.poll(async () => state(page), { timeout: 5000 }).toBe('cancelled')
    await expect(page.locator('.agent-row[data-origin="host"]')).toHaveCount(1)
  })
})

test.describe('agent panel — the reader’s scroll', () => {
  test('content arriving under a reader who scrolled up does not move them', async ({ page }) => {
    await mount(page)
    // A live turn, so the rows that arrive belong to it (a frame for no run is not a frame this
    // host applies).
    await scriptTurns(page, { chunks: [], hang: true })
    await page.locator('.agent-composer-field').fill('go')
    await page.locator('.agent-composer [data-action="send"]').click()
    await emitToolRow(page, 'seed', 40)

    // A session nobody has read opens at its end, which is where the reader starts.
    expect(await scrollTop(page)).toBe(await endOffset(page))
    expect(await engineState(page)).toBe('running')

    // They scroll up to read something.
    await scrollUpTo(page, 200)
    expect(await scrollTop(page)).toBe(200)

    // Three rows arrive beneath them.
    await emitToolRow(page, 'under', 3)
    expect(await scrollTop(page)).toBe(200)
    // …and the arrivals are counted rather than hidden: the hint offers the way back.
    await expect(page.locator('.agent-jump')).toBeVisible()
    await expect(page.locator('.agent-jump-count')).toHaveText('3')

    // Two more, because one arrival can pass for luck.
    await emitToolRow(page, 'under2', 2)
    expect(await scrollTop(page)).toBe(200)
    await expect(page.locator('.agent-jump-count')).toHaveText('5')

    // Going back to the end is the reader's own action, and it is theirs alone.
    await page.locator('.agent-jump').click()
    await expect.poll(async () => scrollTop(page)).toBe(await endOffset(page))
    await expect(page.locator('.agent-jump')).toBeHidden()

    // …and once there, arrivals follow again.
    await emitToolRow(page, 'after', 2)
    await expect.poll(async () => scrollTop(page)).toBe(await endOffset(page))
  })

  test('a session reopens where the reader left it', async ({ page }) => {
    await mount(page)
    await scriptTurns(page, { chunks: [], hang: true })
    await page.locator('.agent-composer-field').fill('go')
    await page.locator('.agent-composer [data-action="send"]').click()
    await emitToolRow(page, 'pos', 40)

    await scrollUpTo(page, 220)
    await unmount(page)
    await mount(page)

    // The position is the session's, not the panel's (§5.1): it survived the panel going away.
    expect(await scrollTop(page)).toBe(220)
    // And the reader is not following, so an arrival under them still does not move them.
    await emitToolRow(page, 'pos2', 2)
    expect(await scrollTop(page)).toBe(220)
  })
})

test.describe('agent panel — a row that grows', () => {
  test('a re-wrap above the reader does not move what they are reading', async ({ page }) => {
    await mount(page)
    // Long text, so a narrower panel really does re-wrap it and change the heights above the
    // reader. Tool rows do not wrap by design, so the paragraphs are the engine's own text.
    await scriptTurns(page, {
      chunks: [
        'A paragraph long enough that the panel wraps it onto several lines at four hundred ' +
          'pixels, and onto more of them once the panel has been dragged narrower than that. ',
      ],
    })
    for (let i = 0; i < 6; i += 1) await sendAndWait(page, `paragraph ${i}`)

    await scrollUpTo(page, 300)
    const anchor = await readingPosition(page)
    const before = await metrics(page)
    expect(before.scrollHeight).toBeGreaterThan(before.clientHeight)

    await resizePanel(page, 320)
    const after = await metrics(page)

    // The heights really did change — otherwise the assertion below would pass for free.
    expect(after.scrollHeight).toBeGreaterThan(before.scrollHeight)
    // …and the row the reader was on is still where it was on screen.
    expect(Math.abs((await offsetOfRow(page, anchor.row)) - anchor.offset)).toBeLessThanOrEqual(1)
  })
})

test.describe('agent panel — the authorization a run waits on', () => {
  test('a suspended turn is answerable from the panel, and finishing it is the proof', async ({
    page,
  }) => {
    await mount(page)
    await scriptTurns(page, {
      chunks: ['Reading the plan. '],
      // The turn stops here and stays stopped: the engine is waiting for an answer, which is
      // the state a panel that cannot answer leaves the user in forever.
      permission: {
        title: 'Read notes/plan.md',
        input: { state: 'text', json: '{"path":"notes/plan.md"}' },
        options: [
          { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    })
    await page.locator('.agent-composer-field').fill('read the plan')
    await page.locator('.agent-composer [data-action="send"]').click()

    // Panel in: the request is on screen, wearing the engine's own sentence and options, and
    // the status line says what is being waited for (§5.1).
    await expect(page.locator('.agent-perm')).toBeVisible()
    await expect(page.locator('.agent-perm-title')).toContainText('Read notes/plan.md')
    await expect(page.locator('.agent-perm-options button')).toHaveText(['Always allow', 'Reject'])
    await expect(page.locator('.agent-bar-state')).toContainText('Waiting for approval')
    // A run in flight offers one action, and it is stop rather than send.
    await expect(page.locator('.agent-composer [data-action="stop"]')).toBeVisible()
    expect(await answers(page)).toEqual([])

    // Decision out.
    await page.locator('.agent-perm-options button').first().click()
    await expect.poll(async () => answers(page), { timeout: 5000 }).toHaveLength(1)
    expect((await answers(page))[0][1]).toBe('always')
    // …and the turn the answer was suspending ran to its own end, which cannot happen unless
    // the answer arrived.
    await expect.poll(async () => state(page), { timeout: 5000 }).toBe('completed')
    await expect(page.locator('.agent-perm')).toHaveCount(0)
    await expect(page.locator('.agent-row-reply')).toContainText('Reading the plan.')
  })

  test('stopping the suspended turn is not an answer to it', async ({ page }) => {
    await mount(page)
    await scriptTurns(page, {
      chunks: [],
      permission: {
        title: 'Read notes/plan.md',
        options: [{ optionId: 'always', name: 'Always allow', kind: 'allow_always' }],
      },
    })
    await page.locator('.agent-composer-field').fill('read the plan')
    await page.locator('.agent-composer [data-action="send"]').click()
    await expect(page.locator('.agent-perm')).toBeVisible()

    await page.locator('.agent-perm [data-action="cancel-run"]').click()

    await expect.poll(async () => state(page), { timeout: 5000 }).toBe('cancelled')
    // The protocol has exactly two outcomes and a refusal is one of them: a turned-off turn
    // must not have sent the engine an option id on the way out.
    expect(await answers(page)).toEqual([])
    await expect(page.locator('.agent-perm')).toHaveCount(0)
  })
})

test.describe('agent panel — the composer', () => {
  test('Enter that commits an input method candidate does not send', async ({ page }) => {
    await mount(page)
    const field = page.locator('.agent-composer-field')
    await field.click()

    const cdp = await page.context().newCDPSession(page)
    // A real composition, driven the way the input spec drives the editor's: preedit first,
    // then the Enter a reader presses to take a candidate.
    await cdp.send('Input.imeSetComposition', {
      text: 'niha',
      selectionStart: 4,
      selectionEnd: 4,
    })
    await nextFrames(page)
    await expect(field).toHaveValue('niha')

    await page.keyboard.press('Enter')
    await nextFrames(page)
    // Nothing was sent: not a row, and — the assertion this file exists for — not a call.
    expect(await prompts(page)).toEqual([])
    await expect(page.locator('.agent-row-user')).toHaveCount(0)
    await expect(field).toHaveValue('niha')

    // The candidate commits, which ends the composition. That is not a send either.
    await cdp.send('Input.insertText', { text: '你好' })
    await nextFrames(page)
    expect(await prompts(page)).toEqual([])
    await expect(field).toHaveValue(/你好/)

    // The Enter after that one is the reader's, and it sends what is in the field. The pause is
    // the composition grace window the component keeps for WebKit, which delivers the committing
    // Enter after `compositionend` — a human's second keystroke is never inside it.
    await page.waitForTimeout(100)
    await page.keyboard.press('Enter')
    await expect.poll(async () => prompts(page), { timeout: 5000 }).toHaveLength(1)
    expect((await prompts(page))[0]).toContain('你好')
    await expect(page.locator('.agent-row-user')).toHaveCount(1)
    await expect(page.locator('.agent-row-user')).toContainText('你好')
    await expect(field).toHaveValue('')
    await cdp.detach()
  })

  test('Shift+Enter starts a line instead of sending', async ({ page }) => {
    await mount(page)
    const field = page.locator('.agent-composer-field')
    await field.click()
    await page.keyboard.insertText('first line')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.insertText('second line')
    await nextFrames(page)

    expect(await prompts(page)).toEqual([])
    await expect(field).toHaveValue('first line\nsecond line')

    await page.keyboard.press('Enter')
    await expect.poll(async () => prompts(page), { timeout: 5000 }).toHaveLength(1)
    // The ends are trimmed and nothing inside them is touched.
    expect((await prompts(page))[0]).toBe('first line\nsecond line')
    expect(await rowCount(page)).toBeGreaterThan(1)
  })
})
