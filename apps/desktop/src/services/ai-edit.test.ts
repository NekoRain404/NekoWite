import { describe, expect, it, vi } from 'vitest'
import { buildEditPrompt, rewriteSelection } from './ai-edit'
import type { AiEditDeps, EditView } from './ai-edit'
import type { ChatStreamHandlers } from './ai'

function fakeView(): EditView & {
  dispatch: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
} {
  return {
    state: {
      selection: { from: 3, to: 10, empty: false },
      doc: { textBetween: vi.fn(() => 'hello world') },
      tr: { insertText: vi.fn((text: string) => ({ kind: 'tr', text })) },
    },
    dispatch: vi.fn(),
    focus: vi.fn(),
  } as never
}

function fakeDeps(
  view: EditView | null = fakeView(),
): { deps: Partial<AiEditDeps>; state: { handlers: ChatStreamHandlers | null } } {
  const state = { handlers: null as ChatStreamHandlers | null }
  return {
    deps: {
      getView: () => view,
      // The selection accessors are the mode-aware seam; here they mirror the
      // fake view so the tests exercise `rewriteSelection` itself.
      readSelection: () => {
        const sel = view?.state.selection
        if (!sel || sel.empty) return null
        return {
          from: sel.from,
          to: sel.to,
          text: view!.state.doc.textBetween(sel.from, sel.to, '\n', ' '),
        }
      },
      applySelection: (text: string) => {
        if (!view) return false
        view.dispatch(view.state.tr.insertText(text, view.state.selection.from, view.state.selection.to))
        view.focus()
        return true
      },
      getConfig: () => ({ provider: 'local', model: 'm' }),
      // The permission gate is injected here rather than reached through the
      // store, so these tests stay independent of Pinia (as they were before the
      // gate existed). The store"s own behaviour has its own suite.
      canWrite: vi.fn(async () => true),
      notifyError: vi.fn(),
      start: vi.fn((_cfg, _prompt, _images, handlers) => {
        state.handlers = handlers
        return Promise.resolve({ cancel: vi.fn() })
      }),
      translate: vi.fn((k: string) => k),
    },
    state,
  }
}

describe("permission gate", () => {
  it("does not send the request when the write is declined", async () => {
    // A denied write must cost nothing: no request, no provider round trip, and
    // no chance to apply a result the user refused.
    const { deps, state } = fakeDeps()
    const gate = vi.fn(async () => false)
    deps.canWrite = gate
    const notifyError = deps.notifyError as ReturnType<typeof vi.fn>
    const start = deps.start as ReturnType<typeof vi.fn>

    await rewriteSelection("polish", deps)

    expect(gate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "replace-selection" }),
    )
    expect(start).not.toHaveBeenCalled()
    expect(state.handlers).toBeNull()
    expect(notifyError).toHaveBeenCalledWith("aiperm.denied")
  })

  it("describes the action and the target to the prompt", async () => {
    const { deps } = fakeDeps()
    const gate = vi.fn(async () => true)
    deps.canWrite = gate
    await rewriteSelection("translate", deps)
    expect(gate).toHaveBeenCalledWith({
      kind: "replace-selection",
      summary: "aiperm.action.translate",
      target: "hello world",
    })
  })

  it("sends the request once the write is approved", async () => {
    const { deps, state } = fakeDeps()
    const start = deps.start as ReturnType<typeof vi.fn>
    await rewriteSelection("polish", deps)
    expect(start).toHaveBeenCalled()
    expect(state.handlers).not.toBeNull()
  })
})

describe("buildEditPrompt", () => {
  it('builds a rewrite prompt around the selection', () => {
    const p = buildEditPrompt('rewrite', 'draft text')
    expect(p).toContain('Rewrite')
    expect(p).toContain('draft text')
    expect(p.endsWith('draft text')).toBe(true)
  })

  it('builds a polish prompt around the selection', () => {
    const p = buildEditPrompt('polish', 'rough text')
    expect(p).toContain('Polish')
    expect(p).toContain('rough text')
  })

  it('builds a translate prompt with an explicit target language', () => {
    const p = buildEditPrompt('translate', '原文', 'Simplified Chinese')
    expect(p).toContain('Translate')
    expect(p).toContain('into Simplified Chinese')
    expect(p).toContain('原文')
  })

  it('translate falls back when no target language is given', () => {
    const p = buildEditPrompt('translate', '原文')
    expect(p).toContain('Output only the translation')
    expect(p).toContain('原文')
    expect(p).not.toContain('into ')
  })
})

describe('rewriteSelection', () => {
  it('notifies when there is no editor view and does not call the model', async () => {
    const { deps } = fakeDeps(null)
    const notify = deps.notifyError as ReturnType<typeof vi.fn>
    await rewriteSelection('rewrite', deps)
    expect(notify).toHaveBeenCalledWith('chat.editorNotReady')
    expect(deps.start).not.toHaveBeenCalled()
  })

  it('notifies ai.noSelection for an empty selection', async () => {
    const view = fakeView()
    view.state.selection = { from: 5, to: 5, empty: true }
    const { deps } = fakeDeps(view)
    const notify = deps.notifyError as ReturnType<typeof vi.fn>
    await rewriteSelection('polish', deps)
    expect(notify).toHaveBeenCalledWith('ai.noSelection')
    expect(deps.start).not.toHaveBeenCalled()
  })

  it('sends the selection text as the prompt with the current config', async () => {
    const view = fakeView()
    const { deps, state } = fakeDeps(view)
    await rewriteSelection('polish', deps)
    expect(deps.start).toHaveBeenCalledTimes(1)
    const start = deps.start as ReturnType<typeof vi.fn>
    expect(start.mock.calls[0][0]).toEqual({ provider: 'local', model: 'm' })
    expect(start.mock.calls[0][1]).toContain('hello world')
    expect(start.mock.calls[0][1]).toContain('Polish')
    expect(start.mock.calls[0][2]).toEqual([])
    expect(view.state.doc.textBetween).toHaveBeenCalledWith(3, 10, '\n', ' ')
    expect(state.handlers).not.toBeNull()
  })

  it('translate targets the current interface language', async () => {
    const { deps } = fakeDeps(fakeView())
    await rewriteSelection('translate', deps)
    const start = deps.start as ReturnType<typeof vi.fn>
    expect(start.mock.calls[0][1]).toContain('into Simplified Chinese')
  })

  it('replaces the selection with the completion on done', async () => {
    const view = fakeView()
    const { deps, state } = fakeDeps(view)
    await rewriteSelection('rewrite', deps)
    state.handlers!.onDone('polished output')
    expect(view.state.tr.insertText).toHaveBeenCalledWith('polished output', 3, 10)
    expect(view.dispatch).toHaveBeenCalledWith({ kind: 'tr', text: 'polished output' })
    expect(view.focus).toHaveBeenCalled()
  })

  it('reports completion errors through notifyError', async () => {
    const view = fakeView()
    const { deps, state } = fakeDeps(view)
    const notify = deps.notifyError as ReturnType<typeof vi.fn>
    await rewriteSelection('polish', deps)
    state.handlers!.onError('boom')
    expect(notify).toHaveBeenCalledWith('boom')
    expect(view.dispatch).not.toHaveBeenCalled()
  })
  it('applies the completion through the injected mode-aware accessor', async () => {
    // The real accessor routes to CodeMirror in source mode; this asserts the
    // result is applied via that seam rather than through a held view, which is
    // what made a source-mode rewrite land in the hidden model.
    const view = fakeView()
    const apply = vi.fn(() => true)
    const { deps, state } = fakeDeps(view)
    deps.applySelection = apply
    await rewriteSelection('rewrite', deps)
    state.handlers!.onDone('rewritten')
    // The captured selection rides along, so the real accessor can verify the
    // document still holds that text where it was before overwriting anything.
    expect(apply).toHaveBeenCalledWith('rewritten', { from: 3, to: 10, text: 'hello world' })
  })

  it('notifies when the selection can no longer be applied', async () => {
    const { deps, state } = fakeDeps(fakeView())
    deps.applySelection = () => false
    const notify = deps.notifyError as ReturnType<typeof vi.fn>
    await rewriteSelection('rewrite', deps)
    state.handlers!.onDone('rewritten')
    // A refusal at apply time means the document moved under the answer, which
    // reads differently from "you never selected anything".
    expect(notify).toHaveBeenCalledWith('ai.selectionMoved')
  })

  it('treats a whitespace-only selection as empty', async () => {
    const { deps } = fakeDeps(fakeView())
    deps.readSelection = () => ({ from: 0, to: 3, text: '   ' })
    const notify = deps.notifyError as ReturnType<typeof vi.fn>
    await rewriteSelection('polish', deps)
    expect(notify).toHaveBeenCalledWith('ai.noSelection')
    expect(deps.start).not.toHaveBeenCalled()
  })
})

describe('what happens between the request and the answer', () => {
  it('does not apply an empty answer, which used to delete the selection', async () => {
    // applySelection('') is a legal, "successful" replacement that removes the
    // text. A model returning an empty string (plain content: "" with
    // finish_reason stop, which the backend reports as a normal completion)
    // silently DELETED the user's paragraph.
    const { deps, state } = fakeDeps()
    const applied = vi.fn(() => true)
    deps.applySelection = applied
    const notifyError = deps.notifyError as ReturnType<typeof vi.fn>

    await rewriteSelection('polish', deps)
    state.handlers!.onDone('')

    expect(applied).not.toHaveBeenCalled()
    expect(notifyError).toHaveBeenCalledWith('ai.emptyAnswer')
  })

  it('treats a whitespace-only answer the same way', async () => {
    const { deps, state } = fakeDeps()
    const applied = vi.fn(() => true)
    deps.applySelection = applied
    await rewriteSelection('polish', deps)
    state.handlers!.onDone('   \n\n  ')
    expect(applied).not.toHaveBeenCalled()
  })
  it('passes the captured selection to the apply step', async () => {
    // The request takes seconds; the live selection at answer time may be a caret
    // somewhere else, or belong to another note entirely. The apply step must
    // receive what was SENT so it can verify the text is still there.
    const { deps, state } = fakeDeps()
    const applied = vi.fn(() => true)
    deps.applySelection = applied

    await rewriteSelection('polish', deps)
    state.handlers!.onDone('POLISHED')

    expect(applied).toHaveBeenCalledTimes(1)
    const call = applied.mock.calls[0] as unknown as [string, { from: number; to: number; text: string }]
    expect(call[1]).toEqual({ from: 3, to: 10, text: 'hello world' })
  })

  it('reports a moved selection instead of failing silently', async () => {
    const { deps, state } = fakeDeps()
    const applied = vi.fn(() => false)
    deps.applySelection = applied
    const notifyError = deps.notifyError as ReturnType<typeof vi.fn>

    await rewriteSelection('polish', deps)
    state.handlers!.onDone('POLISHED')

    expect(notifyError).toHaveBeenCalledWith('ai.selectionMoved')
  })
})